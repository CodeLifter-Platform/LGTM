// Agent factory.
// Each agent driver implements:
//   - getVersion(): Promise<string>
//   - defaultModel(): string
//   - supportedModels(): string[]
//   - supportsModel(model): boolean
//   - run({ context, prompt, mcpConfigPath, workingDir }): Promise<{ stdoutTail }>
//
// The model catalog is the single source of truth for what each agent can do.
// Update this when new models ship.

const claude = require('./claude');
const codex = require('./codex');
const auggie = require('./auggie');

const REGISTRY = {
  claude,
  codex,
  auggie,
};

function loadAgent(name) {
  const agent = REGISTRY[name];
  if (!agent) {
    throw new Error(
      `Unknown agent: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return agent;
}

/**
 * Catalog every agent's supported models. Useful for the orchestrator's
 * UI (model picker) and for validation before container launch.
 *
 * @returns {Object<string, {default: string, supported: string[]}>}
 */
function catalog() {
  const out = {};
  for (const [name, agent] of Object.entries(REGISTRY)) {
    out[name] = {
      default: agent.defaultModel(),
      supported: agent.supportedModels(),
    };
  }
  return out;
}

module.exports = { loadAgent, catalog };
