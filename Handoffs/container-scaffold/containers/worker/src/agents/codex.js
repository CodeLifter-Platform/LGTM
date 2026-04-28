// Codex agent driver — STUB.
// Same interface as claude.js. Fill in once the codex CLI is installed
// in the Dockerfile and you've verified its non-interactive flags.
//
// What needs filling in:
//   1. Uncomment the codex install line in the Dockerfile
//   2. Replace `<flags>` below with the correct codex CLI flags (especially --model)
//   3. Adapt forwardCodexEvent to whatever output format codex uses
//   4. Confirm OPENAI_API_KEY is the right env var name
//   5. Verify SUPPORTED_MODELS matches what `codex --list-models` reports

const { spawn } = require('child_process');

// Placeholder model list. Confirm against `codex --help` / docs when wiring up.
// Likely candidates as of writing: gpt-5, gpt-5-mini, gpt-5-codex.
// Source of truth must be checked when this driver is actually filled in.
const SUPPORTED_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
];

const DEFAULT_MODEL = 'gpt-5-codex';

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
    const proc = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', () => resolve(out.trim() || 'stub'));
    proc.on('error', () => resolve('not-installed'));
  });
}

async function run({ context, prompt, mcpConfigPath, workingDir }) {
  throw new Error(
    'Codex driver is a stub. See containers/worker/src/agents/codex.js for what to fill in.',
  );

  // Reference shape — uncomment + adjust when ready:
  //
  // const model = context.model;
  // return new Promise((resolve, reject) => {
  //   const proc = spawn('codex', [
  //     '--model', model,                 // confirm flag name
  //     '--mcp-config', mcpConfigPath,
  //     // <other flags for non-interactive, JSON output, allowed tools>
  //   ], {
  //     cwd: workingDir,
  //     env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  //     stdio: ['pipe', 'pipe', 'pipe'],
  //   });
  //
  //   proc.stdin.write(prompt);
  //   proc.stdin.end();
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
