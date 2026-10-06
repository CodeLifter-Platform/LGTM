/**
 * htmlToText — the one HTML-to-plain-text strip LGTM feeds to agents.
 *
 * Azure DevOps stores descriptions, repro steps and comment bodies as
 * HTML. Agents want text. This used to be copied three times (work-item
 * details, PR description, detail-chat prompt); it lives here once so
 * the three prompts cannot drift.
 */
function htmlToText(html) {
  return (html || '')
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
}

module.exports = { htmlToText };
