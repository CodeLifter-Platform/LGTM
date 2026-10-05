'use strict';
/**
 * Shared fakes for the LGTM suite. One file, as the test standard asks.
 *
 *   startFakeAdo(fixture)   an http server that speaks enough Azure DevOps
 *                           for the real `azure-devops-node-api` SDK: the
 *                           OPTIONS route discovery per area, the
 *                           ResourceAreas lookup, and the handful of GETs
 *                           DevOpsClient makes. Records every request.
 *   FakeKeychain            keytar-shaped; can refuse or hang.
 *   MemoryStore             conf-shaped get/set/delete over a Map.
 *   ScriptedDevOpsClient    getAllOpenPRs/getMe scripted per call.
 *   makeBareRepo()          a real bare git repo with two branches.
 *   collectNotify()         AgentRunner notify sink with waitFor helpers.
 *   fakeRegistry()          AgentRegistry stand-in pointing at fake-agent.js.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ── Fake Azure DevOps ─────────────────────────────────────────────────

// Location ids the SDK asks for, with route templates that produce the
// paths this fake serves. Templates need not match real ADO byte for byte:
// the SDK only ever hits the URL it computed from them.
const LOCATIONS = {
  Location: [
    { id: 'e81700f7-3be2-46de-8624-2eb35882fcaa', resourceName: 'ResourceAreas', routeTemplate: '_apis/{resource}/{areaId}' },
    { id: '00d9565f-ed9c-4a06-9a50-00e7896ccab4', resourceName: 'ConnectionData', routeTemplate: '_apis/{resource}' },
  ],
  core: [
    { id: '603fe2ac-9723-48b9-88ad-09305aa6c6e1', resourceName: 'projects', routeTemplate: '_apis/{resource}/{*projectId}' },
  ],
  git: [
    { id: '225f7195-f9c7-4d14-ab28-a83f7ff77e1f', resourceName: 'repositories', routeTemplate: '{project}/_apis/{area}/{resource}/{repositoryId}' },
    { id: '9946fd70-0d40-406e-b686-b4744cbbcc37', resourceName: 'pullRequests', routeTemplate: '{project}/_apis/{area}/repositories/{repositoryId}/{resource}/{pullRequestId}' },
    { id: '01a46dea-7d46-4d40-bc84-319e7c260d99', resourceName: 'pullRequests', routeTemplate: '{project}/_apis/{area}/{resource}/{pullRequestId}' },
    { id: 'ab6e2e5d-a0b7-4153-b64a-a4efe0d49449', resourceName: 'threads', routeTemplate: '{project}/_apis/{area}/repositories/{repositoryId}/pullRequests/{pullRequestId}/{resource}/{threadId}' },
    { id: 'fb93c0db-47ed-4a31-8c20-47552878fb44', resourceName: 'items', routeTemplate: '{project}/_apis/{area}/repositories/{repositoryId}/{resource}/{*path}' },
  ],
  policy: [
    { id: 'c23ddff5-229c-4d04-a80b-0fdce9f360c8', resourceName: 'Evaluations', routeTemplate: '{project}/_apis/{area}/{resource}/{evaluationId}' },
  ],
  wit: [
    { id: '1a9c53f7-f243-4447-b110-35ef023636e4', resourceName: 'wiql', routeTemplate: '{project}/{team}/_apis/{area}/{resource}/{id}' },
    { id: '72c7ddf8-2cdc-4f60-90cd-ab71c14a399b', resourceName: 'workItems', routeTemplate: '{project}/_apis/{area}/{resource}/{id}' },
    { id: '5a172953-1b41-49d3-840a-33f79c3ce89f', resourceName: 'classificationNodes', routeTemplate: '{project}/_apis/{area}/{resource}/{structureGroup}/{*path}' },
  ],
};

function locationDoc(area, loc) {
  return {
    id: loc.id,
    area,
    resourceName: loc.resourceName,
    routeTemplate: loc.routeTemplate,
    resourceVersion: 4,
    minVersion: '1.0',
    maxVersion: '7.2',
    releasedVersion: '7.2',
  };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * @param {object} fixture
 * @param {string} [fixture.pat]                 - the only PAT accepted (default 'secret-pat')
 * @param {string} [fixture.basePath]            - e.g. '/tfs/DefaultCollection' for an on-prem shape
 * @param {object[]} [fixture.projects]          - [{ id, name }]
 * @param {object} [fixture.repos]               - { [projectName]: [{ id, name }] }
 * @param {object} [fixture.prs]                 - { [repoId]: [GitPullRequest-ish] }
 * @param {object} [fixture.threads]             - { [prId]: [thread] }
 * @param {object} [fixture.policies]            - { [prId]: [evaluation] }
 * @param {object} [fixture.attachments]         - { [path]: { contentType, body: Buffer } }
 * @param {(req: {method,url,headers}) => ({status, body, raw?}|undefined)} [fixture.intercept]
 *        - first look at every request; return a response to short-circuit
 */
async function startFakeAdo(fixture = {}) {
  const pat = fixture.pat === undefined ? 'secret-pat' : fixture.pat;
  const basePath = (fixture.basePath || '').replace(/\/+$/, '');
  const projects = fixture.projects || [{ id: 'p-1', name: 'Alpha' }];
  const repos = fixture.repos || {};
  const prs = fixture.prs || {};
  const threads = fixture.threads || {};
  const policies = fixture.policies || {};
  const attachments = fixture.attachments || {};
  const requests = [];
  const state = { intercept: fixture.intercept || null };

  const acceptedAuth = new Set([
    `Basic ${Buffer.from(`PAT:${pat}`).toString('base64')}`, // SDK handler
    `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,    // raw axios calls
  ]);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);

      if (state.intercept) {
        const hit = state.intercept(record);
        const respond = (h) => {
          if (h.raw !== undefined) {
            res.writeHead(h.status, h.headers || { 'Content-Type': 'text/html' });
            return res.end(h.raw);
          }
          return json(res, h.status, h.body);
        };
        if (hit && typeof hit.then === 'function') {
          // A promise that never settles models a server that never answers.
          hit.then(respond);
          return undefined;
        }
        if (hit) return respond(hit);
      }

      const u = new URL(req.url, 'http://fake');
      let p = u.pathname;
      if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length);
      else if (basePath) return json(res, 404, { message: `no such collection: ${u.pathname}` });
      const lower = p.toLowerCase();

      if (!acceptedAuth.has(req.headers.authorization || '')) {
        return json(res, 401, { message: 'TF400813: The user is not authorized to access this resource.' });
      }

      // Route discovery: OPTIONS /_apis/<area>
      let m = p.match(/^\/_apis\/([A-Za-z]+)$/);
      if (req.method === 'OPTIONS' && m) {
        const area = Object.keys(LOCATIONS).find((a) => a.toLowerCase() === m[1].toLowerCase());
        if (!area) return json(res, 404, { message: `unknown area ${m[1]}` });
        return json(res, 200, { count: LOCATIONS[area].length, value: LOCATIONS[area].map((l) => locationDoc(area, l)) });
      }

      if (lower === '/_apis/resourceareas') {
        // On-prem shape: no resource areas, every API lives under the base URL.
        return json(res, 200, { count: 0, value: null });
      }

      if (lower === '/_apis/connectiondata') {
        return json(res, 200, {
          authenticatedUser: {
            id: 'user-1',
            providerDisplayName: 'Test User',
            properties: { Account: { $type: 'System.String', $value: 'test@example.com' } },
          },
        });
      }

      if (lower === '/_apis/projects') {
        return json(res, 200, { count: projects.length, value: projects });
      }

      m = p.match(/^\/([^/]+)\/_apis\/git\/repositories$/i);
      if (m) {
        const list = repos[decodeURIComponent(m[1])] || [];
        return json(res, 200, { count: list.length, value: list });
      }

      m = p.match(/^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests$/i);
      if (m) {
        const list = prs[decodeURIComponent(m[2])] || [];
        return json(res, 200, { count: list.length, value: list });
      }

      m = p.match(/^\/([^/]+)\/_apis\/git\/pullRequests\/(\d+)$/i);
      if (m) {
        const all = Object.values(prs).flat();
        const pr = all.find((x) => String(x.pullRequestId) === m[2]);
        return pr ? json(res, 200, pr) : json(res, 404, { message: 'PR not found' });
      }

      m = p.match(/^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/threads$/i);
      if (m) {
        const list = threads[m[3]] || [];
        return json(res, 200, { count: list.length, value: list });
      }

      m = p.match(/^\/([^/]+)\/_apis\/policy\/Evaluations$/i);
      if (m) {
        const artifact = u.searchParams.get('artifactId') || '';
        const prId = artifact.split('/').pop();
        const list = policies[prId] || [];
        return json(res, 200, { count: list.length, value: list });
      }

      if (attachments[p]) {
        const a = attachments[p];
        res.writeHead(200, { 'Content-Type': a.contentType, 'Content-Length': a.body.length });
        return res.end(a.body);
      }

      return json(res, 404, { message: `fake ADO has no route for ${req.method} ${p}` });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    pat,
    port,
    origin,
    /** The URL a user would type: origin + collection path. */
    orgUrl: `${origin}${basePath}`,
    requests,
    setIntercept(fn) { state.intercept = fn; },
    /** Authorization header values seen so far, deduplicated. */
    authHeaders() { return [...new Set(requests.map((r) => r.headers.authorization).filter(Boolean))]; },
    paths() { return requests.map((r) => `${r.method} ${r.url}`); },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** Minimal GitPullRequest as the ADO REST API returns it. */
function adoPr({ id, title, repoId, repoName, project, created, reviewers = [], source = 'refs/heads/feature', target = 'refs/heads/main', description = '' }) {
  return {
    pullRequestId: id,
    title,
    description,
    status: 1, // PullRequestStatus.Active
    creationDate: created,
    sourceRefName: source,
    targetRefName: target,
    createdBy: { displayName: 'Ada', id: 'ada' },
    reviewers,
    url: `http://fake/_apis/git/pullRequests/${id}`,
    repository: { id: repoId, name: repoName, project: { name: project } },
  };
}

// ── Keychain and stores ───────────────────────────────────────────────

/**
 * keytar-shaped fake. mode: 'ok' | 'refuse' | 'hang'.
 *   refuse → every call rejects with `error`
 *   hang   → every call returns a promise that never settles
 */
class FakeKeychain {
  constructor({ mode = 'ok', error = 'The user name or passphrase you entered is not correct.' } = {}) {
    this.mode = mode;
    this.error = error;
    this.entries = new Map();
    this.calls = [];
  }

  _gate(op) {
    this.calls.push(op);
    if (this.mode === 'refuse') return Promise.reject(new Error(this.error));
    if (this.mode === 'hang') return new Promise(() => {});
    return null;
  }

  getPassword(service, account) {
    return this._gate('get') || Promise.resolve(this.entries.get(`${service}/${account}`) || null);
  }

  setPassword(service, account, password) {
    return this._gate('set') || (this.entries.set(`${service}/${account}`, password), Promise.resolve());
  }

  deletePassword(service, account) {
    return this._gate('delete') || Promise.resolve(this.entries.delete(`${service}/${account}`));
  }
}

/** conf-shaped in-memory store. */
class MemoryStore {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); this.writes = 0; }
  get(key) { return this.map.get(key); }
  set(key, value) { this.writes += 1; this.map.set(key, value); }
  has(key) { return this.map.has(key); }
  delete(key) { this.map.delete(key); }
  get store() { return Object.fromEntries(this.map); }
}

// ── DevOps client stand-ins ───────────────────────────────────────────

/**
 * A DevOpsClient whose getAllOpenPRs follows a script: each entry is
 * either an array (resolve with it) or an Error (reject). Past the end of
 * the script the last entry repeats.
 */
class ScriptedDevOpsClient {
  constructor({ script = [[]], user = { id: 'u1', displayName: 'Test User', email: 't@example.com' } } = {}) {
    this.script = script;
    this.user = user;
    this.calls = 0;
  }
  async getMe() { return this.user; }
  async getAllOpenPRs() {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step instanceof Error) throw step;
    return step;
  }
}

// ── git fixtures ──────────────────────────────────────────────────────

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function tempDir(prefix = 'lgtm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A bare repo with `main` (README.md) and `feature/x` (adds feature.txt),
 * with the convention prompt file on the feature branch so PromptResolver
 * discovers it. Returns { dir, url } where url is a file:// URL.
 */
function makeBareRepo({ featureBranch = 'feature/x', promptFile = '.lgtm/review-prompt.md', promptBody = 'Repo rule: be kind.' } = {}) {
  const root = tempDir('lgtm-git-');
  const work = path.join(root, 'work');
  const bare = path.join(root, 'origin.git');
  const git = (args, cwd = work) => execFileSync('git', args, {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_TERMINAL_PROMPT: '0' },
  });
  fs.mkdirSync(work);
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  git(['checkout', '-q', '-b', featureBranch]);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'new feature\n');
  if (promptFile) {
    fs.mkdirSync(path.dirname(path.join(work, promptFile)), { recursive: true });
    fs.writeFileSync(path.join(work, promptFile), promptBody);
  }
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feature']);
  git(['checkout', '-q', 'main']);
  git(['clone', '-q', '--bare', work, bare], root);
  git(['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], root);
  git(['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], root);
  return {
    dir: bare,
    url: `file://${bare}`,
    featureBranch,
    remove() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// ── AgentRunner collaborators ─────────────────────────────────────────

/** A notify sink that records every update/chunk and can await a status. */
function collectNotify() {
  const updates = [];
  const chunks = [];
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      if (updates.some((u) => u.key === w.key && w.pred(u))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(updates.filter((u) => u.key === w.key).at(-1));
      }
    }
  };
  return {
    updates,
    chunks,
    update(key, payload) { updates.push({ key, ...payload }); check(); },
    chunk(key, payload) { chunks.push({ key, ...payload }); },
    statuses(key) { return updates.filter((u) => u.key === key).map((u) => u.status); },
    waitForStatus(key, status, timeoutMs = 10000) {
      return this.waitFor(key, (u) => u.status === status, timeoutMs);
    },
    waitFor(key, pred, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${key}; saw ${JSON.stringify(this.statuses(key))}`)), timeoutMs);
        waiters.push({ key, pred, resolve: (u) => { clearTimeout(timer); resolve(u); } });
        check();
      });
    },
  };
}

const FAKE_AGENT = path.join(__dirname, '..', 'fixtures', 'fake-agent.js');

/**
 * Registry stand-in: one available agent ('claude' by default) whose
 * command is the fake agent run under this node binary. `mode` and
 * `report` are forwarded to the fixture as argv flags, never via env.
 */
function fakeRegistry({ agentId = 'claude', available = true, mode = 'ok', report = null, command = process.execPath, extraArgs = [] } = {}) {
  const args = [FAKE_AGENT, '--mode', mode, ...(report ? ['--report', JSON.stringify(report)] : []), ...extraArgs];
  return {
    get(id) {
      if (id !== agentId) return null;
      return { id, name: `Fake ${id}`, available, models: [] };
    },
    buildCommand(id) {
      if (id !== agentId) throw new Error(`Unknown agent: ${id}`);
      return { command, args, stdinPrompt: true };
    },
    getResolvedPath() { return command; },
    getAll() { return [this.get(agentId)]; },
  };
}

/** Scenario prompts from the repo's real resources/prompts. */
function realScenarioPrompts() {
  const { ScenarioPrompts } = require('../../src/main/scenario-prompts');
  const sp = new ScenarioPrompts();
  sp.loadAll();
  return sp;
}

module.exports = {
  startFakeAdo,
  adoPr,
  FakeKeychain,
  MemoryStore,
  ScriptedDevOpsClient,
  hasGit,
  tempDir,
  makeBareRepo,
  collectNotify,
  fakeRegistry,
  realScenarioPrompts,
  FAKE_AGENT,
};
