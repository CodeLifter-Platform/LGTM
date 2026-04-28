// EventStreamParser — consumes container stdout/stderr, emits parsed JSONL events.
//
// Why a class: dockerode's demuxStream needs writable streams; we expose
// them as adapters around a shared line-buffer + parser.

const { EventEmitter } = require('events');
const { Writable } = require('stream');

const SECRET_PATTERNS = [
  // Bearer tokens (ADO Entra)
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  // Anthropic keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI keys
  /sk-[A-Za-z0-9]{20,}/g,
  // ADO PATs (52 base64-ish chars)
  /\b[A-Za-z0-9]{52}\b/g,
];

function redact(text) {
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

class EventStreamParser extends EventEmitter {
  constructor({ runId }) {
    super();
    this.runId = runId;
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._lastDone = null;
  }

  /** Writable stream adapter for container stdout. */
  stdoutStream() {
    return new Writable({
      write: (chunk, _enc, cb) => {
        this._handleStdout(chunk.toString());
        cb();
      },
    });
  }

  /** Writable stream adapter for container stderr. */
  stderrStream() {
    return new Writable({
      write: (chunk, _enc, cb) => {
        this._handleStderr(chunk.toString());
        cb();
      },
    });
  }

  _handleStdout(text) {
    this._stdoutBuf += text;
    let nl;
    while ((nl = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, nl);
      this._stdoutBuf = this._stdoutBuf.slice(nl + 1);
      if (line.trim() === '') continue;
      this._processLine(line);
    }
  }

  _handleStderr(text) {
    this._stderrBuf += text;
    let nl;
    while ((nl = this._stderrBuf.indexOf('\n')) >= 0) {
      const line = this._stderrBuf.slice(0, nl);
      this._stderrBuf = this._stderrBuf.slice(nl + 1);
      if (line.trim() === '') continue;
      this.emit('event', {
        ts: Date.now(),
        runId: this.runId,
        type: 'raw',
        level: 'stderr',
        text: redact(line),
      });
    }
  }

  _processLine(line) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      // Not JSON — treat as raw stdout
      this.emit('event', {
        ts: Date.now(),
        runId: this.runId,
        type: 'raw',
        level: 'stdout',
        text: redact(line),
      });
      return;
    }

    // Redact any string values to avoid leaking secrets we missed elsewhere
    redactInPlace(evt);

    if (evt.type === 'run_done') {
      this._lastDone = evt;
    }

    this.emit('event', evt);
  }

  /** Force-flush any partial buffered line at end of stream. */
  flush() {
    if (this._stdoutBuf.trim()) {
      this._processLine(this._stdoutBuf);
      this._stdoutBuf = '';
    }
    if (this._stderrBuf.trim()) {
      this.emit('event', {
        ts: Date.now(),
        runId: this.runId,
        type: 'raw',
        level: 'stderr',
        text: redact(this._stderrBuf),
      });
      this._stderrBuf = '';
    }
  }

  lastDoneEvent() {
    return this._lastDone;
  }
}

function redactInPlace(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      obj[k] = redact(v);
    } else if (typeof v === 'object') {
      redactInPlace(v);
    }
  }
}

module.exports = { EventStreamParser };
