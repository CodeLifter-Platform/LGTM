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
  async startReview(pr, agentId, model, mode = 'review') {
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
      mode,
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

      let promptParts;
      if (mode === 'resolve') {
        promptParts = [
          `You are addressing review comments on PR #${pr.id} "${pr.title}" in the Azure DevOps repo "${pr.repo}" (project "${pr.project}").`,
          `The PR's source branch "${sourceBranch}" is checked out as your working directory; it is being merged into "${targetBranch}".`,
          `Run \`git diff ${targetBranch}...${sourceBranch}\` to see the PR's changes.`,
          `Your job is to make code changes that resolve the valuable existing review threads, then push them back so reviewers see the updates.`,
          ``,
          `## Workflow`,
          `1. Read the existing review threads (listed below).`,
          `2. For each thread, decide if it warrants a code change. SKIP threads that are already Fixed/Closed/ByDesign, or that are subjective preferences without strong reasoning.`,
          `3. For threads that warrant action: investigate the relevant code, make the change, and commit with a descriptive message like "Address review: <summary>".`,
          `4. Before pushing, run: git pull --rebase origin "${sourceBranch}"  (in case the branch advanced).`,
          `5. Push: git push origin "${sourceBranch}".  The PAT is embedded in the remote URL so no auth prompt is needed.`,
          `6. Optionally post a brief reply to each addressed thread saying what you did.`,
          ``,
          `If there are no valuable threads to address, exit without making any commits or pushing — just report that there is nothing actionable.`,
          ``,
          `PR URL: ${pr.webUrl}`,
        ];
        if (universalPrompt) {
          promptParts.push('\n--- LGTM RULES (for context — these inform what counts as "valuable") ---\n');
          promptParts.push(universalPrompt);
        }
        if (repoPrompt) {
          promptParts.push('\n--- PROJECT-SPECIFIC RULES ---\n');
          promptParts.push(repoPrompt);
        }
        if (existingThreadsSummary) {
          promptParts.push(existingThreadsSummary);
        } else {
          promptParts.push('\n## Existing Review Threads\n\n(No review threads found. There is nothing to resolve — exit without making changes.)');
        }
      } else {
        promptParts = [
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
   * Start an agent action on a work item (bug or ticket). Unlike PRs, the
   * caller chooses which repo to clone. The agent gets the work item's
   * title, description, and repro steps as context.
   *
   * @param {object} workItem - { id, title, type, project, webUrl }
   * @param {object} repoInfo - { project, repo } (the repo to clone)
   * @param {string} agentId
   * @param {string} model
   */
  async startWorkItemAction(workItem, repoInfo, agentId, model, options = {}) {
    const key = `${repoInfo.project}/${repoInfo.repo}/wi-${workItem.id}`;

    if (this.activeReviews.has(key) && this.activeReviews.get(key).status === 'running') {
      return { success: false, error: 'Agent already running for this work item.' };
    }

    const agent = this.registry.get(agentId);
    if (!agent) return { success: false, error: `Unknown agent: ${agentId}` };
    if (!agent.available) return { success: false, error: `${agent.name} is not installed.` };

    const review = {
      workItem,
      repoInfo,
      agentId,
      model,
      status: 'cloning',
      output: '',
      startedAt: Date.now(),
      cleanup: null,
      child: null,
      cancelled: false,
      // Shape a minimal pr-like object so the detail panel can render it.
      pr: {
        id: workItem.id,
        title: workItem.title,
        project: repoInfo.project,
        repo: repoInfo.repo,
        webUrl: workItem.webUrl,
        createdBy: '',
        createdDate: '',
      },
    };
    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);

    try {
      if (!this.cloner) {
        throw new Error('Not authenticated — no PAT available for cloning.');
      }

      const { clonePath, cleanup } = await this.cloner.cloneRepo(
        repoInfo.project,
        repoInfo.repo,
        workItem.id,
      );
      review.cleanup = cleanup;
      review.clonePath = clonePath;

      if (review.cancelled) {
        review.status = 'cancelled';
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        if (review.cleanup) review.cleanup();
        return { success: true, cancelled: true };
      }

      // Fetch full work item details (description, repro steps, etc.)
      let details = workItem;
      try {
        if (this.devopsClient) {
          details = await this.devopsClient.getWorkItemDetails(workItem.id);
        }
      } catch (err) {
        console.warn(`[LGTM] Could not fetch work item details: ${err.message}`);
      }

      let prompt = this._buildWorkItemPrompt(details, repoInfo);

      // Append repo-specific prompt file if configured.
      if (options.promptFile) {
        const repoPromptPath = path.join(clonePath, options.promptFile);
        try {
          const repoPrompt = fs.readFileSync(repoPromptPath, 'utf8');
          prompt += `\n\n--- REPO PROMPT (${options.promptFile}) ---\n\n${repoPrompt}`;
          review.promptSource = `repo:${options.promptFile}`;
          console.log(`[LGTM] Appended repo prompt from ${options.promptFile}`);
        } catch (err) {
          console.warn(`[LGTM] Could not read repo prompt at ${options.promptFile}: ${err.message}`);
        }
      }

      review.status = 'running';
      this._notifyRenderer(key, review);

      const { command, args, stdinPrompt } = this.registry.buildCommand(agentId, prompt, model);

      console.log(`[LGTM] Launching ${agentId} in ${clonePath} for work item #${workItem.id}`);
      console.log(`[LGTM]   Command: ${command} ${args.join(' ')}`);

      const promptFile = path.join(os.tmpdir(), `lgtm-wi-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');

      const child = spawn(command, args, {
        cwd: clonePath,
        stdio: [stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env },
      });
      review.child = child;

      if (stdinPrompt && child.stdin) {
        const promptStream = fs.createReadStream(promptFile);
        promptStream.pipe(child.stdin);
        promptStream.on('end', () => {
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        });
      } else {
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      }

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
        console.log(`[LGTM] Work item action ${key} finished with code ${code}${review.cancelled ? ' (cancelled)' : ''}`);

        if (review.cleanup) {
          setTimeout(() => review.cleanup(), 5000);
        }
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

  _buildWorkItemPrompt(details, repoInfo) {
    const stripHtml = (html) => (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const parts = [
      `You are working on ${details.type || 'work item'} #${details.id} "${details.title}" from Azure DevOps project "${details.project || repoInfo.project}".`,
      `The repo "${repoInfo.repo}" has been cloned as your working directory on its default branch.`,
      `Investigate the codebase, plan a fix or implementation, and make the necessary changes.`,
      '',
      `## Work Item`,
      `- ID: ${details.id}`,
      `- Type: ${details.type || ''}`,
      `- Title: ${details.title || ''}`,
      `- State: ${details.state || ''}`,
    ];
    if (details.priority != null) parts.push(`- Priority: ${details.priority}`);
    if (details.severity) parts.push(`- Severity: ${details.severity}`);
    if (details.tags) parts.push(`- Tags: ${details.tags}`);

    const desc = stripHtml(details.description);
    if (desc) parts.push('', '## Description', desc);

    const repro = stripHtml(details.reproSteps);
    if (repro) parts.push('', '## Repro Steps', repro);

    const sysInfo = stripHtml(details.systemInfo);
    if (sysInfo) parts.push('', '## System Info', sysInfo);

    const ac = stripHtml(details.acceptanceCriteria);
    if (ac) parts.push('', '## Acceptance Criteria', ac);

    parts.push('', '---', '',
      `When you\'re done, create a new branch, commit your changes, and summarize what you did.`,
      `Do NOT push or open a PR — leave that to the user to review locally.`);

    return parts.join('\n');
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
