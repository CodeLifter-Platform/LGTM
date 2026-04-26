/**
 * model-discovery — Asks each installed agent CLI which models the
 * current login can actually use, so the dropdown in the UI matches
 * reality (instead of a hardcoded list that goes stale every time
 * Anthropic / Augment / OpenAI ship a new model).
 *
 * Each discoverer returns either:
 *   - an array of { id, label } in the agent's own ID space, OR
 *   - null if discovery couldn't run (no auth, CLI errored, timeout)
 *
 * On null the AgentRegistry keeps the hardcoded fallback list — the
 * UI degrades to the previous behaviour rather than going empty.
 */

const { execFile } = require('child_process');
const { execSync } = require('child_process');
const https = require('https');

const TIMEOUT_MS = 8000;

// ── HTTP helpers ─────────────────────────────────────────────────────

function httpsGetJson(url, headers, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
        } else {
          reject(new Error(`${url} → HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

function execWithTimeout(file, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// ── Claude ───────────────────────────────────────────────────────────

/**
 * Pull the Claude OAuth bearer token out of the macOS keychain. Uses
 * `security` with a short timeout so a hidden ACL prompt can't hang
 * the discovery pass — if anything goes sideways we just return null
 * and let the caller fall back.
 */
function readClaudeOAuthTokenMac() {
  try {
    const out = execSync(
      'security find-generic-password -s "Claude Code-credentials" -g 2>&1',
      { encoding: 'utf8', timeout: 3000 },
    );
    // `security -g` writes `password: "<json>"` on the line we want.
    const m = out.match(/password:\s*"([\s\S]*?)"\s*$/m);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    return (data && data.claudeAiOauth && data.claudeAiOauth.accessToken) || null;
  } catch {
    return null;
  }
}

/**
 * Models good for coding/agent use. Anthropic returns retired and
 * non-chat models too (e.g. Haiku 1) — we filter to the families that
 * make sense for Claude Code.
 */
function isClaudeCoderelevant(model) {
  const id = (model.id || '').toLowerCase();
  if (!id.startsWith('claude-')) return false;
  if (!/(opus|sonnet|haiku)/.test(id)) return false;
  // Drop very old generations to keep the dropdown tidy.
  if (/-(1|2|2\.1|3-haiku-2024)/.test(id)) return false;
  return true;
}

function compareClaudeModels(a, b) {
  // Newer first; secondary sort by tier (opus > sonnet > haiku).
  const ta = Date.parse(a.created_at || 0) || 0;
  const tb = Date.parse(b.created_at || 0) || 0;
  if (tb !== ta) return tb - ta;
  const tier = (id) => id.includes('opus') ? 0 : id.includes('sonnet') ? 1 : 2;
  return tier(a.id) - tier(b.id);
}

async function discoverClaudeModels() {
  let auth;
  if (process.env.ANTHROPIC_API_KEY) {
    auth = { 'x-api-key': process.env.ANTHROPIC_API_KEY };
  } else if (process.platform === 'darwin') {
    const token = readClaudeOAuthTokenMac();
    if (!token) return null;
    auth = {
      Authorization: `Bearer ${token}`,
      // OAuth bearer tokens require this beta header on /v1/models.
      'anthropic-beta': 'oauth-2025-04-20',
    };
  } else {
    // Linux/Windows without an API key — can't introspect.
    return null;
  }

  try {
    const json = await httpsGetJson('https://api.anthropic.com/v1/models?limit=50', {
      'anthropic-version': '2023-06-01',
      ...auth,
    });
    const models = (json.data || [])
      .filter(isClaudeCoderelevant)
      .sort(compareClaudeModels)
      .map((m) => ({ id: m.id, label: m.display_name || m.id }));
    return models.length > 0 ? models : null;
  } catch (err) {
    console.warn(`[LGTM] Claude model discovery failed: ${err.message}`);
    return null;
  }
}

// ── Auggie ───────────────────────────────────────────────────────────

/**
 * `auggie model list` prints lines like:
 *    - Opus 4.7 [opus4.7]
 *        Great for complex, multi-step agentic tasks
 * Optionally with a deprecation marker. We pull (label, id) pairs.
 */
function parseAuggieModelList(stdout) {
  const lines = stdout.split('\n');
  const models = [];
  // Match `<whitespace>- <label> [<id>]` — id is the canonical name
  // we pass to --model. Description on the next line is ignored.
  const re = /^\s*-\s+(.+?)\s+\[([^\]]+)\]\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) models.push({ id: m[2].trim(), label: m[1].trim() });
  }
  return models;
}

async function discoverAuggieModels(resolvedCli) {
  const bin = resolvedCli || 'auggie';
  try {
    const stdout = await execWithTimeout(bin, ['model', 'list']);
    const models = parseAuggieModelList(stdout);
    // Always keep "default (auto)" as the first option so users can
    // let Auggie pick the model itself — that's the common case.
    const withDefault = [{ id: 'default', label: 'Default (auto)' }, ...models];
    return withDefault.length > 1 ? withDefault : null;
  } catch (err) {
    console.warn(`[LGTM] Auggie model discovery failed: ${err.message}`);
    return null;
  }
}

// ── Codex ────────────────────────────────────────────────────────────

/**
 * Best-effort: hit OpenAI's /v1/models if the user has OPENAI_API_KEY
 * set. The Codex CLI itself doesn't expose a list command we can rely
 * on across versions. If no key, return null and let the caller keep
 * the hardcoded list.
 */
async function discoverCodexModels() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const json = await httpsGetJson('https://api.openai.com/v1/models', {
      Authorization: `Bearer ${key}`,
    });
    // Codex is happiest with reasoning + GPT models; filter to those.
    const models = (json.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o\d|o-?\w+)/i.test(id))
      .sort()
      .map((id) => ({ id, label: id }));
    return models.length > 0 ? models : null;
  } catch (err) {
    console.warn(`[LGTM] Codex model discovery failed: ${err.message}`);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

const DISCOVERERS = {
  claude: () => discoverClaudeModels(),
  augment: (ctx) => discoverAuggieModels(ctx.resolvedCli),
  codex: () => discoverCodexModels(),
};

/**
 * Run discovery for a single agent. `ctx` carries anything the
 * discoverer might need (e.g. resolvedCli for spawning the binary).
 * Returns null if no discoverer is registered or discovery fails.
 */
async function discoverModelsFor(agentId, ctx = {}) {
  const fn = DISCOVERERS[agentId];
  if (!fn) return null;
  return fn(ctx);
}

module.exports = {
  discoverModelsFor,
  // Exported for tests / future reuse:
  parseAuggieModelList,
  isClaudeCoderelevant,
};
