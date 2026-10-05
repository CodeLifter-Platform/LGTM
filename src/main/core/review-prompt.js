/**
 * The pure pieces of the scenario review prompt that AgentRunner
 * assembles: the reviewer/author identity line, the existing-thread
 * summary, and the work-item details block. No I/O.
 */

const { htmlToText } = require('./html-text');
const { applySubstitutions } = require('../prompt-attachments');

const THREAD_STATUS = { 1: 'Active', 2: 'Fixed', 3: 'WontFix', 4: 'Closed', 5: 'ByDesign', 6: 'Pending' };
const THREAD_PREVIEW_CHARS = 200;

/** "Display Name (id)" for the identity injected into a dispatched prompt. */
function formatIdentity(user) {
  if (!user) return '';
  const name = user.displayName || user.email || '';
  const id = user.id || '';
  if (name && id) return `${name} (${id})`;
  return name || id || '';
}

/**
 * Keep only threads a human reviewer started (first comment is a Text
 * comment, commentType 1); system threads (votes, ref updates) are noise.
 */
function selectReviewThreads(threads) {
  return (threads || []).filter((t) =>
    t.comments && t.comments.length > 0 && t.comments[0].commentType === 1,
  );
}

/**
 * One line per thread: id, status, and the first comment truncated to
 * 200 characters so a long essay cannot crowd the prompt.
 */
function summarizeThreads(reviewThreads) {
  return reviewThreads.map((t) => {
    const status = THREAD_STATUS[t.status] || `Unknown(${t.status})`;
    const content = t.comments[0].content || '';
    const firstComment = content.substring(0, THREAD_PREVIEW_CHARS);
    return `- Thread #${t.id} [${status}]: ${firstComment}${content.length > THREAD_PREVIEW_CHARS ? '…' : ''}`;
  }).join('\n');
}

/**
 * Plain-text block describing a work item for the implement-ticket
 * scenario. `imageSubs` swaps downloaded <img> tags for local markers
 * before the HTML is stripped.
 */
function renderWorkItemDetails(details, repoInfo, imageSubs = null) {
  const subbed = (html) => (imageSubs ? applySubstitutions(html || '', imageSubs) : (html || ''));
  const strip = (html) => htmlToText(subbed(html));

  const parts = [
    `Project: ${details.project || repoInfo.project}`,
    `Repo: ${repoInfo.repo}`,
    `ID: ${details.id}`,
    `Type: ${details.type || ''}`,
    `Title: ${details.title || ''}`,
    `State: ${details.state || ''}`,
  ];
  if (details.priority != null) parts.push(`Priority: ${details.priority}`);
  if (details.severity) parts.push(`Severity: ${details.severity}`);
  if (details.tags) parts.push(`Tags: ${details.tags}`);

  const desc = strip(details.description);
  if (desc) parts.push('', '### Description', desc);
  const repro = strip(details.reproSteps);
  if (repro) parts.push('', '### Repro Steps', repro);
  const sysInfo = strip(details.systemInfo);
  if (sysInfo) parts.push('', '### System Info', sysInfo);
  const ac = strip(details.acceptanceCriteria);
  if (ac) parts.push('', '### Acceptance Criteria', ac);

  return parts.join('\n');
}

module.exports = {
  THREAD_PREVIEW_CHARS,
  formatIdentity,
  selectReviewThreads,
  summarizeThreads,
  renderWorkItemDetails,
};
