/**
 * RepoCloner — Shallow-clones Azure DevOps repos into temp directories
 * using the user's PAT for authentication.
 *
 * Each review gets its own isolated clone that is cleaned up after.
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

class RepoCloner {
  /**
   * @param {string} pat    - Azure DevOps PAT
   * @param {string} orgUrl - e.g. "https://dev.azure.com/myorg" or "https://myorg.visualstudio.com"
   */
  constructor(pat, orgUrl) {
    this.pat = pat;
    this.orgUrl = orgUrl.replace(/\/+$/, '');
  }

  /**
   * Clone a repo and check out the source branch.
   * Returns the path to the cloned directory.
   *
   * @param {object} pr - Normalised PR object
   * @returns {Promise<{ clonePath: string, cleanup: function }>}
   */
  async clone(pr) {
    const sourceBranch = pr.sourceBranch.replace('refs/heads/', '');
    const targetBranch = pr.targetBranch.replace('refs/heads/', '');

    // Build authenticated clone URL
    const cloneUrl = this._buildCloneUrl(pr);

    // Unique temp directory per review
    const clonePath = path.join(
      os.tmpdir(),
      `lgtm-review-${pr.project}-${pr.repo}-${pr.id}-${Date.now()}`,
    );

    console.log(`[LGTM] Cloning ${pr.project}/${pr.repo} into ${clonePath}`);
    console.log(`[LGTM]   Source: ${sourceBranch}  Target: ${targetBranch}`);

    // Shallow clone — fetch only the two branches we need
    // --depth 50 gives enough history for meaningful diffs
    // --no-single-branch ensures we can access both branches
    try {
      execSync(
        `git clone --depth 50 --branch "${sourceBranch}" "${cloneUrl}" "${clonePath}"`,
        {
          stdio: 'pipe',
          timeout: 120000, // 2 min timeout for large repos
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );

      // Fetch the target branch too so the agent can diff against it
      execSync(
        `git fetch origin "${targetBranch}:${targetBranch}" --depth 50`,
        {
          cwd: clonePath,
          stdio: 'pipe',
          timeout: 60000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );

      console.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      // Clean up on failure
      this._cleanup(clonePath);
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`Clone failed: ${stderr}`);
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
  async cloneRepo(project, repo, workItemId) {
    const cloneUrl = this._buildCloneUrlFromParts(project, repo);
    const clonePath = path.join(
      os.tmpdir(),
      `lgtm-wi-${project}-${repo}-${workItemId || 'adhoc'}-${Date.now()}`,
    );

    console.log(`[LGTM] Cloning default branch of ${project}/${repo} into ${clonePath}`);

    try {
      execSync(
        `git clone --depth 50 "${cloneUrl}" "${clonePath}"`,
        {
          stdio: 'pipe',
          timeout: 120000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
      console.log(`[LGTM] Clone complete: ${clonePath}`);
    } catch (err) {
      this._cleanup(clonePath);
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`Clone failed: ${stderr}`);
    }

    return { clonePath, cleanup: () => this._cleanup(clonePath) };
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
   * Remove a clone directory.
   */
  _cleanup(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        // Use rm -rf (works on macOS, Linux, and Windows with Git Bash)
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
