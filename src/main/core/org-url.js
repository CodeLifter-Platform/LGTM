/**
 * parseOrgUrl — split a user-typed Azure DevOps URL into the org base URL
 * the SDK talks to plus an optional project filter.
 *
 * Pure: no I/O, no Electron. The iPad head mirrors this exactly in
 * `ios/LGTM/DevOpsClient.swift`; a behaviour change here lands there in
 * the same change.
 *
 * Handles:
 *   https://dev.azure.com/myorg                       → org only
 *   https://dev.azure.com/myorg/MyProject              → org + project
 *   https://myorg.visualstudio.com                     → org only
 *   https://myorg.visualstudio.com/MyProject           → org + project
 *   https://myorg.visualstudio.com/MyProject/_git/…    → org + project (extra path stripped)
 *   http://tfs:8080/tfs/DefaultCollection              → on-prem: port kept, vdir + collection
 *   http://tfs:8080/tfs/DefaultCollection/Proj         → on-prem + project
 *   https://ado.corp.example/DefaultCollection/Proj    → on-prem without the `tfs` vdir
 *
 * On-prem rule: the leading `tfs` segment is the classic TFS virtual
 * directory, so `tfs/<Collection>` is the base and the next segment is the
 * project. Without it, the first segment is the collection. Anything from
 * the first `_`-prefixed segment on (`_git`, `_apis`, `_workitems`) is UI
 * or API routing and is dropped.
 *
 * Garbage that `new URL` rejects comes back as `{ orgUrl: raw, project: null }`
 * so a caller can still show the user what they typed.
 */
function parseOrgUrl(raw) {
  const url = (raw || '').trim().replace(/\/+$/, '');

  let u;
  try {
    u = new URL(url);
  } catch {
    return { orgUrl: url, project: null };
  }

  // `host` keeps a non-default port; `hostname` would drop it, which sends
  // an on-prem server's traffic to the wrong port.
  const base = `${u.protocol}//${u.host}`;
  const parts = u.pathname.split('/').filter(Boolean);
  const routeIdx = parts.findIndex((p) => p.startsWith('_'));
  const segs = routeIdx === -1 ? parts : parts.slice(0, routeIdx);

  if (u.hostname === 'dev.azure.com') {
    const org = segs[0] || '';
    const project = segs[1] ? decodeURIComponent(segs[1]) : null;
    return { orgUrl: `${base}/${org}`, project };
  }

  if (u.hostname.endsWith('.visualstudio.com')) {
    const project = segs[0] ? decodeURIComponent(segs[0]) : null;
    return { orgUrl: base, project };
  }

  // On-prem / unknown host.
  const baseLen = (segs[0] || '').toLowerCase() === 'tfs' && segs.length >= 2 ? 2 : 1;
  const basePath = segs.slice(0, baseLen).map((s) => `/${s}`).join('');
  const project = segs[baseLen] ? decodeURIComponent(segs[baseLen]) : null;
  return { orgUrl: `${base}${basePath}`, project };
}

module.exports = { parseOrgUrl };
