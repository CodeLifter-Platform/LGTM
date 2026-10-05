/**
 * Cheapest authenticated round-trip against Azure DevOps. Hits
 * `_apis/ConnectionData?connectOptions=none` — the SDK uses this
 * under the hood for `getMe()` but going via axios skips the SDK
 * client warmup and gives us a tight timeout we control.
 *
 * Returns:
 *   { ok: true }                         — PAT works
 *   { ok: false, reason: 'rejected' }    — org responded but auth failed
 *   { ok: false, reason: 'unreachable' } — DNS / timeout / network
 *
 * The reason matters: a rejected PAT forces re-entry, but a network
 * blip should let the user into the app with whatever's cached.
 */

const axios = require('axios');
const { parseOrgUrl } = require('./core/org-url');

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNRESET']);

async function quickValidatePat(pat, orgUrl, { timeoutMs = 4000, http = axios, log = console.warn } = {}) {
  const parsed = parseOrgUrl(orgUrl);
  if (!parsed.orgUrl || !/^https?:\/\//i.test(parsed.orgUrl)) return { ok: false, reason: 'rejected' };
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const url = `${parsed.orgUrl}/_apis/ConnectionData?connectOptions=none&api-version=7.0`;
  try {
    const res = await http.get(url, {
      timeout: timeoutMs,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      validateStatus: () => true,            // we want to inspect the code ourselves
      maxRedirects: 0,                       // ADO redirects unauth'd traffic to the sign-in page
    });
    const user = res.data && res.data.authenticatedUser;
    // ADO's "your PAT is bad" signal is a 203 with HTML, not a 401 —
    // hence the explicit user.id check.
    if (res.status === 200 && user && user.id) {
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403 || res.status === 203) {
      return { ok: false, reason: 'rejected' };
    }
    return { ok: false, reason: 'unreachable' };
  } catch (err) {
    const code = err && err.code;
    if (NETWORK_CODES.has(code)) {
      return { ok: false, reason: 'unreachable' };
    }
    // Unknown failure mode — be conservative and don't lock the user out.
    log(`[LGTM] quickValidatePat error (treating as unreachable): ${err && err.message}`);
    return { ok: false, reason: 'unreachable' };
  }
}

module.exports = { quickValidatePat };
