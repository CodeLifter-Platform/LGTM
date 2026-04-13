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
 * from Finder/Dock. This means CLIs installed via Homebrew, npm -g, etc.
 * won't be found by `which`. We fix this by appending common install
 * locations to the PATH used for detection and spawning.
 */
const EXTRA_PATHS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  `${process.env.HOME}/.npm-global/bin`,
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.nvm/current/bin`,
  `${process.env.HOME}/.volta/bin`,
  `${process.env.HOME}/.cargo/bin`,
  '/usr/local/share/npm/bin',
];

function getEnhancedPath() {
  const currentPath = process.env.PATH || '';
  const extra = EXTRA_PATHS.filter((p) => !currentPath.includes(p));
  return extra.length > 0 ? `${currentPath}:${extra.join(':')}` : currentPath;
}

// Apply the enhanced PATH to the process so child_process.spawn also sees it
process.env.PATH = getEnhancedPath();

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
    // claude -p "prompt" OR echo "prompt" | claude -p
    // Using stdin piping to avoid shell escaping issues with large prompts
    buildCmd: (_prompt, model) => {
      const args = ['-p', '--verbose'];
      if (model) args.push('--model', model);
      return { command: 'claude', args, stdinPrompt: true };
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
    buildCmd: (_prompt, model) => {
      const args = ['--quiet'];
      if (model) args.push('--model', model);
      return { command: 'codex', args, stdinPrompt: true };
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
      const cmd = resolvedCli || 'auggie';
      const args = ['run'];
      if (model && model !== 'default') args.push('--model', model);
      return { command: cmd, args, stdinPrompt: true };
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
    this._resolvedCli = {}; // agentId → actual command name found

    for (const agent of AGENTS) {
      const cliNames = Array.isArray(agent.cli) ? agent.cli : [agent.cli];
      let found = false;

      for (const name of cliNames) {
        if (AgentRegistry._isInstalled(name)) {
          this._cache[agent.id] = true;
          this._resolvedCli[agent.id] = name;
          console.log(`[LGTM] Agent "${agent.name}" found via: ${name}`);
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
   */
  buildCommand(agentId, prompt, model) {
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const resolvedCli = this._resolvedCli ? this._resolvedCli[agentId] : null;
    return agent.buildCmd(prompt, model, resolvedCli);
  }

  /**
   * Check if a CLI command exists on the PATH.
   */
  static _isInstalled(command) {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${which} ${command}`, {
        timeout: 5000,
        encoding: 'utf8',
        env: { ...process.env },   // uses the enhanced PATH
      }).trim();
      console.log(`[LGTM]   which ${command} → ${result}`);
      return true;
    } catch {
      console.log(`[LGTM]   which ${command} → not found`);
      return false;
    }
  }
}

module.exports = { AgentRegistry, AGENTS };
