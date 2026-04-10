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
      { id: 'opus',   label: 'Claude Opus 4' },
      { id: 'sonnet', label: 'Claude Sonnet 4' },
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
    cli: 'augment',
    models: [
      { id: 'default', label: 'Default' },
    ],
    buildCmd: (prompt, model) => {
      // Augment CLI — adjust flags as their CLI evolves
      const args = ['run', '--prompt', prompt];
      if (model && model !== 'default') args.push('--model', model);
      return { command: 'augment', args };
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
    this._cache = {};
    for (const agent of AGENTS) {
      this._cache[agent.id] = AgentRegistry._isInstalled(agent.cli);
    }
    return this._cache;
  }

  /**
   * Build the shell command + args for a given agent and prompt.
   */
  buildCommand(agentId, prompt, model) {
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent.buildCmd(prompt, model);
  }

  /**
   * Check if a CLI command exists on the PATH.
   */
  static _isInstalled(command) {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      execSync(`${which} ${command}`, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { AgentRegistry, AGENTS };
