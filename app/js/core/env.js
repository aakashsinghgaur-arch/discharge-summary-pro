// Runtime configuration. /config.js is generated at build time from environment
// variables (scripts/build.mjs) and only ever contains PUBLIC values:
// the Supabase project URL and the publishable (anon) key. Never a secret key.
const C = window.DSP_CONFIG || {};

export const config = Object.freeze({
  supabaseUrl: String(C.supabaseUrl || '').replace(/\/+$/, ''),
  supabaseKey: String(C.supabaseKey || ''),
  appEnv: C.appEnv || 'development',
  // Where unsaved edits are kept while the server cannot be reached:
  //   'off'     – memory of the open tab only (closing the tab warns first)
  //   'session' – this browser tab (survives reload/crash-restore, cleared when the tab closes)  [default]
  //   'local'   – this browser profile until saved/discarded (requires institutional approval)
  recoveryCache: ['off', 'session', 'local'].includes(C.recoveryCache) ? C.recoveryCache : 'session',
  idleSignoutMinutes: Number.isFinite(+C.idleSignoutMinutes) ? +C.idleSignoutMinutes : 120,
  autosaveDelayMs: Number.isFinite(+C.autosaveDelayMs) ? +C.autosaveDelayMs : 2500,
  leaseRenewMs: 60_000,
  editIdleReleaseMinutes: Number.isFinite(+C.editIdleReleaseMinutes) ? +C.editIdleReleaseMinutes : 20,
  functionsUrl: C.functionsUrl || (C.supabaseUrl ? String(C.supabaseUrl).replace(/\/+$/, '') + '/functions/v1' : ''),
  embedRestoreDataDefault: C.embedRestoreDataDefault !== false,
});

export const isConfigured = () => !!(config.supabaseUrl && config.supabaseKey);
