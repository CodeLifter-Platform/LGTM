// AgentCatalog — orchestrator-side mirror of what each agent supports.
//
// Why this exists separately from the worker's agents/ folder:
//   - Renderer needs to populate model picker UIs without spawning a container
//   - Orchestrator needs to validate a RunSpec before paying for a container start
//   - Keeping it as a static catalog means no Docker dependency at config time
//
// Keep this in sync with containers/worker/src/agents/*.js. There's a unit-test-
// shaped sanity check at the bottom of this file you can run manually.

const BUILTIN = {
  claude: {
    label: 'Claude (Anthropic)',
    secretField: 'anthropicApiKey',
    default: 'claude-sonnet-4-6',
    supported: [
      // Full IDs
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      // Aliases
      'opus',
      'sonnet',
      'haiku',
      'opusplan',
    ],
    // Model metadata for UI display. Optional.
    modelMeta: {
      'claude-opus-4-7':   { tier: 'flagship', contextWindow: 1_000_000, costNote: '$$$' },
      'claude-opus-4-6':   { tier: 'flagship', contextWindow: 1_000_000, costNote: '$$$' },
      'claude-sonnet-4-6': { tier: 'workhorse', contextWindow: 1_000_000, costNote: '$$' },
      'claude-haiku-4-5':  { tier: 'fast',     contextWindow: 200_000,   costNote: '$' },
      'opusplan':          { tier: 'hybrid',    note: 'Opus plans, Sonnet executes' },
    },
  },
  codex: {
    label: 'Codex (OpenAI)',
    secretField: 'openaiApiKey',
    default: 'gpt-5-codex',
    supported: ['gpt-5', 'gpt-5-codex', 'gpt-5-mini'],
    modelMeta: {
      'gpt-5':       { tier: 'flagship' },
      'gpt-5-codex': { tier: 'workhorse', note: 'Tuned for coding' },
      'gpt-5-mini':  { tier: 'fast' },
    },
    note: 'Driver is a stub. Update SUPPORTED list in agents/codex.js when wiring up.',
  },
  auggie: {
    label: 'AugmentCode (Auggie)',
    secretField: 'augmentApiKey',
    default: 'auggie-default',
    supported: ['auggie-default', 'claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5'],
    modelMeta: {
      'auggie-default': { note: 'Whatever AugmentCode auto-selects' },
    },
    note: 'Driver is a stub. AugmentCode may set model via config file rather than --model flag.',
  },
};

class AgentCatalog {
  constructor(catalog) {
    this._catalog = catalog;
  }

  static builtin() {
    return new AgentCatalog(BUILTIN);
  }

  agents() {
    return Object.keys(this._catalog);
  }

  has(agent) {
    return Object.prototype.hasOwnProperty.call(this._catalog, agent);
  }

  defaultModel(agent) {
    this._requireAgent(agent);
    return this._catalog[agent].default;
  }

  supportedModels(agent) {
    this._requireAgent(agent);
    return [...this._catalog[agent].supported];
  }

  supports(agent, model) {
    if (!this.has(agent)) return false;
    return this._catalog[agent].supported.includes(model);
  }

  /**
   * Serializable form for the renderer. Keeps secret-field names so the UI
   * can prompt for the right credentials per agent.
   */
  toJSON() {
    return JSON.parse(JSON.stringify(this._catalog));
  }

  _requireAgent(agent) {
    if (!this.has(agent)) {
      throw new Error(
        `Unknown agent: ${agent}. Known: ${this.agents().join(', ')}`,
      );
    }
  }
}

module.exports = { AgentCatalog };
