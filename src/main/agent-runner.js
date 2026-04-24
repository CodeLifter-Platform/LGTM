/**
 * AgentRunner — Launches PR reviews using any supported AI agent.
 *
 * Flow:
 *   1. Shallow-clone the repo into a temp directory
 *   2. Resolve the review prompt (per-repo → convention → global)
 *   3. Spawn the agent as a child process with piped stdout/stderr
 *   4. Stream output to the renderer in real time via IPC
 *   5. Clean up the temp clone when done
 */

const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentRegistry } = require('./agent-registry');
const { RepoCloner } = require('./repo-cloner');
const { PromptResolver } = require('./prompt-resolver');
const { DevOpsClient } = require('./devops-client');

class AgentRunner {
  constructor(config) {
    this.config = config;
    this.registry = new AgentRegistry();
    this.promptResolver = new PromptResolver(config);
    this.cloner = null;       // initialised once we have a PAT
    this.devopsClient = null;  // for fetching existing threads
    this.activeReviews = new Map(); // key → review object
  }

  /**
   * Set/update the PAT and org URL (called after authentication).
   */
  setCredentials(pat, orgUrl) {
    this.cloner = new RepoCloner(pat, orgUrl);
    this.devopsClient = new DevOpsClient(pat, orgUrl);
  }

  /**
   * Start a review for the given PR.
   *
   * @param {object} pr      - Normalised PR object from DevOpsClient
   * @param {string} agentId - e.g. 'claude', 'codex', 'augment'
   * @param {string} model   - e.g. 'claude-opus-4-6' (optional)
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async startReview(pr, agentId, model) {
    const key = `${pr.project}/${pr.repo}/${pr.id}`;

    if (this.activeReviews.has(key) && this.activeReviews.get(key).status === 'running') {
      return { success: false, error: 'Review already in progress for this PR.' };
    }

    // Validate agent
    const agent = this.registry.get(agentId);
    if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
    if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };

    // Create review record immediately so UI shows "cloning" state
    const review = {
      pr,
      agentId,
      model,
      status: 'cloning',
      output: '',
      startedAt: Date.now(),
      cleanup: null,
      child: null,
      cancelled: false,
    };
    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);

    try {
      // ── Step 1: Clone the repo ─────────────────────────────
      if (!this.cloner) {
        throw new Error('Not authenticated — no PAT available for cloning.');
      }

      const { clonePath, cleanup } = await this.cloner.clone(pr);
      review.cleanup = cleanup;
      review.clonePath = clonePath;

      // If cancelled while cloning, abort before spawning the agent.
      if (review.cancelled) {
        review.status = 'cancelled';
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
        return { success: true, cancelled: true };
      }

      // ── Step 2: Build the review prompt ───────────────────────

      // Layer A: LGTM universal review prompt (severity system, comment format, re-review rules)
      const universalPromptPath = path.join(__dirname, '..', '..', 'resources', 'LGTM_REVIEW_PROMPT.md');
      let universalPrompt = '';
      try {
        universalPrompt = fs.readFileSync(universalPromptPath, 'utf8');
      } catch {
        // Fallback: try the extraResources path (in packaged app)
        try {
          const packagedPath = path.join(process.resourcesPath, 'LGTM_REVIEW_PROMPT.md');
          universalPrompt = fs.readFileSync(packagedPath, 'utf8');
        } catch {
          console.warn('[LGTM] Could not load LGTM_REVIEW_PROMPT.md — using minimal fallback');
          universalPrompt = '';
        }
      }

      // Layer B: Repo-specific prompt (project context, custom rules)
      const { path: repoPromptPath, source: promptSource } = this.promptResolver.resolve(pr, clonePath);
      let repoPrompt = '';
      review.promptSource = promptSource;

      if (repoPromptPath) {
        try {
          repoPrompt = fs.readFileSync(repoPromptPath, 'utf8');
        } catch {
          console.warn(`[LGTM] Could not read repo prompt at ${repoPromptPath}`);
        }
      }

      // Fetch existing PR threads for re-review awareness
      let existingThreadsSummary = '';
      try {
        const threads = await this.devopsClient.getPrThreads(pr.project, pr.repoId, pr.id);
        const reviewThreads = threads.filter((t) =>
          t.comments.length > 0 && t.comments[0].commentType === 1
        );

        if (reviewThreads.length > 0) {
          const threadLines = reviewThreads.map((t) => {
            const statusMap = { 1: 'Active', 2: 'Fixed', 3: 'WontFix', 4: 'Closed', 5: 'ByDesign', 6: 'Pending' };
            const status = statusMap[t.status] || `Unknown(${t.status})`;
            const firstComment = t.comments[0].content.substring(0, 200);
            return `- Thread #${t.id} [${status}]: ${firstComment}${t.comments[0].content.length > 200 ? '…' : ''}`;
          });
          existingThreadsSummary = [
            '\n## Existing Review Threads',
            '',
            'The following review comments already exist on this PR. Follow the re-review rules strictly:',
            '',
            ...threadLines,
          ].join('\n');
        }
      } catch (err) {
        console.warn(`[LGTM] Could not fetch existing threads: ${err.message}`);
      }

      const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
      const targetBranch = pr.targetBranch.replace('refs/heads/', '');

      const promptParts = [
        `You are reviewing PR #${pr.id} "${pr.title}" in the Azure DevOps repo "${pr.repo}" (project "${pr.project}").`,
        `The branch "${sourceBranch}" is being merged into "${targetBranch}".`,
        `You have the full codebase available in your working directory.`,
        `Run \`git diff ${targetBranch}...${sourceBranch}\` to see what changed.`,
        `Review the diff in the context of the full codebase.`,
        `Post your review comments directly as threads in the Azure DevOps PR.`,
        `The PR URL is: ${pr.webUrl}`,
      ];

      if (universalPrompt) {
        promptParts.push('\n--- LGTM REVIEW RULES ---\n');
        promptParts.push(universalPrompt);
      }

      if (repoPrompt) {
        promptParts.push('\n--- PROJECT-SPECIFIC RULES ---\n');
        promptParts.push(repoPrompt);
      }

      if (existingThreadsSummary) {
        promptParts.push(existingThreadsSummary);
      }

      const prompt = promptParts.join('\n');

      // ── Step 3: Spawn the agent ────────────────────────────
      review.status = 'running';
      this._notifyRenderer(key, review);

      const { command, args, stdinPrompt } = this.registry.buildCommand(agentId, prompt, model);

      console.log(`[LGTM] Launching ${agentId} in ${clonePath}`);
      console.log(`[LGTM]   Command: ${command} ${args.join(' ')}`);
      console.log(`[LGTM]   Prompt length: ${prompt.length} chars, stdin: ${!!stdinPrompt}`);

      // Write prompt to a temp file so we can pipe it via stdin.
      // This avoids shell escaping issues with large prompts containing
      // special characters (pipes, backticks, quotes, etc.)
      const promptFile = path.join(os.tmpdir(), `lgtm-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');

      const child = spawn(command, args, {
        cwd: clonePath,
        stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env },
      });
      review.child = child;

      // Pipe the prompt via stdin then close it
      if (stdinPrompt && child.stdin) {
        const promptStream = fs.createReadStream(promptFile);
        promptStream.pipe(child.stdin);
        promptStream.on('end', () => {
          // Clean up temp file after it's been read
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        });
      } else {
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      }

      // ── Step 4: Stream output ──────────────────────────────
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        review.output += chunk;
        this._notifyRendererChunk(key, chunk, review);
      });

      child.on('close', (code) => {
        if (review.cancelled) {
          review.status = 'cancelled';
        } else {
          review.status = code === 0 ? 'completed' : 'failed';
        }
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        console.log(`[LGTM] Review ${key} finished with code ${code}${review.cancelled ? ' (cancelled)' : ''}`);

        // ── Step 5: Cleanup ────────────────────────────────
        if (review.cleanup) {
          setTimeout(() => review.cleanup(), 5000); // brief delay so agent can finish writing
        }

        // Keep in map for UI display, then purge
        setTimeout(() => this.activeReviews.delete(key), 10 * 60 * 1000);
      });

      child.on('error', (err) => {
        review.status = 'failed';
        review.output += `\nProcess error: ${err.message}`;
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
      });

      return { success: true };

    } catch (err) {
      review.status = 'failed';
      review.output += `\nError: ${err.message}`;
      review.finishedAt = Date.now();
      this._notifyRenderer(key, review);
      if (review.cleanup) review.cleanup();
      return { success: false, error: err.message };
    }
  }

  /**
   * Cancel an in-progress review. If the agent child process is running,
   * it is sent SIGTERM, then SIGKILL if it doesn't exit within 2s. If the
   * review is still cloning, the cancel flag aborts the spawn.
   */
  cancelReview(key) {
    const review = this.activeReviews.get(key);
    if (!review) return { success: false, error: 'Review not found.' };
    if (review.status !== 'running' && review.status !== 'cloning') {
      return { success: false, error: `Cannot cancel review in status "${review.status}".` };
    }

    review.cancelled = true;
    review.output += '\n[LGTM] Review cancelled by user.\n';

    const child = review.child;
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
    }

    // If still cloning, proactively mark cancelled so the UI updates now.
    // The cloning branch in startReview will bail out and trigger cleanup
    // once the clone finishes.
    if (review.status === 'cloning') {
      this._notifyRenderer(key, review);
    }

    return { success: true };
  }

  /**
   * Return a snapshot of all active/recent reviews (serializable).
   */
  getActiveReviews() {
    const result = {};
    for (const [key, review] of this.activeReviews) {
      result[key] = {
        status: review.status,
        agentId: review.agentId,
        model: review.model || null,
        pr: review.pr,
        promptSource: review.promptSource || null,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
        outputLength: (review.output || '').length,
      };
    }
    return result;
  }

  /**
   * Get the full output for a specific review.
   */
  getReviewOutput(key) {
    const review = this.activeReviews.get(key);
    return review ? review.output : '';
  }

  /**
   * Push a status update to the renderer.
   */
  _notifyRenderer(key, review) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('review-update', {
        key,
        status: review.status,
        agentId: review.agentId,
        pr: review.pr,
        promptSource: review.promptSource || null,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
      });
    }
  }

  /**
   * Push a streaming output chunk to the renderer.
   */
  _notifyRendererChunk(key, chunk, review) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('review-output', {
        key,
        chunk,
        status: review.status,
      });
    }
  }
}

module.exports = { AgentRunner };
