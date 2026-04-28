// JSONL event emitter.
// Every event is a single JSON object on its own line.
// Stdout writes are direct (no console.log) to keep buffering predictable.

const RUN_ID = process.env.LGTM_RUN_ID || 'unknown';

function write(obj) {
  // Single line, ensure trailing newline, never throw if stdout is closed
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    // Stdout may be closed during shutdown; swallow to avoid crashing the process
  }
}

function emit(type, payload = {}) {
  write({
    ts: Date.now(),
    runId: RUN_ID,
    type,
    ...payload,
  });
}

function emitError(message, extra = {}) {
  emit('error', { message, ...extra });
}

function emitDone(success, summary = '') {
  emit('run_done', { success, summary });
}

function emitToolUse(tool, args = {}) {
  emit('tool_use', { tool, args });
}

function emitToolResult(tool, success, bytes = 0) {
  emit('tool_result', { tool, success, bytes });
}

function emitProgress(message, percent = null) {
  emit('progress', { message, percent });
}

function emitArtifact(kind, path) {
  emit('artifact', { kind, path });
}

function emitGitOp(op, target, durationMs) {
  emit('git_op', { op, target, durationMs });
}

module.exports = {
  emit,
  emitError,
  emitDone,
  emitToolUse,
  emitToolResult,
  emitProgress,
  emitArtifact,
  emitGitOp,
};
