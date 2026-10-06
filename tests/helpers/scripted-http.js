/**
 * Shared test helpers: a scripted HTTP stub in the shape GitHubClient and the
 * provider registry expect, and a few fixtures. No network, no Electron.
 */

/**
 * Build an `http(req)` function from an ordered list of routes. Each route is
 * `{ match: RegExp | string, status?, data?, headers?, times? }` matched
 * against `${method} ${url}`. Unmatched requests reject so a test never
 * silently hits the wrong endpoint. The returned function records every
 * request in `.calls`.
 */
function scriptedHttp(routes) {
  const calls = [];
  const http = async (req) => {
    const key = `${(req.method || 'GET').toUpperCase()} ${req.url}`;
    calls.push({ key, req });
    for (const r of routes) {
      const ok = r.match instanceof RegExp ? r.match.test(key) : key.includes(r.match);
      if (!ok) continue;
      if (r.throws) throw r.throws;
      if (typeof r.reply === 'function') return r.reply(req);
      return { status: r.status || 200, headers: r.headers || {}, data: r.data === undefined ? {} : r.data };
    }
    throw new Error(`scriptedHttp: no route for ${key}`);
  };
  http.calls = calls;
  return http;
}

function ghPr(overrides = {}) {
  return {
    number: 42,
    title: 'Add provider layer',
    draft: false,
    user: { login: 'alice' },
    created_at: '2026-10-01T10:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42',
    url: 'https://api.github.com/repos/acme/widgets/pulls/42',
    head: { ref: 'feature/providers', repo: { full_name: 'acme/widgets' } },
    base: { ref: 'main' },
    mergeable_state: 'clean',
    ...overrides,
  };
}

function ghIssue(overrides = {}) {
  return {
    number: 7,
    title: 'Crash on launch',
    state: 'open',
    user: { login: 'bob' },
    assignees: [{ login: 'alice' }],
    labels: [{ name: 'bug' }, { name: 'P1' }],
    milestone: null,
    created_at: '2026-09-20T09:00:00Z',
    updated_at: '2026-09-21T09:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/7',
    repository_url: 'https://api.github.com/repos/acme/widgets',
    ...overrides,
  };
}

/** An in-memory stand-in for electron-store. */
class MemoryStore {
  constructor() { this.data = {}; }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; }
  delete(k) { delete this.data[k]; }
}

const silentLogger = { log() {}, warn() {}, error() {} };

module.exports = { scriptedHttp, ghPr, ghIssue, MemoryStore, silentLogger };
