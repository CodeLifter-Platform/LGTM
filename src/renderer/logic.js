/**
 * LGTM — renderer logic that has no DOM in it.
 *
 * Loaded by index.html as a classic <script> before app.js, where it
 * attaches `window.LgtmLogic`; required directly by the Node test runner,
 * where it exports the same object. app.js owns the DOM and the mutable
 * state and calls in here for every decision a test should be able to pin:
 * escaping agent output, the PR-mode chip cycle, the auto-review queue,
 * and what counts as a finished review.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LgtmLogic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
  const ACTIVE_STATUSES = ['running', 'cloning'];

  /** A review that will never change status again. */
  function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
  }

  /** A review the main process is still working on. */
  function isActiveStatus(status) {
    return ACTIVE_STATUSES.includes(status);
  }

  /** Escape the three characters that turn text into markup. */
  function escHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * The tiny markdown subset agents emit, rendered on top of escHtml so a
   * `<script>` inside agent output stays text. The escape runs first; the
   * markdown pass only ever introduces the tags listed here.
   */
  function renderMarkdownToHtml(text) {
    let html = escHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  const prKey = (pr) => `${pr.project}/${pr.repo}/${pr.id}`;
  const repoKey = (pr) => `${pr.project}/${pr.repo}`;

  /**
   * Author-based default — used when the PR isn't approved AND the user
   * hasn't set an override. Author → resolve; everyone else → review.
   */
  function authorDefaultMode(pr, currentUser) {
    if (currentUser && pr.createdBy && pr.createdBy === currentUser.displayName) {
      return 'resolve';
    }
    return 'review';
  }

  function defaultPrMode(pr, currentUser) {
    if (pr.isApproved) return 'approved';
    return authorDefaultMode(pr, currentUser);
  }

  /** The mode chip shows: the user's override if any, else the default. */
  function resolvePrMode(pr, overrides, currentUser) {
    return (overrides && overrides[prKey(pr)]) || defaultPrMode(pr, currentUser);
  }

  /**
   * Click cycle, returned as a new overrides map:
   *   approved-PR (no override): approved → review → resolve → approved
   *   non-approved PR:           review ↔ resolve
   * Going back to "approved" clears the override so the default applies.
   */
  function cyclePrMode(pr, overrides, currentUser) {
    const key = prKey(pr);
    const next = { ...(overrides || {}) };
    const current = resolvePrMode(pr, next, currentUser);

    if (pr.isApproved) {
      if (current === 'approved') next[key] = 'review';
      else if (current === 'review') next[key] = 'resolve';
      else delete next[key];
    } else {
      next[key] = current === 'review' ? 'resolve' : 'review';
    }
    return next;
  }

  /**
   * The action the play button takes: 'approved' is informational, so it
   * falls back to the author-based default so the agent has work to do.
   */
  function actionModeFor(pr, overrides, currentUser) {
    const chip = resolvePrMode(pr, overrides, currentUser);
    return chip === 'approved' ? authorDefaultMode(pr, currentUser) : chip;
  }

  /** Whole days since the PR was created; 0 when the date is missing. */
  function prAgeDays(pr, now) {
    if (!pr.createdDate) return 0;
    const ms = (now || Date.now()) - new Date(pr.createdDate).getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  /** Starred repos first, then alphabetical. */
  function compareRepoKeys(a, b, starredRepos) {
    const aStarred = starredRepos.has(a) ? 0 : 1;
    const bStarred = starredRepos.has(b) ? 0 : 1;
    if (aStarred !== bStarred) return aStarred - bStarred;
    return a.localeCompare(b);
  }

  function sortRepoKeys(keys, starredRepos) {
    return [...keys].sort((a, b) => compareRepoKeys(a, b, starredRepos));
  }

  /**
   * What auto-review will run, in order: PRs no older than `maxPrAgeDays`
   * (undated PRs are kept), starred repos first, and nothing that is already
   * running, cloning or completed. Failed and cancelled runs are retried.
   */
  function buildAutoReviewQueue(prs, { starredRepos, maxPrAgeDays, reviewStatuses, now }) {
    const cutoffMs = maxPrAgeDays * 24 * 60 * 60 * 1000;
    const at = now || Date.now();
    const statuses = reviewStatuses || {};
    return [...(prs || [])]
      .filter((pr) => {
        if (!pr.createdDate) return true;
        return (at - new Date(pr.createdDate).getTime()) <= cutoffMs;
      })
      .filter((pr) => {
        const existing = statuses[prKey(pr)];
        return !(existing && (isActiveStatus(existing.status) || existing.status === 'completed'));
      })
      .sort((a, b) => compareRepoKeys(repoKey(a), repoKey(b), starredRepos));
  }

  return {
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    isTerminalStatus,
    isActiveStatus,
    escHtml,
    renderMarkdownToHtml,
    prKey,
    repoKey,
    authorDefaultMode,
    defaultPrMode,
    resolvePrMode,
    cyclePrMode,
    actionModeFor,
    prAgeDays,
    compareRepoKeys,
    sortRepoKeys,
    buildAutoReviewQueue,
  };
});
