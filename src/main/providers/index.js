/**
 * providers — the registry of git services LGTM can connect to, and the
 * `Connection` object that bundles everything the rest of the main process
 * needs per connected service: the API client, how to build an authenticated
 * clone URL, which env vars to hand the agent, and how to recognise the
 * service's webhooks.
 *
 * Adding a provider means adding one entry to PROVIDERS. Nothing else in the
 * app switches on the provider id except the prompt files it loads.
 *
 * Pure module: imports without Electron so it can be unit-tested.
 */

const { DevOpsClient } = require('../devops-client');
const { GitHubClient } = require('./github-client');

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH']);

function classifyError(err) {
  const code = err && err.code;
  if (NETWORK_CODES.has(code)) return 'unreachable';
  return 'unreachable';
}

const PROVIDERS = {
  'azure-devops': {
    id: 'azure-devops',
    label: 'Azure DevOps',
    short: 'ADO',
    glyph: 'AZ',
    urlLabel: 'Organization URL',
    urlPlaceholder: 'https://dev.azure.com/myorg or https://myorg.visualstudio.com/project',
    urlHint: 'Append a project to scope the lists to one project.',
    tokenLabel: 'Personal Access Token',
    tokenPlaceholder: 'paste your PAT here',
    scopes: ['Code (Read & Write)', 'Work Items (Read & Write)', 'Pull Request Threads'],
    openLabel: 'Open in DevOps',
    groupNoun: 'project',
    sprintNoun: 'sprint recency',
    tokenEnvNames: ['AZURE_DEVOPS_PAT', 'AZURE_DEVOPS_EXT_PAT', 'SYSTEM_ACCESSTOKEN'],
    // Scenario prompt set under resources/prompts/. The ADO files are the
    // originals at the root; other providers keep theirs in a subfolder.
    promptSet: '',
    universalPromptFile: 'LGTM_REVIEW_PROMPT.md',

    parseUrl(raw) {
      const p = DevOpsClient.parseOrgUrl(raw);
      return { url: p.orgUrl, scope: p.project || null, display: p.orgUrl.replace(/^https?:\/\/(dev\.azure\.com\/)?/, '') + (p.project ? `/${p.project}` : '') };
    },
    createClient(token, url, opts) { return new DevOpsClient(token, url, opts); },

    /**
     * Cheapest authenticated round-trip. Returns ok / rejected / unreachable
     * so a dead token forces re-entry while a network blip does not.
     */
    async quickValidate(token, url, http) {
      const parsed = DevOpsClient.parseOrgUrl(url);
      if (!parsed.orgUrl) return { ok: false, reason: 'rejected' };
      const auth = Buffer.from(`:${token}`).toString('base64');
      try {
        const res = await http({
          method: 'GET',
          url: `${parsed.orgUrl}/_apis/ConnectionData?connectOptions=none&api-version=7.0`,
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          timeout: 4000,
          maxRedirects: 0,
        });
        const user = res.data && res.data.authenticatedUser;
        // ADO's "your PAT is bad" signal is a 203 with HTML, not a 401.
        if (res.status === 200 && user && user.id) return { ok: true };
        if (res.status === 401 || res.status === 403 || res.status === 203) return { ok: false, reason: 'rejected' };
        return { ok: false, reason: 'unreachable' };
      } catch (err) {
        return { ok: false, reason: classifyError(err) };
      }
    },

    /** https://pat:<token>@dev.azure.com/org/project/_git/repo */
    cloneUrl(token, url, project, repo) {
      const base = DevOpsClient.parseOrgUrl(url).orgUrl.replace(/\/+$/, '');
      const u = new URL(base);
      return `${u.protocol}//pat:${encodeURIComponent(token)}@${u.host}${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
    },

    isWebhookEvent(body, headers) {
      return !!(body && typeof body.eventType === 'string' && body.eventType.startsWith('git.pullrequest'));
    },

    /** Human-readable "connected as" line. */
    describeUser(user) { return user ? (user.displayName || user.email || user.id || '') : ''; },
  },

  github: {
    id: 'github',
    label: 'GitHub',
    short: 'GH',
    glyph: 'GH',
    urlLabel: 'GitHub URL',
    urlPlaceholder: 'https://github.com/myorg (or https://github.com for everything you can see)',
    urlHint: 'An owner scopes the lists to that user or organisation; add a repo to scope further. GitHub Enterprise hosts work too.',
    tokenLabel: 'Personal Access Token',
    tokenPlaceholder: 'ghp_… or github_pat_…',
    scopes: ['repo', 'read:org', 'read:user'],
    openLabel: 'Open in GitHub',
    groupNoun: 'owner',
    sprintNoun: 'milestone due date',
    tokenEnvNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
    promptSet: 'github',
    universalPromptFile: 'LGTM_REVIEW_PROMPT.github.md',

    parseUrl(raw) {
      const p = GitHubClient.parseUrl(raw);
      const display = [p.host === 'github.com' ? '' : p.host, p.owner, p.repo].filter(Boolean).join('/') || 'github.com';
      return { url: `${p.webUrl}${p.owner ? `/${p.owner}` : ''}${p.repo ? `/${p.repo}` : ''}`, scope: p.owner, display };
    },
    createClient(token, url, opts) { return new GitHubClient(token, url, opts); },

    async quickValidate(token, url, http) {
      const parsed = GitHubClient.parseUrl(url);
      try {
        const res = await http({
          method: 'GET',
          url: `${parsed.apiUrl}/user`,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'LGTM' },
          timeout: 4000,
          maxRedirects: 0,
        });
        if (res.status === 200 && res.data && res.data.login) return { ok: true };
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
        return { ok: false, reason: 'unreachable' };
      } catch (err) {
        return { ok: false, reason: classifyError(err) };
      }
    },

    /** https://x-access-token:<token>@github.com/owner/repo.git */
    cloneUrl(token, url, project, repo) {
      const p = GitHubClient.parseUrl(url);
      const u = new URL(p.webUrl);
      return `${u.protocol}//x-access-token:${encodeURIComponent(token)}@${u.host}/${encodeURIComponent(project)}/${encodeURIComponent(repo)}.git`;
    },

    isWebhookEvent(body, headers) {
      const h = headers || {};
      const event = String(h['x-github-event'] || h['X-GitHub-Event'] || '').toLowerCase();
      if (event) return event === 'pull_request' || event === 'pull_request_review' || event === 'issues';
      return !!(body && (body.pull_request || body.issue) && body.repository);
    },

    describeUser(user) { return user ? (user.login ? `@${user.login}` : (user.displayName || '')) : ''; },
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider "${id}". Known: ${PROVIDER_IDS.join(', ')}`);
  return p;
}

/** The serialisable, renderer-safe view of a provider definition. */
function describeProvider(id) {
  const p = getProvider(id);
  const out = {};
  for (const [k, v] of Object.entries(p)) if (typeof v !== 'function') out[k] = v;
  return out;
}

/**
 * A connected service. Holds the token in memory only; persistence is the
 * TokenStore's job.
 */
class Connection {
  constructor(providerId, token, rawUrl, opts = {}) {
    this.provider = getProvider(providerId);
    this.providerId = providerId;
    this.token = token;
    this.rawUrl = rawUrl;
    const parsed = this.provider.parseUrl(rawUrl);
    this.url = parsed.url;
    this.scope = parsed.scope;
    this.display = parsed.display;
    this.client = this.provider.createClient(token, rawUrl, opts.clientOptions);
    this.user = null;
  }

  get label() { return this.provider.label; }

  /** Env vars handed to spawned agents so their REST calls can authenticate. */
  agentEnv() {
    const env = {};
    for (const name of this.provider.tokenEnvNames) env[name] = this.token;
    return env;
  }

  cloneUrl(project, repo) {
    return this.provider.cloneUrl(this.token, this.rawUrl, project, repo);
  }

  /** Hosts an inline image may live on before the token is sent along. */
  get attachmentHosts() {
    const c = this.client;
    if (Array.isArray(c.attachmentHosts)) return c.attachmentHosts;
    return c.orgHost ? [c.orgHost] : [];
  }

  describeUser() { return this.provider.describeUser(this.user); }

  /** Renderer-safe status row. Never includes the token. */
  toStatus() {
    return {
      providerId: this.providerId,
      label: this.provider.label,
      short: this.provider.short,
      url: this.rawUrl,
      display: this.display,
      user: this.user ? { id: this.user.id, displayName: this.user.displayName, email: this.user.email || '', login: this.user.login || '' } : null,
      userLabel: this.describeUser(),
      connected: true,
    };
  }
}

module.exports = { PROVIDERS, PROVIDER_IDS, getProvider, describeProvider, Connection, classifyError };
