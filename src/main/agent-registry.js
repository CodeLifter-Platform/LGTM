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

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    models: [
      { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ],
    buildCmd: (prompt, model) => {
      const args = ['--print', '--prompt', prompt];
      if (model) args.push('--model', model);
      return { command: 'claude', args };
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
    buildCmd: (prompt, model) => {
      const args = ['--quiet', '--prompt', prompt];
      if (model) args.push('--model', model);
      return { command: 'codex', args };
    },
  },
  {
    id: 'augment',
    name: 'Augment Code',
    cli: ['auggie', 'augment', 'aug', 'augment-code', 'augcode'],  // try multiple names
    models: [
      { id: 'default', label: 'Default' },
    ],
    buildCmd: (prompt, model, resolvedCli) => {
      const cmd = resolvedCli || 'augment';
      const args = ['run', '--prompt', prompt];
      if (model && model !== 'default') args.push('--model', model);
      return { command: cmd, args };
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
      const result = execSync(`${which} ${command}`, { timeout: 5000, encoding: 'utf8' }).trim();
      console.log(`[LGTM]   which ${command} → ${result}`);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { AgentRegistry, AGENTS };
