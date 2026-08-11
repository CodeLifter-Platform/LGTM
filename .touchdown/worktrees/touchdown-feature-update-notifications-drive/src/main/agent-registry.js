/**
 * AgentRegistry — Discovers installed AI coding agents and their models.
 *
 * Each agent definition includes:
 *   - id:        unique key
 *   - name:      display name
 *   - cli:       command name to check for availability
 *   - models:    array of { id, label } model options
 *   - buildCmd:  function(prompt, model) → { command, args } for spawning
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverModelsFor } = require('./model-discovery');

/**
 * Electron apps on macOS don't inherit the user's shell PATH when launched
 * from Finder/Dock. This means CLIs installed via Homebrew, npm -g, nvm,
 * asdf, fnm, volta, etc. won't be found by `which`. We rebuild PATH from
 * three sources, in order of precedence:
 *
 *   1. The user's interactive shell PATH (most authoritative — picks up
 *      whatever the user actually has set up: nvm, asdf, custom dirs)
 *   2. Hardcoded common install locations (fallback if shell launch fails)
 *   3. The PATH Electron started with
 *
 * Critical because some agent CLIs are node shebang scripts (e.g. auggie's
 * `#!/usr/bin/env node`) — they need `node` itself on PATH at spawn time,
 * not just the agent binary.
 */
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const SEP = process.platform === 'win32' ? ';' : ':';

const EXTRA_PATHS_UNIX = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  `${HOME}/.npm-global/bin`,
  `${HOME}/.local/bin`,
  `${HOME}/.nvm/current/bin`,
  `${HOME}/.volta/bin`,
  `${HOME}/.cargo/bin`,
  '/usr/local/share/npm/bin',
];

const EXTRA_PATHS_WIN = [
  `${process.env.APPDATA || ''}\\npm`,
  `${process.env.LOCALAPPDATA || ''}\\Programs\\augment-code`,
  `${process.env.LOCALAPPDATA || ''}\\augment-code`,
  `${HOME}\\.npm-global`,
  `${HOME}\\.volta\\bin`,
  `${HOME}\\.cargo\\bin`,
  `${process.env.PROGRAMFILES || ''}\\nodejs`,
  `${process.env.PROGRAMFILES || ''}\\Augment`,
  'C:\\Program Files\\nodejs',
];

const EXTRA_PATHS = process.platform === 'win32' ? EXTRA_PATHS_WIN : EXTRA_PATHS_UNIX;

/**
 * Spawn the user's login shell and read its PATH. This is what `fix-path`
 * does — we inline it to avoid the dependency. Returns null on Windows
 * (cmd/PowerShell already give Electron a usable PATH) or on failure.
 */
function getUserShellPath() {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -i makes the shell interactive (sources .zshrc/.bashrc),
    // -l makes it a login shell (sources .zprofile/.bash_profile),
    // -c runs the command. Together they reproduce what the user gets
    // when they open Terminal.
    const out = execSync(`${shell} -ilc 'echo -n "$PATH"'`, {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function getEnhancedPath() {
  const seen = new Set();
  const parts = [];
  const push = (raw) => {
    if (!raw) return;
    for (const p of raw.split(SEP)) {
      const trimmed = p.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      parts.push(trimmed);
    }
  };
  push(getUserShellPath());
  push(process.env.PATH);
  for (const p of EXTRA_PATHS) push(p);
  return parts.join(SEP);
}

// Apply the enhanced PATH to the process so child_process.spawn also sees it
process.env.PATH = getEnhancedPath();
console.log(`[LGTM] Effective PATH (${process.env.PATH.split(SEP).length} entries)`);

/**
 * Pre-flight auth checks. Each returns { ok: true } or
 * { ok: false, error, hint }. The runner calls these before cloning so a
 * logged-out agent fails in 50ms instead of after a 30s clone + 60s
 * silent hang.
 *
 * Checks must be cheap and side-effect-free: a file stat or a `security`
 * lookup without `-g` (so no keychain prompt fires). They are NOT
 * authoritative — an agent can still 401 mid-run if the token is
 * expired. They just catch the obvious "not logged in at all" case.
 */
function checkClaudeAuth() {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true };
  if (process.platform !== 'darwin') {
    // claude on Linux/Windows uses different storage we don't currently
    // probe — don't block, let the spawn surface the real error.
    return { ok: true };
  }
  try {
    execSync('security find-generic-password -s "Claude Code-credentials"', {
      stdio: 'ignore',
      timeout: 3000,
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Claude is not logged in.',
      hint: 'Run `claude /login` once in a terminal, or set ANTHROPIC_API_KEY.',
    };
  }
}

function checkAuggieAuth() {
  const sessionPath = path.join(os.homedir(), '.augment', 'session.json');
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const session = JSON.parse(raw);
    if (session && session.accessToken) return { ok: true };
    return {
      ok: false,
      error: 'Auggie session file is missing an access token.',
      hint: 'Run `auggie --login` (or whatever your version uses) in a terminal.',
    };
  } catch {
    return {
      ok: false,
      error: 'Auggie is not logged in.',
      hint: `No session at ~/.augment/session.json. Run \`auggie\` once in a terminal and complete sign-in.`,
    };
  }
}

/**
 * Agent definitions.
 *
 * `buildCmd` now returns { command, args, stdinPrompt } where:
 *   - command/args do NOT contain the prompt text (avoids shell escaping issues)
 *   - stdinPrompt: boolean — if true, the prompt should be piped via stdin
 *
 * Each agent may also declare an `authCheck()` returning { ok, error?, hint? }
 * that the runner calls before cloning.
 *
 * The AgentRunner writes the prompt to a temp file and handles piping.
 */
const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    models: [
      { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ],
    authCheck: checkClaudeAuth,
    // claude -p reads the prompt from stdin and prints the result.
    // bypassPermissions is required for autonomous (non-interactive)
    // runs — without it, claude will hang the first time it wants to
    // run a tool, waiting for a permission prompt that the renderer
    // never surfaces.
    buildCmd: (_prompt, model, resolvedCli) => {
      const args = ['-p', '--verbose', '--permission-mode', 'bypassPermissions'];
      if (model) args.push('--model', model);
      return { command: resolvedCli || 'claude', args, stdinPrompt: true };
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    cli: 'codex',
    models: [
      { id: 'o4-mini',    label: 'o4-mini' },
      { id: 'o3',         label: 'o3' },
      { id: 'gpt-4.1',    label: 'GPT-4.1' },
    ],
    buildCmd: (_prompt, model, resolvedCli) => {
      const args = ['--quiet'];
      if (model) args.push('--model', model);
      return { command: resolvedCli || 'codex', args, stdinPrompt: true };
    },
  },
  {
    id: 'augment',
    name: 'Augment Code',
    cli: ['auggie', 'augment', 'aug', 'augment-code', 'augcode'],  // try multiple names
    models: [
      { id: 'default',    label: 'Default (auto)' },
      { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'gpt-4.1',    label: 'GPT-4.1' },
      { id: 'o4-mini',    label: 'o4-mini' },
      { id: 'o3',         label: 'o3' },
    ],
    authCheck: checkAuggieAuth,
    buildCmd: (_prompt, model, resolvedCli) => {
      // --print forces non-interactive (one-shot) mode and reads the
      // instruction from stdin. Without it, auggie warns "Interactive
      // mode requires a terminal with raw mode support" and falls back
      // to print mode anyway. (Note: there is no `run` subcommand —
      // anything positional is parsed as the instruction text.)
      const args = ['--print'];
      if (model && model !== 'default') args.push('--model', model);
      return { command: resolvedCli || 'auggie', args, stdinPrompt: true };
    },
  },
];

class AgentRegistry {
  constructor() {
    this._cache = null;        // { agentId → boolean }
    this._modelCache = {};     // { agentId → [{id,label}] } — discovered, overlays hardcoded
  }

  /**
   * Return all agent definitions with an `available` flag and the most
   * up-to-date model list (discovered if available, otherwise the
   * hardcoded fallback).
   */
  getAll() {
    if (!this._cache) this.refresh();

    return AGENTS.map((agent) => ({
      ...agent,
      models: this._modelCache[agent.id] || agent.models,
      available: this._cache[agent.id] || false,
    }));
  }

  /**
   * Get a single agent by id.
   */
  get(agentId) {
    return this.getAll().find((a) => a.id === agentId) || null;
  }

  /**
   * Re-detect which CLIs are available on this machine.
   */
  refresh() {
    this._cache = {};       // agentId → boolean
    this._resolvedCli = {}; // agentId → absolute path of resolved binary

    for (const agent of AGENTS) {
      const cliNames = Array.isArray(agent.cli) ? agent.cli : [agent.cli];
      let found = false;

      for (const name of cliNames) {
        const absolutePath = AgentRegistry._resolveBinary(name);
        if (absolutePath) {
          this._cache[agent.id] = true;
          this._resolvedCli[agent.id] = absolutePath;
          console.log(`[LGTM] Agent "${agent.name}" found at: ${absolutePath}`);
          found = true;
          break;
        }
      }

      if (!found) {
        this._cache[agent.id] = false;
        console.log(`[LGTM] Agent "${agent.name}" not found. Tried: ${cliNames.join(', ')}`);
      }
    }

    return this._cache;
  }

  /**
   * Build the shell command + args for a given agent and prompt.
   * Returns { command, args, stdinPrompt } where `command` is the absolute
   * path to the binary (when known) so spawn doesn't need to do its own
   * PATH lookup.
   */
  buildCommand(agentId, prompt, model) {
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const resolvedCli = this._resolvedCli ? this._resolvedCli[agentId] : null;
    return agent.buildCmd(prompt, model, resolvedCli);
  }

  /**
   * Get the resolved absolute path for an agent's CLI (or null).
   */
  getResolvedPath(agentId) {
    return (this._resolvedCli && this._resolvedCli[agentId]) || null;
  }

  /**
   * Ask each available agent which models its current login can use,
   * and overlay the result on the hardcoded list. Discovery is best-
   * effort: if any single agent fails, its hardcoded fallback stays
   * in place and the others still update. Runs all discoverers in
   * parallel.
   *
   * Returns a map of { agentId → 'updated' | 'fallback' | 'unavailable' }
   * so callers can log/log-and-notify.
   */
  async refreshModels() {
    if (!this._cache) this.refresh();
    const status = {};
    const tasks = [];
    for (const agent of AGENTS) {
      if (!this._cache[agent.id]) {
        status[agent.id] = 'unavailable';
        continue;
      }
      const ctx = { resolvedCli: this._resolvedCli[agent.id] };
      tasks.push(
        discoverModelsFor(agent.id, ctx)
          .then((discovered) => {
            if (discovered && discovered.length > 0) {
              this._modelCache[agent.id] = discovered;
              status[agent.id] = 'updated';
              console.log(`[LGTM] ${agent.name}: discovered ${discovered.length} models`);
            } else {
              status[agent.id] = 'fallback';
              console.log(`[LGTM] ${agent.name}: discovery returned nothing, using hardcoded list`);
            }
          })
          .catch((err) => {
            status[agent.id] = 'fallback';
            console.warn(`[LGTM] ${agent.name}: discovery threw — ${err.message}`);
          }),
      );
    }
    await Promise.all(tasks);
    return status;
  }

  /**
   * Resolve a CLI name to an absolute path using `which`/`where`.
   * Returns null if not found. We resolve once at startup and reuse the
   * absolute path forever after — that way spawn never has to do its own
   * PATH lookup, which is the most common Electron-spawn failure mode.
   */
  static _resolveBinary(command) {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${which} ${command}`, {
        timeout: 5000,
        encoding: 'utf8',
        env: { ...process.env },   // uses the enhanced PATH
      }).trim();
      // `where` on Windows can return multiple lines — take the first.
      const firstLine = result.split(/\r?\n/)[0].trim();
      if (!firstLine) return null;
      console.log(`[LGTM]   which ${command} → ${firstLine}`);
      return firstLine;
    } catch {
      console.log(`[LGTM]   which ${command} → not found`);
      return null;
    }
  }
}

module.exports = { AgentRegistry, AGENTS };
