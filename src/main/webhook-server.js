/**
 * WebhookServer — Lightweight HTTP server that receives Azure DevOps
 * Service Hook events for real-time PR updates.
 *
 * Setup in Azure DevOps:
 *   Project Settings → Service Hooks → Create subscription
 *   → Web Hooks → trigger on "Pull request created / updated / merge attempted"
 *   → URL: http://<your-machine>:<port>/webhook
 *
 * For local dev you can use a tunnel (ngrok, Cloudflare Tunnel, etc.)
 * to expose this port externally.
 */

const http = require('http');

class WebhookServer {
  /**
   * @param {number} port       - Port to listen on
   * @param {function} onEvent  - Callback invoked with each parsed event payload
   */
  constructor(port, onEvent) {
    this.port = port;
    this.onEvent = onEvent;
    this.server = null;
  }

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', app: 'lgtm' }));
        return;
      }

      // Webhook endpoint
      if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const event = JSON.parse(body);
            this.onEvent(event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`[LGTM] Webhook server listening on port ${this.port}`);
    });

    this.server.on('error', (err) => {
      console.error('[LGTM] Webhook server error:', err.message);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = { WebhookServer };
