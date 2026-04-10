/**
 * ClaudeRunner — Spawns headless Claude Code processes for PR reviews.
 *
 * Each review runs as a background child process. Status updates are
 * emitted back to the renderer via IPC.
 */

const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

class ClaudeRunner {
  constructor(config) {
    this.config = config;
    this.activeReviews = new Map(); // prId → { process, status, output }
  }

  /**
   * Start a Claude Code review for the given PR.
   *
   * @param {object} pr         - Normalised PR object from DevOpsClient
   * @param {string} promptPath - Absolute path to NYLE_PR_PROMPT.md
   * @returns {{ success: boolean, error?: string }}
   */
  startReview(pr, promptPath) {
    const key = `${pr.project}/${pr.repo}/${pr.id}`;

    if (this.activeReviews.has(key)) {
      return { success: false, error: 'Review already in progress for this PR.' };
    }

    // Resolve prompt content
    let promptContent = '';
    try {
      // First check if there's a NYLE_PR_PROMPT.md in the repo (will be checked by Claude)
      // Fall back to the configured/bundled prompt
      if (fs.existsSync(promptPath)) {
        promptContent = `using the prompt in ${promptPath}`;
      } else {
        promptContent = 'using your best judgement for a thorough code review';
      }
    } catch {
      promptContent = 'using your best judgement for a thorough code review';
    }

    const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
    const prompt = [
      `Please PR review the branch "${sourceBranch}" related to PR #${pr.id} against ${pr.targetBranch.replace('refs/heads/', '')}`,
      `in the Azure DevOps repo "${pr.repo}" (project "${pr.project}").`,
      promptContent,
      `Post any comments directly into the corresponding PR in Azure DevOps.`,
      `The PR title is: "${pr.title}".`,
      `The PR URL is: ${pr.webUrl}`,
    ].join(' ');

    // Spawn Claude Code as a background process
    const child = spawn('claude', ['--print', '--prompt', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env },
    });

    const review = {
      pr,
      status: 'running',   // running | completed | failed
      output: '',
      startedAt: Date.now(),
    };

    child.stdout.on('data', (data) => {
      review.output += data.toString();
      this._notifyRenderer(key, review);
    });

    child.stderr.on('data', (data) => {
      review.output += data.toString();
    });

    child.on('close', (code) => {
      review.status = code === 0 ? 'completed' : 'failed';
      review.finishedAt = Date.now();
      this._notifyRenderer(key, review);

      // Keep in map for a while so UI can show the result, then clean up
      setTimeout(() => this.activeReviews.delete(key), 5 * 60 * 1000);
    });

    child.on('error', (err) => {
      review.status = 'failed';
      review.output += `\nError: ${err.message}`;
      this._notifyRenderer(key, review);
    });

    this.activeReviews.set(key, { process: child, ...review });
    this._notifyRenderer(key, review);

    return { success: true };
  }

  /**
   * Return a snapshot of all active/recent reviews.
   */
  getActiveReviews() {
    const result = {};
    for (const [key, review] of this.activeReviews) {
      result[key] = {
        status: review.status,
        pr: review.pr,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
        outputLength: (review.output || '').length,
      };
    }
    return result;
  }

  /**
   * Push a review-update event to the renderer.
   */
  _notifyRenderer(key, review) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('review-update', {
        key,
        status: review.status,
        pr: review.pr,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
      });
    }
  }
}

module.exports = { ClaudeRunner };
