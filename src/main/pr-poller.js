/**
 * PrPoller — polls the PR list on an interval and reports each outcome.
 *
 * Failure contract (the Failure-paths row of the test standard): a fetch
 * that throws calls `onError(message)` and leaves `lastPrs` as it was, so
 * the renderer keeps showing the last good list; the next successful fetch
 * calls `onList(prs)` and clears `lastError`. Overlapping polls are
 * coalesced: a slow fetch is never stacked under the next tick.
 *
 * `start()` is idempotent in effect — calling it again replaces the
 * interval instead of adding a second one, which is how validate-pat used
 * to leak a timer per re-validation.
 */
class PrPoller {
  /**
   * @param {object} deps
   * @param {() => Promise<object[]>} deps.fetch
   * @param {number} deps.intervalMs
   * @param {(prs: object[]) => void} deps.onList
   * @param {(message: string) => void} deps.onError
   * @param {(line: string) => void} [deps.log]
   */
  constructor({ fetch, intervalMs, onList, onError, log = () => {} }) {
    this.fetch = fetch;
    this.intervalMs = intervalMs;
    this.onList = onList;
    this.onError = onError;
    this.log = log;
    this.timer = null;
    this.inFlight = null;
    this.lastPrs = null;
    this.lastError = null;
    this.polls = 0;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => { this.pollNow(); }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.pollNow();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running() {
    return this.timer !== null;
  }

  /** Run one poll now; resolves when it has reported. Coalesces overlaps. */
  pollNow() {
    if (this.inFlight) return this.inFlight;
    this.polls += 1;
    this.inFlight = (async () => {
      try {
        const prs = await this.fetch();
        this.lastPrs = prs;
        this.lastError = null;
        this.onList(prs);
      } catch (err) {
        const message = (err && err.message) || String(err);
        this.lastError = message;
        this.log(`[LGTM] PR poll failed: ${message}`);
        this.onError(message);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}

module.exports = { PrPoller };
