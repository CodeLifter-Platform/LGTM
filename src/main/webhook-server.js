/**
 * WebhookServer — Lightweight HTTP server that receives Azure DevOps
 * Service Hook events for real-time PR updates.
 *
 * Setup in Azure DevOps:
 *   Project Settings → Service Hooks → Create subscription
 *   → Web Hooks → trigger on "Pull request created / updated / merge attempted"
 *   → URL: http://<your-machine>:<port>/webhook
 *   → (optional) HTTP header `X-LGTM-Webhook-Secret: <your secret>`
 *
 * Trust boundary:
 *   - Binds to loopback (127.0.0.1) by default. Azure DevOps cannot reach
 *     a laptop directly anyway; the supported path is a tunnel (ngrok,
 *     Cloudflare Tunnel) that forwards to localhost. Set `webhookHost` to
 *     '0.0.0.0' only when the machine is meant to accept LAN traffic.
 *   - When a `secret` is configured, POST /webhook must carry it in
 *     `X-LGTM-Webhook-Secret`; a missing or wrong value is a 401, compared
 *     in constant time. GET /health stays open: it is the "is LGTM up"
 *     probe and carries nothing.
 *   - Bodies above `maxBodyBytes` (1 MiB default) are refused with 413 and
 *     the connection dropped; a real service-hook payload is a few KB.
 *   - Anything else is a 404.
 */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SECRET_HEADER = 'x-lgtm-webhook-secret';

/** Constant-time, exact-match comparison of two secrets of any length. */
function secretsMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(a, b) && expected.length === provided.length;
}

class WebhookServer {
  /**
   * @param {number} port          - Port to listen on (0 = any free port; `start()` resolves the real one)
   * @param {function} onEvent     - Callback invoked with each parsed event payload
   * @param {object} [opts]
   * @param {string} [opts.host]          - bind address, default loopback
   * @param {string} [opts.secret]        - shared secret required on POST /webhook when non-empty
   * @param {number} [opts.maxBodyBytes]  - request body cap
   * @param {function} [opts.log]
   */
  constructor(port, onEvent, { host = DEFAULT_HOST, secret = '', maxBodyBytes = DEFAULT_MAX_BODY_BYTES, log = console.log } = {}) {
    this.port = port;
    this.host = host;
    this.secret = secret || '';
    this.maxBodyBytes = maxBodyBytes;
    this.onEvent = onEvent;
    this.log = log;
    this.server = null;
    this._starting = null;
  }

  /** @returns {Promise<number>} the bound port; rejects if listening fails */
  start() {
    if (this._starting) return this._starting;

    const server = http.createServer((req, res) => this._handle(req, res));
    this.server = server;

    this._starting = new Promise((resolve, reject) => {
      const onError = (err) => {
        this.log(`[LGTM] Webhook server error: ${err.message}`);
        this.server = null;
        this._starting = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        server.on('error', (err) => this.log(`[LGTM] Webhook server error: ${err.message}`));
        const bound = server.address().port;
        this.port = bound;
        this.log(`[LGTM] Webhook server listening on ${this.host}:${bound}`);
        resolve(bound);
      });
    });
    return this._starting;
  }

  /** @returns {Promise<void>} */
  stop() {
    const server = this.server;
    this.server = null;
    this._starting = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  _handle(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      return json(200, { status: 'ok', app: 'lgtm' });
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      if (this.secret && !secretsMatch(this.secret, req.headers[SECRET_HEADER] || '')) {
        return json(401, { error: 'Missing or invalid webhook secret' });
      }

      const chunks = [];
      let received = 0;
      let refused = false;
      req.on('data', (chunk) => {
        if (refused) return;
        received += chunk.length;
        if (received > this.maxBodyBytes) {
          refused = true;
          // Answer, then drop the connection once the answer is flushed so
          // the sender cannot keep streaming into a socket we hold open.
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: `Body exceeds ${this.maxBodyBytes} bytes` }), () => req.socket.destroy());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (refused) return;
        let event;
        try {
          event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(400, { error: 'Invalid JSON' });
        }
        try { this.onEvent(event); } catch (err) { this.log(`[LGTM] webhook handler threw: ${err.message}`); }
        json(200, { received: true });
      });
      return undefined;
    }

    res.writeHead(404);
    res.end();
    return undefined;
  }
}

module.exports = { WebhookServer, secretsMatch, SECRET_HEADER, DEFAULT_HOST, DEFAULT_MAX_BODY_BYTES };
