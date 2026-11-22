// Local recovery cache for edits that have not reached the server yet.
// It is NEVER the authoritative record; the server is. Storage location is set by
// config.recoveryCache ('off' | 'session' | 'local'); see docs/SECURITY.md.
import { config } from './env.js';

const store = () => {
  try { return config.recoveryCache === 'local' ? localStorage : config.recoveryCache === 'session' ? sessionStorage : null; }
  catch { return null; }
};
const key = (userId, docId) => `dsp_rec:${userId}:${docId}`;
const memory = new Map();   // 'off' mode still keeps a copy for the life of the page

export const recovery = {
  put(userId, docId, entry) {
    const v = { ...entry, ts: Date.now() };
    memory.set(key(userId, docId), v);
    const s = store(); if (!s) return;
    try { s.setItem(key(userId, docId), JSON.stringify(v)); } catch { /* quota: memory copy remains */ }
  },
  get(userId, docId) {
    const s = store();
    try { const raw = s?.getItem(key(userId, docId)); if (raw) return JSON.parse(raw); } catch { /* ignore */ }
    return memory.get(key(userId, docId)) || null;
  },
  clear(userId, docId) {
    memory.delete(key(userId, docId));
    try { store()?.removeItem(key(userId, docId)); } catch { /* ignore */ }
  },
  where() {
    return config.recoveryCache === 'local' ? 'in this browser' : config.recoveryCache === 'session' ? 'in this browser tab' : 'on this page only';
  },
};
