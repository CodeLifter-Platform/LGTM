// Mode factory.
// Each mode implements run({ context, agent }): Promise<{ summary }>.
// Modes are agent-agnostic — they build a prompt + working dir, then hand off.

const review = require('./review');
const implement = require('./implement');

const REGISTRY = { review, implement };

function loadMode(name) {
  const mode = REGISTRY[name];
  if (!mode) {
    throw new Error(
      `Unknown mode: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return mode;
}

module.exports = { loadMode };
