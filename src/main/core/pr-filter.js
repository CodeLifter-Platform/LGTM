/**
 * Drop work items that don't match the requested PR-linkage filter.
 * 'all' → no-op, 'has' → only items with a linked PR, 'none' → only
 * items without one. Items carry the `hasLinkedPR` flag from
 * DevOpsClient (populated via $expand=Relations).
 */
function applyPrFilter(items, prFilter) {
  if (!Array.isArray(items)) return [];
  if (prFilter === 'has')  return items.filter((it) => it.hasLinkedPR);
  if (prFilter === 'none') return items.filter((it) => !it.hasLinkedPR);
  return items;
}

module.exports = { applyPrFilter };
