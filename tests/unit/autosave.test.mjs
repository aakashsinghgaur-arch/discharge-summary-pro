// Unit tests for the autosave state machine (no browser, fake timers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosaver } from '../../app/js/core/autosave.js';

function fakeTimers() {
  let now = 0, id = 0; const q = new Map();
  return {
    setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => q.delete(i),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; await next[1].fn(); await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}
const err = (code, detail) => Object.assign(new Error(code), { code, detail });

function setup(saveImpl) {
  const timers = fakeTimers(), states = [], persisted = [], stops = [];
  const s = new Autosaver({ save: saveImpl, delay: 2500, timers, onStatus: (st) => states.push(st), onStop: (c) => stops.push(c),
    persist: (j) => persisted.push(j), unpersist: () => persisted.push(null) });
  s.setBaseline('{"a":1}', 1);
  return { s, timers, states, persisted, stops };
}

test('debounces a burst of changes into one save with the current version', async () => {
  const calls = [];
  const { s, timers, states } = setup(async (json, v, reason) => { calls.push({ json, v, reason }); return { version: v + 1 }; });
  s.change('{"a":2}'); await timers.advance(1000); s.change('{"a":3}'); await timers.advance(1000);
  assert.equal(calls.length, 0);
  await timers.advance(2600);
  assert.deepEqual(calls, [{ json: '{"a":3}', v: 1, reason: 'autosave' }]);
  assert.equal(s.version, 2); assert.equal(s.state, 'saved'); assert.equal(s.dirty, false);
  assert.ok(states.includes('dirty') && states.includes('saving'));
});

test('reverting to the saved content needs no save', async () => {
  const calls = [];
  const { s, timers } = setup(async () => { calls.push(1); return { version: 2 }; });
  s.change('{"a":2}'); s.change('{"a":1}');
  await timers.advance(5000);
  assert.equal(calls.length, 0); assert.equal(s.state, 'saved');
});

test('network failure → offline, kept dirty, backoff retry, then saved', async () => {
  let fail = true; const calls = [];
  const { s, timers, persisted } = setup(async (j, v) => { calls.push(v); if (fail) throw err('network'); return { version: v + 1 }; });
  s.change('{"a":2}');
  await timers.advance(2600);
  assert.equal(s.state, 'offline'); assert.equal(s.dirty, true);
  assert.equal(persisted.at(-1), '{"a":2}');
  fail = false;
  await timers.advance(5000);
  assert.equal(s.state, 'saved'); assert.equal(s.dirty, false); assert.equal(persisted.at(-1), null);
});

test('conflict stops autosave and never marks the change as saved', async () => {
  const { s, timers, stops } = setup(async () => { throw err('conflict', { server_version: 9 }); });
  s.change('{"a":2}');
  await timers.advance(2600);
  assert.equal(s.state, 'conflict'); assert.equal(s.dirty, true); assert.deepEqual(stops, ['conflict']);
  s.change('{"a":3}'); await timers.advance(10000);
  assert.equal(s.current, '{"a":2}', 'changes after a stop are not sent anywhere');
});

test('expired lease with no other holder is re-acquired transparently', async () => {
  let n = 0;
  const timers = fakeTimers();
  const s = new Autosaver({ timers, delay: 100, save: async (j, v) => { n++; if (n === 1) throw err('lease_lost', { editor_name: null }); return { version: v + 1 }; }, onLeaseExpired: async () => true });
  s.setBaseline('{}', 1); s.change('{"x":1}');
  await timers.advance(1000);
  assert.equal(n, 2); assert.equal(s.state, 'saved');
});

test('lease taken by someone else stops editing', async () => {
  const { s, timers, stops } = setup(async () => { throw err('lease_lost', { editor_name: 'Dr X' }); });
  s.onLeaseExpired = async () => true;
  s.change('{"a":2}'); await timers.advance(3000);
  assert.deepEqual(stops, ['lease_lost']); assert.equal(s.state, 'locked');
});

test('explicit checkpoint is sent with its reason even without new edits', async () => {
  const calls = [];
  const { s } = setup(async (j, v, r) => { calls.push(r); return { version: v + 1 }; });
  s.checkpoint('manual');
  assert.equal(await s.flush(), true);
  assert.deepEqual(calls, ['manual']);
});

test('generic error shows "error" and waits for a manual retry', async () => {
  let fail = true;
  const { s, timers } = setup(async (j, v) => { if (fail) throw err('unknown'); return { version: v + 1 }; });
  s.change('{"a":2}'); await timers.advance(2600);
  assert.equal(s.state, 'error'); await timers.advance(60000); assert.equal(s.state, 'error');
  fail = false; await s.retryNow();
  assert.equal(s.state, 'saved');
});
