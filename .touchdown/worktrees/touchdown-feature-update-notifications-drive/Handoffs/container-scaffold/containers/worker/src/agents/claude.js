// Claude Code agent driver.
// Shells out to the `claude` CLI installed globally in the container image.
//
// Reference: https://docs.anthropic.com/en/docs/claude-code

const { spawn } = require('child_process');
const { emit, emitToolUse, emitToolResult, emitProgress } = require('../events');

// Models supported by Claude Code as of April 2026.
// Add aliases as Anthropic ships new ones; remove deprecated ones.
//
// Source: https://code.claude.com/docs/en/model-config
const SUPPORTED_MODELS = [
  // Full model IDs
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  // Aliases that Claude Code resolves automatically
  'opus',
  'sonnet',
  'haiku',
  'opusplan',  // hybrid: opus for plan, sonnet for execution
];

const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
    const proc = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    proc.on('close', () => resolve(out.trim() || 'unknown'));
    proc.on('error', () => resolve('unknown'));
  });
}

/**
 * Run Claude Code non-interactively against a prompt with MCP config.
 *
 * @param {object} opts
 * @param {object} opts.context - shared run context (includes model)
 * @param {string} opts.prompt - full prompt to send
 * @param {string} opts.mcpConfigPath - absolute path to mcp.json
 * @param {string} opts.workingDir - cwd for the agent (usually the repo clone)
 * @returns {Promise<{ stdoutTail: string, exitCode: number }>}
 */
async function run({ context, prompt, mcpConfigPath, workingDir }) {
  const model = context.model;

  return new Promise((resolve, reject) => {
    const args = [
      '--model', model,                  // pin the specific model for this run
      '--mcp-config', mcpConfigPath,
      '--print',                         // non-interactive single-shot
      '--output-format', 'stream-json',
      '--allowedTools', 'mcp__ado',
    ];

    const env = {
      ...process.env,
      // Claude Code reads ANTHROPIC_API_KEY from env automatically.
      // Setting ANTHROPIC_MODEL is redundant when --model is passed,
      // but harmless and useful if a subagent inherits env.
      ANTHROPIC_MODEL: model,
    };

    const proc = spawn('claude', args, {
      cwd: workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdoutTail = '';
    let stderrBuf = '';
    let lineBuf = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutTail = (stdoutTail + text).slice(-8192);

      lineBuf += text;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          forwardClaudeEvent(evt);
        } catch {
          emitProgress(line.slice(0, 500));
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdoutTail, exitCode: code });
      } else {
        const err = new Error(
          `claude CLI exited ${code}: ${stderrBuf.slice(-500)}`,
        );
        err.exitCode = code;
        reject(err);
      }
    });

    proc.on('error', reject);
  });
}

function forwardClaudeEvent(evt) {
  if (!evt || typeof evt !== 'object') return;

  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_use') {
        emitToolUse(block.name, block.input || {});
      }
    }
  }

  if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        emitToolResult(block.tool_use_id || 'unknown', !block.is_error, text.length);
      }
    }
  }

  if (evt.type === 'result') {
    emit('progress', {
      message: 'agent run complete',
      durationMs: evt.duration_ms,
      tokensIn: evt.usage?.input_tokens,
      tokensOut: evt.usage?.output_tokens,
    });
  }
}

module.exports = {
  getVersion,
  defaultModel,
  supportedModels,
  supportsModel,
  run,
};
