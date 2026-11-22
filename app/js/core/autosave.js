// Debounced, versioned autosave with explicit states. Framework-free and DOM-free so it
// can be unit-tested (tests/unit/autosave.test.mjs).
//
// States: 'saved' | 'dirty' | 'saving' | 'offline' | 'error' | 'conflict' | 'locked' | 'auth'
// A failed save never shows as saved; nothing is ever discarded automatically.
export class Autosaver {
  constructor({ save, delay = 2500, onStatus = () => {}, onStop = () => {}, onAuth = () => {}, onLeaseExpired = null, persist = () => {}, unpersist = () => {}, maxBackoff = 60_000, timers = globalThis }) {
    Object.assign(this, { save, delay, onStatus, onStop, onAuth, onLeaseExpired, persist, unpersist, maxBackoff, timers });
    this.saved = null; this.current = null; this.version = 0;
    this.inflight = null; this.again = false; this.timer = null; this.retries = 0;
    this.stopped = false; this.state = 'saved'; this.lastSavedAt = null; this.nextReason = 'autosave';
  }

  setBaseline(json, version) { this.saved = json; this.current = json; this.version = version; this.status('saved'); }
  get dirty() { return this.current !== this.saved; }

  status(state, extra = {}) { this.state = state; this.onStatus(state, { ...extra, version: this.version, lastSavedAt: this.lastSavedAt, retries: this.retries }); }

  change(json) {
    if (this.stopped) return;
    this.current = json;
    if (!this.dirty) {
      if (!this.inflight && this.state !== 'saved') this.status('saved');
      this.unpersist();
      return;
    }
    this.persist(json, this.version);
    if (!this.inflight && !['offline', 'error', 'auth'].includes(this.state)) this.status('dirty');
    if (!['offline', 'auth'].includes(this.state)) this.schedule(this.delay);
  }

  schedule(ms) { this.timers.clearTimeout(this.timer); this.timer = this.timers.setTimeout(() => this.flush(), ms); }

  // Mark the next save as an explicit checkpoint (server snapshots before/after).
  checkpoint(reason = 'manual') { this.nextReason = reason; }

  async flush() {
    if (this.stopped) return false;
    if (this.inflight) { this.again = true; return this.inflight.then(() => !this.dirty); }
    this.timers.clearTimeout(this.timer);
    if (!this.dirty && this.nextReason === 'autosave') { if (this.state !== 'saved') this.status('saved'); return true; }
    const json = this.current, reason = this.nextReason;
    this.nextReason = 'autosave';
    this.status('saving');
    let ok = false;
    this.inflight = (async () => {
      try {
        const r = await this.save(json, this.version, reason);
        this.version = r.version; this.saved = json; this.retries = 0; this.lastSavedAt = r.updated_at || new Date().toISOString();
        ok = true;
        if (this.dirty) { this.status('dirty'); this.schedule(400); }
        else { this.status('saved'); this.unpersist(); }
      } catch (e) {
        if (reason !== 'autosave') this.nextReason = reason;
        this.handleError(e);
      }
    })();
    try { await this.inflight; } finally { this.inflight = null; }
    if (this.again && !this.stopped) { this.again = false; if (this.dirty && ['dirty', 'saved'].includes(this.state)) return this.flush(); }
    return ok && !this.dirty;
  }

  handleError(e) {
    const code = e?.code || 'unknown';
    if (code === 'network') {
      this.retries++;
      this.status('offline');
      this.schedule(Math.min(this.maxBackoff, 2000 * 2 ** Math.min(this.retries, 5)));
    } else if (code === 'auth') {
      this.status('auth'); this.onAuth(e);
    } else if (code === 'lease_lost' && this.onLeaseExpired && !e.detail?.editor_name) {
      // Our lease simply expired (e.g. long offline period) and nobody else holds it:
      // re-acquire quietly and retry. Version checks still prevent overwriting newer work.
      this.status('saving');
      this.onLeaseExpired().then((ok) => { if (ok) { this.schedule(0); } else this.stop('lease_lost', e); }, () => this.stop('lease_lost', e));
    } else if (['conflict', 'lease_lost', 'not_editable', 'forbidden', 'not_found', 'inactive'].includes(code)) {
      this.stop(code, e);
    } else if (code === 'rate_limited') {
      this.status('error', { message: e.message }); this.schedule(30_000);
    } else {
      this.status('error', { message: e?.message || 'Save failed' });
    }
  }

  stop(code, e) {
    this.stopped = true; this.timers.clearTimeout(this.timer);
    this.status(code === 'conflict' ? 'conflict' : 'locked', { code, message: e?.message });
    this.onStop(code, e);
  }

  retryNow() { if (!this.stopped && this.dirty) { this.retries = Math.max(0, this.retries - 1); return this.flush(); } return Promise.resolve(true); }
  resume() { this.stopped = false; return this.retryNow(); }
}
