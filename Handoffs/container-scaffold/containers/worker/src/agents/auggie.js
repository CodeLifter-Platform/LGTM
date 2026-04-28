// Auggie (AugmentCode CLI) agent driver — STUB.
// Same interface as claude.js. Fill in once auggie is installed
// in the Dockerfile and you've confirmed the headless invocation pattern.
//
// What needs filling in:
//   1. Uncomment the auggie install line in the Dockerfile
//   2. Confirm auggie's non-interactive flags (likely `--print` or similar)
//   3. Wire up its MCP config path argument
//   4. Confirm whether auggie exposes a --model flag, or whether model is
//      configured via ~/.augmentcode/config.yaml. If the latter, this driver
//      needs to write a per-run config file before invocation.
//   5. Adapt forwardAuggieEvent if auggie emits structured output
//   6. Confirm AUGMENT_API_KEY (or whatever the auth env var is)
//   7. Verify SUPPORTED_MODELS against AugmentCode's current catalog

const { spawn } = require('child_process');

// Placeholder model list. AugmentCode supports multiple backends.
// Confirm against AugmentCode docs when filling this in.
const SUPPORTED_MODELS = [
  'auggie-default',          // whatever AugmentCode picks for you
  'claude-sonnet-4-6',       // when configured to use Anthropic
  'claude-opus-4-7',
  'gpt-5',                   // when configured to use OpenAI
];

const DEFAULT_MODEL = 'auggie-default';

function defaultModel() {
  return DEFAULT_MODEL;
}

function supportedModels() {
  return [...SUPPORTED_MODELS];
}

function supportsModel(model) {
  return SUPPORTED_MODELS.includes(model);
}

async function getVersion() {
  return new Promise((resolve) => {
    const proc = spawn('auggie', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', () => resolve(out.trim() || 'stub'));
    proc.on('error', () => resolve('not-installed'));
  });
}

async function run({ context, prompt, mcpConfigPath, workingDir }) {
  throw new Error(
    'Auggie driver is a stub. See containers/worker/src/agents/auggie.js for what to fill in.',
  );

  // Reference shape — uncomment + adjust when ready:
  //
  // const model = context.model;
  // // If auggie reads model from a config file rather than a flag, write
  // // a per-run config here:
  // //   fs.writeFileSync('/tmp/auggie-config.yaml', `model: ${model}\n`);
  //
  // return new Promise((resolve, reject) => {
  //   const proc = spawn('auggie', [
  //     '--model', model,                 // OR --config /tmp/auggie-config.yaml
  //     '--mcp-config', mcpConfigPath,
  //     // <other flags>
  //   ], { ... });
  //   ...
  // });
}

module.exports = {
  getVersion,
  defaultModel,
  supportedModels,
  supportsModel,
  run,
};
