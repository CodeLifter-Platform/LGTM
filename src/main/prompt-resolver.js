/**
 * PromptResolver — Resolves the repo-specific review prompt (Layer B) for a PR.
 *
 * This is the project-context prompt that gets appended AFTER the universal
 * LGTM review rules (Layer A, loaded by AgentRunner).
 *
 * Resolution order:
 *   1. Per-repo custom path (from settings.repoConfigs)
 *   2. Convention-based discovery in the cloned repo
 *   3. Global fallback (bundled REPO_REVIEW_TEMPLATE.md)
 *
 * Convention filenames searched in order:
 *   - .lgtm/review-prompt.md
 *   - .github/pr-review-prompt.md
 *   - PR_REVIEW_PROMPT.md
 *   - NYLE_PR_PROMPT.md  (legacy — kept for backwards compatibility)
 */

const path = require('path');
const fs = require('fs');

const CONVENTION_PATHS = [
  '.lgtm/review-prompt.md',
  '.github/pr-review-prompt.md',
  'PR_REVIEW_PROMPT.md',
  'NYLE_PR_PROMPT.md',
];

class PromptResolver {
  /**
   * @param {ElectronStore} config - App configuration store
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Resolve the prompt file path for a given PR.
   *
   * @param {object} pr        - Normalised PR object
   * @param {string} clonePath - Path to the cloned repo (or null if not cloned)
   * @returns {{ path: string, source: string }} - path to prompt file and how it was resolved
   */
  resolve(pr, clonePath) {
    const repoKey = `${pr.project}/${pr.repo}`;

    // ── 1. Per-repo custom config ──────────────────────────────
    const repoConfigs = this.config.get('repoConfigs') || {};
    const repoConfig = repoConfigs[repoKey];

    if (repoConfig) {
      if (repoConfig.mode === 'custom' && repoConfig.customPath) {
        if (fs.existsSync(repoConfig.customPath)) {
          console.log(`[LGTM] Prompt for ${repoKey}: custom path → ${repoConfig.customPath}`);
          return { path: repoConfig.customPath, source: 'custom' };
        }
        console.warn(`[LGTM] Custom prompt not found: ${repoConfig.customPath}, falling through`);
      }

      if (repoConfig.mode === 'repo' && repoConfig.repoFile && clonePath) {
        const fullPath = path.join(clonePath, repoConfig.repoFile);
        if (fs.existsSync(fullPath)) {
          console.log(`[LGTM] Prompt for ${repoKey}: repo file → ${repoConfig.repoFile}`);
          return { path: fullPath, source: 'repo-configured' };
        }
        console.warn(`[LGTM] Configured repo file not found: ${repoConfig.repoFile}, falling through`);
      }
    }

    // No custom config — fall through to convention scan, then bundled REPO_REVIEW_TEMPLATE.md

    // ── 2. Convention-based discovery in cloned repo ────────────
    if (clonePath) {
      for (const relPath of CONVENTION_PATHS) {
        const fullPath = path.join(clonePath, relPath);
        if (fs.existsSync(fullPath)) {
          console.log(`[LGTM] Prompt for ${repoKey}: discovered → ${relPath}`);
          return { path: fullPath, source: 'discovered' };
        }
      }
    }

    // ── 3. Global fallback ─────────────────────────────────────
    const globalCustom = this.config.get('promptPath');
    if (globalCustom && fs.existsSync(globalCustom)) {
      console.log(`[LGTM] Prompt for ${repoKey}: global custom → ${globalCustom}`);
      return { path: globalCustom, source: 'global-custom' };
    }

    // Bundled default (repo-specific template)
    const bundled = path.join(
      process.resourcesPath || path.join(__dirname, '..', '..', 'resources'),
      'REPO_REVIEW_TEMPLATE.md',
    );
    if (fs.existsSync(bundled)) {
      console.log(`[LGTM] Prompt for ${repoKey}: bundled default`);
      return { path: bundled, source: 'bundled' };
    }

    console.log(`[LGTM] Prompt for ${repoKey}: none found`);
    return { path: null, source: 'none' };
  }

  /**
   * Return the list of convention filenames we scan for.
   */
  static getConventionPaths() {
    return [...CONVENTION_PATHS];
  }
}

module.exports = { PromptResolver };
