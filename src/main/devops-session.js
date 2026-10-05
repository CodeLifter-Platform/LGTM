/**
 * DevOpsSession — owns everything that exists only while a PAT is
 * accepted: the DevOpsClient, the PR poller and the webhook server.
 *
 * `connect()` tears down whatever a previous connect created before it
 * builds the new set, so re-validating a PAT replaces the poller and the
 * webhook server instead of stacking a second interval and a second
 * listener (which then failed with EADDRINUSE and a TypeError loop once
 * clear-pat nulled the client under the old interval). `disconnect()` is
 * what clear-pat calls: it stops the poller too.
 */

const { DevOpsClient } = require('./devops-client');
const { PrPoller } = require('./pr-poller');
const { WebhookServer } = require('./webhook-server');

class DevOpsSession {
  /**
   * @param {object} deps
   * @param {(user: object|null) => void} deps.onUser
   * @param {(prs: object[]) => void} deps.onPrList
   * @param {(message: string) => void} deps.onPrError
   * @param {(event: object) => void} deps.onWebhookEvent
   * @param {(pat, orgUrl) => DevOpsClient} [deps.createClient]
   * @param {(opts) => PrPoller} [deps.createPoller]
   * @param {(port, onEvent, opts) => WebhookServer} [deps.createWebhook]
   * @param {(line: string) => void} [deps.log]
   */
  constructor({
    onUser, onPrList, onPrError, onWebhookEvent,
    createClient = (pat, orgUrl) => new DevOpsClient(pat, orgUrl),
    createPoller = (opts) => new PrPoller(opts),
    createWebhook = (port, onEvent, opts) => new WebhookServer(port, onEvent, opts),
    log = console.log,
  }) {
    this.onUser = onUser;
    this.onPrList = onPrList;
    this.onPrError = onPrError;
    this.onWebhookEvent = onWebhookEvent;
    this.createClient = createClient;
    this.createPoller = createPoller;
    this.createWebhook = createWebhook;
    this.log = log;

    this.client = null;
    this.user = null;
    this.poller = null;
    this.webhook = null;
    this._generation = 0;
  }

  get connected() {
    return this.client !== null;
  }

  /**
   * @param {object} opts
   * @param {string} opts.pat
   * @param {string} opts.orgUrl
   * @param {number} opts.pollingIntervalMs
   * @param {number} opts.webhookPort
   * @param {string} [opts.webhookHost]
   * @param {string} [opts.webhookSecret]
   * @returns {Promise<{ user: object|null }>}
   */
  async connect({ pat, orgUrl, pollingIntervalMs, webhookPort, webhookHost, webhookSecret }) {
    await this.disconnect();
    const generation = ++this._generation;

    const client = this.createClient(pat, orgUrl);
    this.client = client;

    let user = null;
    try {
      user = await client.getMe();
      this.log(`[LGTM] Authenticated as: ${user.displayName || user.email || user.id}`);
    } catch (err) {
      this.log(`[LGTM] Could not resolve current user: ${err.message}`);
    }
    // A second connect (or a disconnect) raced us while getMe was in flight:
    // the newer one owns the session; drop what we built.
    if (generation !== this._generation) return { user: null, superseded: true };

    this.user = user;
    this.onUser(user);

    this.poller = this.createPoller({
      fetch: () => client.getAllOpenPRs(),
      intervalMs: pollingIntervalMs,
      onList: (prs) => this.onPrList(prs),
      onError: (message) => this.onPrError(message),
      log: this.log,
    });
    this.poller.start();

    this.webhook = this.createWebhook(webhookPort, (event) => this.onWebhookEvent(event), {
      host: webhookHost,
      secret: webhookSecret,
      log: this.log,
    });
    try {
      await this.webhook.start();
    } catch (err) {
      this.log(`[LGTM] Webhook server could not start on ${webhookHost || 'loopback'}:${webhookPort}: ${err.message}`);
    }
    return { user };
  }

  /** Stop polling and listening; forget the client. Safe to call twice. */
  async disconnect() {
    this._generation += 1;
    const { poller, webhook } = this;
    this.poller = null;
    this.webhook = null;
    this.client = null;
    this.user = null;
    if (poller) poller.stop();
    if (webhook) await webhook.stop();
  }

  /** Re-poll now (webhook event, manual refresh). No-op when disconnected. */
  pollNow() {
    return this.poller ? this.poller.pollNow() : Promise.resolve();
  }
}

module.exports = { DevOpsSession };
