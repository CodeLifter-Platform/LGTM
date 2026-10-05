/**
 * RepoCloner — Partial-clones Azure DevOps repos into temp directories
 * using the user's PAT for authentication.
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

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLONE_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 60000;

class RepoCloner {
  /**
   * @param {string} pat    - Azure DevOps PAT
   * @param {string} orgUrl - e.g. "https://dev.azure.com/myorg" or "https://myorg.visualstudio.com"
   * @param {object} [opts]
   * @param {(project: string, repo: string) => string} [opts.cloneUrlFor] - override the clone URL
   *   (tests point it at a local bare repo; the PAT-bearing URL is the default)
   * @param {string} [opts.tmpDir]           - where clones land (default os.tmpdir())
   * @param {number} [opts.cloneTimeoutMs]
   * @param {number} [opts.fetchTimeoutMs]
   * @param {(line: string) => void} [opts.log]
   */
  constructor(pat, orgUrl, { cloneUrlFor, tmpDir, cloneTimeoutMs, fetchTimeoutMs, log } = {}) {
    this.pat = pat;
    this.orgUrl = orgUrl.replace(/\/+$/, '');
    this._cloneUrlFor = cloneUrlFor || null;
    this.tmpDir = tmpDir || os.tmpdir();
    this.cloneTimeoutMs = cloneTimeoutMs || CLONE_TIMEOUT_MS;
    this.fetchTimeoutMs = fetchTimeoutMs || FETCH_TIMEOUT_MS;
    this.log = log || console.log;
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
      this.tmpDir,
      `lgtm-review-${pr.project}-${pr.repo}-${pr.id}-${Date.now()}`,
    );

    this.log(`[LGTM] Cloning ${pr.project}/${pr.repo} into ${clonePath}`);
    this.log(`[LGTM]   Source: ${sourceBranch}  Target: ${targetBranch}`);

    try {
      await this._runGit(
        ['clone', '--filter=blob:none', '--no-checkout', '--branch', sourceBranch, cloneUrl, clonePath],
        { timeout: this.cloneTimeoutMs, onChild: opts.onChild },
      );

      // Materialize the source branch working tree.
      await this._runGit(
        ['checkout', sourceBranch],
        { cwd: clonePath, timeout: this.cloneTimeoutMs, onChild: opts.onChild },
      );

      // Fetch the target branch too so the agent can diff against it.
      await this._runGit(
        ['fetch', 'origin', `${targetBranch}:${targetBranch}`],
        { cwd: clonePath, timeout: this.fetchTimeoutMs, onChild: opts.onChild },
      );

      this.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      this._cleanup(clonePath);
      throw new Error(`Clone failed: ${this._redact(err.message)}`);
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
      this.tmpDir,
      `lgtm-wi-${project}-${repo}-${workItemId || 'adhoc'}-${Date.now()}`,
    );

    this.log(`[LGTM] Cloning default branch of ${project}/${repo} into ${clonePath}`);

    try {
      await this._runGit(
        ['clone', '--filter=blob:none', '--no-checkout', cloneUrl, clonePath],
        { timeout: this.cloneTimeoutMs, onChild: opts.onChild },
      );
      await this._runGit(
        ['checkout', 'HEAD'],
        { cwd: clonePath, timeout: this.cloneTimeoutMs, onChild: opts.onChild },
      );
      this.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      this._cleanup(clonePath);
      throw new Error(`Clone failed: ${this._redact(err.message)}`);
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
   * Build a git clone URL with embedded PAT authentication.
   *
   * For dev.azure.com:
   *   https://<pat>@dev.azure.com/<org>/<project>/_git/<repo>
   *
   * For visualstudio.com:
   *   https://<pat>@<org>.visualstudio.com/<project>/_git/<repo>
   */
  _buildCloneUrl(pr) {
    return this._buildCloneUrlFromParts(pr.project, pr.repo);
  }

  _buildCloneUrlFromParts(project, repo) {
    if (this._cloneUrlFor) return this._cloneUrlFor(project, repo);
    try {
      const u = new URL(this.orgUrl);
      u.username = 'pat';
      u.password = this.pat;
      const repoPath = `/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
      return `${u.origin}${u.pathname}${repoPath}`.replace(
        u.origin,
        `${u.protocol}//pat:${this.pat}@${u.host}`,
      );
    } catch {
      const base = this.orgUrl.replace('https://', `https://pat:${this.pat}@`);
      return `${base}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
    }
  }

  /**
   * The PAT must never reach a log line or an error shown to the user. git
   * anonymises the URL in most of its messages, but not all; this is the
   * belt to that brace.
   */
  _redact(text) {
    if (!this.pat || !text) return text || '';
    return String(text).split(this.pat).join('***');
  }

  /**
   * Remove a clone directory. Cleanup runs synchronously because it happens
   * after the agent run is done — the main process is no longer in the hot
   * path here. `fs.rmSync` takes the path as data, so a project or repo
   * name with quotes or shell characters cannot escape into a shell.
   */
  _cleanup(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 });
        this.log(`[LGTM] Cleaned up clone: ${dirPath}`);
      }
    } catch (err) {
      this.log(`[LGTM] Failed to clean up ${dirPath}: ${err.message}`);
    }
  }
}

module.exports = { RepoCloner };
