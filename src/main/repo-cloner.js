/**
 * RepoCloner — Partial-clones repositories from a connected git service
 * into temp directories, authenticating with that service's token.
 *
 * Every clone uses `--filter=blob:none --no-checkout` so blobs are fetched
 * on demand and the working tree is materialized only for the branch the
 * agent will operate on. No shallow-clone fallback — full history is
 * always available.
 *
 * All git work runs in spawned child processes (never execSync) so the
 * Electron main process stays responsive while a clone is in flight.
 * Callers can pass an `onChild` hook to receive each running git child
 * process and kill it on cancel.
 *
 * Each review gets its own isolated clone that is cleaned up after.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLONE_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 60000;

// Temp-dir names must not carry path separators or shell-hostile characters.
function safeName(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

class RepoCloner {
  /**
   * @param {{ cloneUrl: function(project: string, repo: string): string, token?: string }} connection
   *   Anything with a `cloneUrl(project, repo)` that returns an HTTPS URL with
   *   the credential embedded (`providers.Connection` does). `token` is kept
   *   only so callers that hand the agent its credentials can read it.
   */
  constructor(connection) {
    if (!connection || typeof connection.cloneUrl !== 'function') {
      throw new Error('RepoCloner needs a connection with cloneUrl(project, repo)');
    }
    this.connection = connection;
    this.pat = connection.token || null;
  }

  /**
   * Clone a repo and check out the source branch.
   * Returns the path to the cloned directory.
   *
   * @param {object} pr                    - Normalised PR object
   * @param {object}   [opts]
   * @param {function} [opts.onChild]      - Called with each spawned git child so the caller can kill it on cancel
   * @returns {Promise<{ clonePath: string, cleanup: function }>}
   */
  async clone(pr, opts = {}) {
    const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
    const targetBranch = pr.targetBranch.replace('refs/heads/', '');

    const cloneUrl = this._buildCloneUrl(pr);
    const clonePath = path.join(
      os.tmpdir(),
      `lgtm-review-${safeName(pr.project)}-${safeName(pr.repo)}-${pr.id}-${Date.now()}`,
    );

    console.log(`[LGTM] Cloning ${pr.project}/${pr.repo} into ${clonePath}`);
    console.log(`[LGTM]   Source: ${sourceBranch}  Target: ${targetBranch}`);

    try {
      if (pr.isFork && pr.headRepo) {
        // The head lives in a fork (GitHub). Clone the base repo on the
        // target branch, then fetch the fork's branch under the same local
        // name so the rest of the flow is identical.
        const [forkOwner, forkRepo] = String(pr.headRepo).split('/');
        const forkUrl = this.connection.cloneUrl(forkOwner, forkRepo);
        await this._runGit(
          ['clone', '--filter=blob:none', '--no-checkout', '--branch', targetBranch, cloneUrl, clonePath],
          { timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
        );
        await this._runGit(
          ['fetch', forkUrl, `${sourceBranch}:${sourceBranch}`],
          { cwd: clonePath, timeout: FETCH_TIMEOUT_MS, onChild: opts.onChild },
        );
        await this._runGit(
          ['checkout', sourceBranch],
          { cwd: clonePath, timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
        );
      } else {
        await this._runGit(
          ['clone', '--filter=blob:none', '--no-checkout', '--branch', sourceBranch, cloneUrl, clonePath],
          { timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
        );

        // Materialize the source branch working tree.
        await this._runGit(
          ['checkout', sourceBranch],
          { cwd: clonePath, timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
        );

        // Fetch the target branch too so the agent can diff against it.
        await this._runGit(
          ['fetch', 'origin', `${targetBranch}:${targetBranch}`],
          { cwd: clonePath, timeout: FETCH_TIMEOUT_MS, onChild: opts.onChild },
        );
      }

      console.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      this._cleanup(clonePath);
      throw new Error(`Clone failed: ${err.message}`);
    }

    return {
      clonePath,
      cleanup: () => this._cleanup(clonePath),
    };
  }

  /**
   * Clone a repo's default branch into a temp dir. Used when an agent is
   * kicked off against a work item (bug/ticket) rather than a PR.
   */
  async cloneRepo(project, repo, workItemId, opts = {}) {
    const cloneUrl = this._buildCloneUrlFromParts(project, repo);
    const clonePath = path.join(
      os.tmpdir(),
      `lgtm-wi-${safeName(project)}-${safeName(repo)}-${workItemId || 'adhoc'}-${Date.now()}`,
    );

    console.log(`[LGTM] Cloning default branch of ${project}/${repo} into ${clonePath}`);

    try {
      await this._runGit(
        ['clone', '--filter=blob:none', '--no-checkout', cloneUrl, clonePath],
        { timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
      );
      await this._runGit(
        ['checkout', 'HEAD'],
        { cwd: clonePath, timeout: CLONE_TIMEOUT_MS, onChild: opts.onChild },
      );
      console.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      this._cleanup(clonePath);
      throw new Error(`Clone failed: ${err.message}`);
    }

    return { clonePath, cleanup: () => this._cleanup(clonePath) };
  }

  /**
   * Spawn a git invocation and resolve when it exits 0. Rejects on non-zero
   * exit, on `error` events, or on timeout. The raw child is exposed via
   * `opts.onChild` so a caller can SIGTERM it during cancellation.
   */
  _runGit(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      if (typeof opts.onChild === 'function') {
        try { opts.onChild(child); } catch { /* ignore subscriber errors */ }
      }

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      // We don't need stdout, but draining it prevents the buffer from filling.
      child.stdout.on('data', () => {});

      let timer = null;
      let timedOut = false;
      if (opts.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, opts.timeout);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (code === 0) return resolve();
        if (timedOut) return reject(new Error(`git ${args[0]} timed out after ${opts.timeout}ms`));
        if (signal) return reject(new Error(`git ${args[0]} killed by ${signal}`));
        reject(new Error(`git ${args[0]} exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
      });
    });
  }

  /**
   * The authenticated clone URL comes from the connection, which knows the
   * service's URL shape (`…/_git/<repo>` for Azure DevOps, `…/<owner>/<repo>.git`
   * for GitHub) and how to embed its credential.
   */
  _buildCloneUrl(pr) {
    return this._buildCloneUrlFromParts(pr.project, pr.repo);
  }

  _buildCloneUrlFromParts(project, repo) {
    return this.connection.cloneUrl(project, repo);
  }

  /**
   * Remove a clone directory. Cleanup runs synchronously because it happens
   * after the agent run is done — the main process is no longer in the hot
   * path here.
   */
  _cleanup(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        if (process.platform === 'win32') {
          execSync(`rmdir /s /q "${dirPath}"`, { stdio: 'ignore' });
        } else {
          execSync(`rm -rf "${dirPath}"`, { stdio: 'ignore' });
        }
        console.log(`[LGTM] Cleaned up clone: ${dirPath}`);
      }
    } catch (err) {
      console.warn(`[LGTM] Failed to clean up ${dirPath}:`, err.message);
    }
  }
}

module.exports = { RepoCloner };
