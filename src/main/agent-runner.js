/**
 * AgentRunner — Launches PR reviews using any supported AI agent
 * in a new terminal tab.
 *
 * On macOS: opens a new tab in Terminal.app or iTerm2 (if running).
 * On Windows: opens a new tab in Windows Terminal, or falls back to cmd.
 * Status updates are emitted back to the renderer via IPC.
 */

const { spawn, exec } = require('child_process');
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AgentRegistry } = require('./agent-registry');

class AgentRunner {
  constructor(config) {
    this.config = config;
    this.registry = new AgentRegistry();
    this.activeReviews = new Map(); // key → { status, agentId, ... }
  }

  /**
   * Start a review for the given PR using the specified agent + model.
   *
   * @param {object} pr         - Normalised PR object from DevOpsClient
   * @param {string} promptPath - Absolute path to NYLE_PR_PROMPT.md
   * @param {string} agentId    - e.g. 'claude', 'codex', 'augment'
   * @param {string} model      - e.g. 'opus', 'o4-mini', etc. (optional)
   * @returns {{ success: boolean, error?: string }}
   */
  startReview(pr, promptPath, agentId, model) {
    const key = `${pr.project}/${pr.repo}/${pr.id}`;

    if (this.activeReviews.has(key) && this.activeReviews.get(key).status === 'running') {
      return { success: false, error: 'Review already in progress for this PR.' };
    }

    // Validate agent
    const agent = this.registry.get(agentId);
    if (!agent) {
      return { success: false, error: `Unknown agent: ${agentId}` };
    }
    if (!agent.available) {
      return { success: false, error: `${agent.name} is not installed. Install it and restart LGTM.` };
    }

    // Resolve prompt content
    let promptContent = '';
    try {
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

    // Build the agent command
    const { command, args } = this.registry.buildCommand(agentId, prompt, model);
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    // Build a flat shell command string for terminal tab execution
    const shellCmd = `${command} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

    // Marker file for completion detection
    const markerFile = path.join(os.tmpdir(), `lgtm-review-${pr.id}-${Date.now()}.done`);
    const wrapperCmd = `${shellCmd}; echo $? > '${markerFile}'`;

    try {
      if (process.platform === 'darwin') {
        this._openMacTab(wrapperCmd, pr, agent.name);
      } else if (process.platform === 'win32') {
        this._openWindowsTab(wrapperCmd, pr, agent.name);
      } else {
        this._spawnDirect(shellCmd, key, pr, agentId);
        return { success: true };
      }
    } catch (err) {
      return { success: false, error: `Failed to open terminal tab: ${err.message}` };
    }

    const review = {
      pr,
      agentId,
      model,
      status: 'running',
      startedAt: Date.now(),
      markerFile,
    };

    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);
    this._watchForCompletion(key, review);

    return { success: true };
  }

  // ── macOS: new tab in Terminal.app or iTerm2 ────────────────────

  _openMacTab(cmd, pr, agentName) {
    const tabTitle = `LGTM [${agentName}]: ${pr.repo}/#${pr.id}`;

    const iTermScript = `
      tell application "System Events"
        set isRunning to (name of processes) contains "iTerm2"
      end tell
      if isRunning then
        tell application "iTerm2"
          tell current window
            create tab with default profile
            tell current session
              set name to "${tabTitle}"
              write text "${cmd.replace(/"/g, '\\"')}"
            end tell
          end tell
        end tell
      else
        tell application "Terminal"
          activate
          tell application "System Events" to keystroke "t" using command down
          delay 0.3
          do script "${cmd.replace(/"/g, '\\"')}" in front window
        end tell
      end if
    `;

    exec(`osascript -e '${iTermScript.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) {
        exec(`open -a Terminal.app`);
        setTimeout(() => {
          exec(`osascript -e 'tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"'`);
        }, 500);
      }
    });
  }

  // ── Windows: new tab in Windows Terminal or fallback to cmd ─────

  _openWindowsTab(cmd, pr, agentName) {
    const wtCmd = `wt new-tab --title "LGTM [${agentName}]: ${pr.repo}/#${pr.id}" cmd /k ${cmd}`;

    exec(wtCmd, (err) => {
      if (err) {
        spawn('cmd', ['/c', 'start', 'cmd', '/k', cmd], {
          detached: true,
          stdio: 'ignore',
          shell: true,
        });
      }
    });
  }

  // ── Linux / fallback: direct child process ─────────────────────

  _spawnDirect(cmd, key, pr, agentId) {
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const review = {
      pr,
      agentId,
      status: 'running',
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
      setTimeout(() => this.activeReviews.delete(key), 5 * 60 * 1000);
    });

    child.on('error', (err) => {
      review.status = 'failed';
      review.output += `\nError: ${err.message}`;
      this._notifyRenderer(key, review);
    });

    this.activeReviews.set(key, review);
    this._notifyRenderer(key, review);
  }

  // ── Completion detection via marker file ────────────────────────

  _watchForCompletion(key, review) {
    const interval = setInterval(() => {
      try {
        if (fs.existsSync(review.markerFile)) {
          const exitCode = parseInt(fs.readFileSync(review.markerFile, 'utf8').trim(), 10);
          review.status = exitCode === 0 ? 'completed' : 'failed';
          review.finishedAt = Date.now();
          this._notifyRenderer(key, review);

          try { fs.unlinkSync(review.markerFile); } catch {}

          clearInterval(interval);
          setTimeout(() => this.activeReviews.delete(key), 5 * 60 * 1000);
        }
      } catch {
        // marker file not ready yet
      }
    }, 3000);

    // Safety: stop polling after 2 hours
    setTimeout(() => {
      clearInterval(interval);
      if (review.status === 'running') {
        review.status = 'failed';
        review.finishedAt = Date.now();
        this._notifyRenderer(key, review);
      }
    }, 2 * 60 * 60 * 1000);
  }

  /**
   * Return a snapshot of all active/recent reviews.
   */
  getActiveReviews() {
    const result = {};
    for (const [key, review] of this.activeReviews) {
      result[key] = {
        status: review.status,
        agentId: review.agentId,
        model: review.model || null,
        pr: review.pr,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
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
        agentId: review.agentId,
        pr: review.pr,
        startedAt: review.startedAt,
        finishedAt: review.finishedAt || null,
      });
    }
  }
}

module.exports = { AgentRunner };
