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
const { AgentRegistry } = require('./agent-registry');
const { RepoCloner } = require('./repo-cloner');
const { PromptResolver } = require('./prompt-resolver');

class AgentRunner {
  constructor(config) {
    this.config = config;
    this.registry = new AgentRegistry();
    this.promptResolver = new PromptResolver(config);
    this.cloner = null; // initialised once we have a PAT
    this.activeReviews = new Map(); // key → review object
  }

  /**
   * Set/update the PAT and org URL (called after authentication).
   */
  setCredentials(pat, orgUrl) {
    this.cloner = new RepoCloner(pat, orgUrl);
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

      // ── Step 2: Resolve the prompt ─────────────────────────
      const { path: promptPath, source: promptSource } = this.promptResolver.resolve(pr, clonePath);

      let promptInstruction = '';
      if (promptPath) {
        // Read the prompt content and include it inline so the agent
        // has it regardless of whether it can access the file path
        try {
          const promptContent = fs.readFileSync(promptPath, 'utf8');
          promptInstruction = `\n\nUse the following review guidelines:\n\n${promptContent}`;
          review.promptSource = promptSource;
        } catch {
          promptInstruction = `\nReview prompt file found at ${promptPath} but could not be read. Use your best judgement.`;
        }
      } else {
        promptInstruction = '\nNo project-specific review prompt found. Use your best judgement for a thorough code review.';
        review.promptSource = 'none';
      }

      const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
      const targetBranch = pr.targetBranch.replace('refs/heads/', '');

      const prompt = [
        `You are reviewing PR #${pr.id} "${pr.title}" in the Azure DevOps repo "${pr.repo}" (project "${pr.project}").`,
        `The branch "${sourceBranch}" is being merged into "${targetBranch}".`,
        `You have the full codebase available in your working directory.`,
        `Run \`git diff ${targetBranch}...${sourceBranch}\` to see what changed.`,
        `Review the diff in the context of the full codebase.`,
        `Post your review comments directly into the PR in Azure DevOps.`,
        `The PR URL is: ${pr.webUrl}`,
        promptInstruction,
      ].join('\n');

      // ── Step 3: Spawn the agent ────────────────────────────
      review.status = 'running';
      this._notifyRenderer(key, review);

      const { command, args } = this.registry.buildCommand(agentId, prompt, model);

      console.log(`[LGTM] Launching ${agentId} in ${clonePath}`);
      console.log(`[LGTM]   Command: ${command} ${args.slice(0, 2).join(' ')} ...`);

      const child = spawn(command, args, {
        cwd: clonePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env },
      });

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
        review.status = code === 0 ? 'completed' : 'failed';
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
        console.log(`[LGTM] Review ${key} finished with code ${code}`);

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
