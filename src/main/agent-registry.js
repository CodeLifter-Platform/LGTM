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
const path = require('path');

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
 * Agent definitions.
 *
 * `buildCmd` now returns { command, args, stdinPrompt } where:
 *   - command/args do NOT contain the prompt text (avoids shell escaping issues)
 *   - stdinPrompt: boolean — if true, the prompt should be piped via stdin
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
    this._cache = null; // { agentId → boolean }
  }

  /**
   * Return all agent definitions with an `available` flag.
   * Results are cached; call refresh() to re-detect.
   */
  getAll() {
    if (!this._cache) this.refresh();

    return AGENTS.map((agent) => ({
      ...agent,
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
