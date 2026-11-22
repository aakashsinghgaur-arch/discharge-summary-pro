// =============================================================================
// Editor shell: wraps the ORIGINAL clinical form engine (js/form-engine.js) with
// sign-in, document loading, editing leases, autosave, recovery, sharing, history
// and the review/finalisation workflow. The engine is told about the cloud through
// window.DSP (see the "DSP-CLOUD" patches at the top of form-engine.js).
// =============================================================================
import { requireUser, mountAccountMenu, startIdleSignout } from './core/auth.js';
import { rpc, rpcKeepalive } from './core/api.js';
import { sb } from './core/supabase.js';
import { config } from './core/env.js';
import { $, $$, html, raw, esc, toast, dialog, confirmDialog, menu, debounce, statusBadge, fmtDateTime, fmtRelative, fmtTime, ACCESS, STATUS, fatal } from './core/ui.js';
import { Autosaver } from './core/autosave.js';
import { recovery } from './core/recovery.js';
import { validate, FINAL_CHECKLIST, REQUIRE_FULL_CHECKLIST } from './core/validation.js';
import { openShareDialog, pickReviewer } from './core/share.js';

const docId = (location.hash.match(/^#id=([0-9a-f-]{36})$/i) || [])[1];
const PREF_KEYS = ['dsm_hist', 'dsm_medhist', 'dsm_dict'];
const S = {
  ctx: null, st: null, mode: 'view', ro: '', holder: null, lease: null, saver: null, token: null,
  prefs: {}, lastInput: Date.now(), timers: [], recovered: null, engineReady: false,
};
const userKey = (k) => `dsp_u:${S.ctx.id}:${k}`;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!docId) { location.replace('index.html'); return; }
  S.ctx = await requireUser();
  startIdleSignout();
  mountAccountMenu($('#acct'), S.ctx);
  sb().auth.getSession().then(({ data }) => { S.token = data.session?.access_token || null; });
  sb().auth.onAuthStateChange((_e, session) => { S.token = session?.access_token || null; });

  try { S.st = await rpc('get_editor_state', { p_id: docId }); }
  catch (e) { fatal(e.code === 'not_found' ? 'This summary does not exist, or you do not have access to it.' : e.message); return; }

  const takeover = sessionStorage.getItem(`dsp_takeover:${docId}`) === '1';
  sessionStorage.removeItem(`dsp_takeover:${docId}`);
  if (canEditStatus()) {
    try {
      let l = await rpc('acquire_lease', { p_id: docId, p_takeover: takeover });
      // Same browser tab reloading (or restoring after a crash): its own previous lease may still be
      // live for a moment. sessionStorage is per tab, so this never steals from another tab or device.
      if (!l.acquired && l.held_by_me && sessionStorage.getItem(`dsp_held:${docId}`)) l = await rpc('acquire_lease', { p_id: docId, p_takeover: true });
      if (l.acquired) {
        sessionStorage.setItem(`dsp_held:${docId}`, '1');
        S.lease = { token: l.lease_token, expires: l.expires_at };
        S.mode = 'edit';
        S.st = await rpc('get_editor_state', { p_id: docId });   // latest version under our lease
      } else { S.ro = l.held_by_me ? 'self' : 'locked'; S.holder = l; }
    } catch (e) { S.ro = 'error'; toast(e.message, 'err'); }
  } else {
    S.ro = S.st.my_access === 'view' ? 'view' : (S.st.my_access === 'review' && S.st.status === 'draft') ? 'reviewer' : S.st.status;
  }

  await loadPrefs();
  const rec = recovery.get(S.ctx.id, docId);
  if (rec && !sameData(JSON.parse(rec.data), S.st.form_data)) S.recovered = rec;
  else if (rec) recovery.clear(S.ctx.id, docId);

  const boot = S.st.form_data || {};

  window.DSP = {
    bootData: () => boot,
    userKey,
    prefChanged: () => pushPrefs(),
    onSave: (d) => { if (S.saver && S.engineReady) S.saver.change(JSON.stringify(d)); },
    applyLoaded: (d, note) => onFileLoaded(d, note),
    embedRestoreData: () => S.prefs.embed ?? config.embedRestoreDataDefault,
    vendorBase: 'vendor/',
    appBarHeight: () => $('#ab')?.offsetHeight || 0,
  };

  $('#dsp-main').hidden = false;
  await loadScript('js/form-engine.js');
  $('#ed-boot').remove();
  afterEngine();
}

function canEditStatus() { return S.st.status === 'draft' && ['owner', 'edit'].includes(S.st.my_access); }

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the form. Check the connection and reload.'));
    document.body.appendChild(s);
  });
}

function afterEngine() {
  S.saver = new Autosaver({
    delay: config.autosaveDelayMs,
    save: doSave,
    onStatus: renderSave,
    onStop: onSaverStop,
    onAuth: reauthDialog,
    onLeaseExpired: reacquire,
    persist: persistLater,
    unpersist: () => { persistLater.cancel(); recovery.clear(S.ctx.id, docId); },
  });
  // Baseline = what the engine shows for the server copy. Nothing is sent until a doctor edits.
  S.saver.setBaseline(JSON.stringify(engineState()), S.st.version);
  S.engineReady = true;

  if (S.mode === 'edit') { startHeartbeat(); trackActivity(); }
  else { setReadOnly(true); S.saver.stopped = true; S.saver.status('locked'); }

  renderChrome();
  if (S.recovered) recoveryBanner();
  const flash = sessionStorage.getItem(`dsp_flash:${docId}`);
  if (flash) { sessionStorage.removeItem(`dsp_flash:${docId}`); toast(flash, 'ok', 6000); }
  wireEvents();
  logEvent('opened');
  window.growAll?.();
}

const engineState = () => window.snapshot();

// Canonical deep comparison (jsonb does not keep key order).
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sameData = (a, b) => canon(a) === canon(b);

// ---------------------------------------------------------------------------
// Saving, leases, recovery
// ---------------------------------------------------------------------------
async function doSave(json, version, reason) {
  const r = await rpc('save_document', { p_id: docId, p_expected_version: version, p_lease_token: S.lease.token, p_form_data: JSON.parse(json), p_reason: reason });
  S.lease.expires = r.lease_expires_at;
  Object.assign(S.st, { version: r.version, updated_at: r.updated_at, last_edited_by_name: S.ctx.displayName });
  renderMeta();
  return r;
}

const persistLater = debounce((json, ver) => recovery.put(S.ctx.id, docId, { data: json, baseVersion: ver }), 600);

async function reacquire() {
  try {
    const l = await rpc('acquire_lease', { p_id: docId, p_takeover: false });
    if (!l.acquired) return false;
    S.lease = { token: l.lease_token, expires: l.expires_at };
    return true;
  } catch { return false; }
}

function startHeartbeat() {
  S.timers.push(setInterval(async () => {
    if (S.mode !== 'edit' || !S.lease) return;
    try { S.lease.expires = await rpc('renew_lease', { p_id: docId, p_token: S.lease.token }); }
    catch (e) {
      if (e.code === 'lease_lost') {
        if (!e.detail?.editor_name && await reacquire()) return;
        S.saver.stop('lease_lost', e);
      } else if (['not_editable', 'forbidden', 'not_found', 'inactive'].includes(e.code)) S.saver.stop(e.code, e);
      // network errors: keep going; the lease is valid for a few minutes and is re-acquired if it lapses
    }
  }, config.leaseRenewMs));
  // Release the lease after a long idle period so colleagues are not blocked by a forgotten tab.
  S.timers.push(setInterval(() => {
    if (S.mode !== 'edit' || !config.editIdleReleaseMinutes) return;
    if (Date.now() - S.lastInput < config.editIdleReleaseMinutes * 60_000) return;
    if (S.saver.dirty || S.saver.state !== 'saved') return;
    pauseEditing();
  }, 60_000));
}

function stopEditing() {
  S.timers.forEach(clearInterval); S.timers = [];
  S.mode = 'view';
  if (S.saver) S.saver.stopped = true;
}

async function pauseEditing() {
  const token = S.lease?.token;
  stopEditing(); setReadOnly(true); S.saver.status('locked');
  S.lease = null;
  if (token) rpc('release_lease', { p_id: docId, p_token: token }).catch(() => {});
  S.ro = 'paused'; renderChrome();
}

function trackActivity() {
  const bump = () => { S.lastInput = Date.now(); };
  ['input', 'keydown', 'pointerdown'].forEach((t) => document.addEventListener(t, bump, { capture: true, passive: true }));
}

function setReadOnly(on) {
  document.body.classList.toggle('dsp-ro', on);
  $$('#form input, #form textarea, #form select, #form button').forEach((el) => {
    if (on) { if (!el.disabled) { el.disabled = true; el.dataset.dspRo = '1'; } }
    else if (el.dataset.dspRo) { el.disabled = false; delete el.dataset.dspRo; }
  });
  ['ldb', 'clr', 'chk', 'clrH'].forEach((i) => { const b = document.getElementById(i); if (b) b.disabled = on; });
  if (on) window.closeMP?.();
}

function onSaverStop(code, e) {
  stopEditing();
  setReadOnly(true);
  if (code === 'conflict') conflictDialog(e);
  else if (code === 'lease_lost') leaseLostDialog(e);
  else if (code === 'inactive') { location.replace('login.html?msg=inactive'); }
  else {
    banner('stop', 'err', `<b>Editing stopped.</b> ${esc(e?.message || '')}${S.saver.dirty ? ` Your latest changes were not saved; they are kept ${recovery.where()}.` : ''}`,
      [S.saver.dirty && { label: 'Download my changes', onClick: downloadMine }, { label: 'Reload', kind: 'primary', onClick: () => location.reload() }]);
  }
  renderChrome();
}

function conflictDialog(e) {
  const by = e?.detail?.last_edited_by_name;
  dialog({
    title: 'Conflict detected',
    dismissible: false,
    body: html`<p>This summary was changed in another session${by ? ` by <b>${by}</b>` : ''} after you opened it. To protect both sets of work, nothing was overwritten.</p>
      <p>Your unsaved changes are kept ${recovery.where()}. After reloading you can compare, restore them on top of the newer version (the newer version stays in History), or download them.</p>`,
    actions: [{ label: 'Download my changes', kind: 'ghost', onClick: () => { downloadMine(); return false; } }, { label: 'Reload latest version', kind: 'primary', onClick: () => { location.reload(); return false; } }],
  });
}

function leaseLostDialog(e) {
  const who = e?.detail?.editor_name, me = e?.detail?.held_by_me;
  const dirty = S.saver.dirty;
  dialog({
    title: me ? 'Opened for editing elsewhere' : 'Editing taken over',
    dismissible: false,
    body: html`<p>${raw(me ? 'You opened this summary for editing in another tab or device. Only one session can edit at a time.' : `<b>${esc(who || 'Another doctor')}</b> is now editing this summary.`)}</p>
      ${raw(dirty ? `<p>Your last changes could not be saved here. They are kept ${esc(recovery.where())}; download them if you need to re-enter anything.</p>` : '<p>All your changes had been saved.</p>')}`,
    actions: [
      dirty && { label: 'Download my changes', kind: 'ghost', onClick: () => { downloadMine(); return false; } },
      { label: me ? 'Edit here instead' : 'Take over editing', kind: 'ghost', onClick: () => { takeoverReload(); return false; } },
      { label: 'View latest (read-only)', kind: 'primary', onClick: () => { location.reload(); return false; } },
    ].filter(Boolean),
  });
}

function takeoverReload() { sessionStorage.setItem(`dsp_takeover:${docId}`, '1'); location.reload(); }

function reauthDialog() {
  if (document.querySelector('dialog.reauth[open]')) return null;
  const d = dialog({
    title: 'Sign in to keep saving',
    className: 'reauth',
    dismissible: false,
    body: html`<p>Your session has expired. Your changes are safe ${recovery.where()} and will be saved as soon as you sign in again.</p>
      <label for="ra-e">Email</label><input id="ra-e" type="email" value="${S.ctx.email || ''}" readonly>
      <label for="ra-p">Password</label><input id="ra-p" type="password" autocomplete="current-password"><p class="form-err" id="ra-x" role="alert"></p>`,
    actions: [{ label: 'Sign in', kind: 'primary', onClick: async (dd) => {
      const { data, error } = await sb().auth.signInWithPassword({ email: S.ctx.email, password: dd.querySelector('#ra-p').value });
      if (error) { dd.querySelector('#ra-x').textContent = /invalid/i.test(error.message) ? 'Password is incorrect.' : error.message; return false; }
      if (data.user.id !== S.ctx.id) { await sb().auth.signOut({ scope: 'local' }); location.replace('login.html'); return false; }
      S.saver.status('dirty'); S.saver.retryNow();
    } }],
    onOpen: (dd) => setTimeout(() => dd.querySelector('#ra-p').focus(), 50),
  });
  return d;
}

function recoveryBanner() {
  const r = S.recovered, when = fmtDateTime(r.ts);
  const serverChanged = r.baseVersion !== S.st.version;
  if (S.mode !== 'edit') {
    banner('rec', 'warn', `<b>Unsaved changes from ${esc(when)}</b> exist ${esc(recovery.where())}, but you cannot edit right now. Download them to keep a copy.`,
      [{ label: 'Download', onClick: () => downloadJSON(JSON.parse(r.data), 'unsaved changes') }, { label: 'Discard', kind: 'ghost', onClick: discardRecovery }]);
    return;
  }
  banner('rec', 'warn', serverChanged
    ? `<b>You have unsaved changes from ${esc(when)}</b>, but this summary was changed afterwards by ${esc(S.st.last_edited_by_name || 'someone')}. Restoring yours replaces that version (it stays in History).`
    : `<b>Unsaved changes from ${esc(when)}</b> were found ${esc(recovery.where())}. They did not reach the server.`,
  [
    { label: 'Restore my changes', kind: 'primary', onClick: () => restoreRecovery(serverChanged) },
    { label: 'Download', onClick: () => downloadJSON(JSON.parse(r.data), 'unsaved changes') },
    { label: 'Discard', kind: 'ghost', onClick: discardRecovery },
  ]);
}

async function restoreRecovery(serverChanged) {
  const data = JSON.parse(S.recovered.data);
  if (serverChanged) {
    const ok = await confirmDialog({ title: 'Restore over the newer version?', message: 'The current server version will be replaced by your unsaved copy. The replaced version is kept in History and can be restored.', okText: 'Restore my copy' });
    if (!ok) return;
  }
  try {
    await doSave(JSON.stringify(data), S.saver.version, 'restore');
    recovery.clear(S.ctx.id, docId);
    sessionStorage.setItem(`dsp_flash:${docId}`, 'Your unsaved changes were restored.');
    location.reload();
  } catch (e) { toast(e.message, 'err'); }
}

async function discardRecovery() {
  const ok = await confirmDialog({ title: 'Discard unsaved changes?', message: 'The unsaved copy kept in this browser will be deleted. The server version is not affected.', okText: 'Discard', danger: true });
  if (!ok) return;
  recovery.clear(S.ctx.id, docId); S.recovered = null; clearBanner('rec');
}

// ---------------------------------------------------------------------------
// Per-user remembered entries (private to the doctor; synced across devices)
// ---------------------------------------------------------------------------
async function loadPrefs() {
  try {
    const { data, error } = await sb().from('user_settings').select('data').eq('user_id', S.ctx.id).maybeSingle();
    if (error) throw error;
    const srv = data?.data || {};
    PREF_KEYS.forEach((k) => { if (srv[k] !== undefined) localStorage.setItem(userKey(k), JSON.stringify(srv[k])); });
    S.prefs = srv.prefs || {};
  } catch { /* offline: fall back to this browser's copy */ }
}

const pushPrefs = debounce(async () => {
  const data = { prefs: S.prefs };
  PREF_KEYS.forEach((k) => { try { const v = localStorage.getItem(userKey(k)); if (v) data[k] = JSON.parse(v); } catch { /* ignore */ } });
  await sb().from('user_settings').upsert({ user_id: S.ctx.id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
}, 1500);

// ---------------------------------------------------------------------------
// Chrome: app bar, banners, save status
// ---------------------------------------------------------------------------
function banner(key, kind, body, actions = []) {
  clearBanner(key);
  const b = document.createElement('div');
  b.className = `ed-banner ${kind}`; b.dataset.k = key;
  b.innerHTML = `<div class="bt">${body}</div><div class="ba"></div>`;
  actions.filter(Boolean).forEach((a) => {
    const x = document.createElement('button');
    x.type = 'button'; x.className = `dsp-btn sm ${a.kind || ''}`; x.textContent = a.label; x.onclick = a.onClick;
    b.querySelector('.ba').appendChild(x);
  });
  $('#ed-banners').appendChild(b);
}
function clearBanner(key) { $(`#ed-banners [data-k="${key}"]`)?.remove(); }

function renderSave(state, info = {}) {
  const p = $('#save'); if (!p) return;
  const t = {
    saved: info.lastSavedAt ? `Saved ${fmtTime(info.lastSavedAt)}` : 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    offline: `Offline · kept ${recovery.where()}`,
    error: 'Save failed · Retry',
    conflict: 'Conflict detected',
    auth: 'Session expired · Sign in',
    locked: S.ro === 'view' ? 'View only' : 'Read-only',
  }[state] || '';
  p.className = `save-pill ${state}`;
  p.textContent = t;
  p.title = state === 'offline' ? 'The server cannot be reached. Changes are retried automatically. Click to retry now.' : state === 'error' ? (info.message || 'Click to retry') : t;
  document.title = (['dirty', 'saving', 'offline', 'error', 'auth', 'conflict'].includes(state) ? '• ' : '') + 'Discharge Summary Pro';
}

function renderMeta() {
  const st = S.st;
  $('#ab-meta').textContent = `${ACCESS[st.my_access] || ''} · edited ${fmtRelative(st.updated_at)}${st.last_edited_by_name ? ` by ${st.last_edited_by_name}` : ''}`;
}

function renderPatient() {
  const n = window.val?.('Name');
  $('#ab-pt').textContent = n || 'New discharge summary';
}

function flowAction() {
  const st = S.st, me = S.ctx.id, can = S.ctx.can;
  if (st.status === 'draft' && S.mode === 'edit') return { label: 'Submit for review', run: submitForReview };
  if (st.status === 'in_review' && st.reviewer_id === me && can('review_document')) return { label: 'Approve', run: approve };
  if (st.status === 'approved' && can('finalize_document') && (st.reviewer_id === me || ['owner', 'edit'].includes(st.my_access))) return { label: 'Finalize', run: finalize };
  if (st.status === 'finalized' && !st.superseded_by && st.my_access !== 'view' && can('create_document')) return { label: 'Create amendment', run: amend };
  return null;
}

function renderChrome() {
  const st = S.st;
  renderPatient(); renderMeta();
  $('#ab-status').innerHTML = statusBadge(st.status);
  $('#ab-share').hidden = false;
  const fa = flowAction(), fb = $('#ab-flow');
  fb.hidden = !fa; if (fa) { fb.textContent = fa.label; fb.onclick = fa.run; }

  // banners describing why the page is read-only, and workflow context
  ['mode', 'status', 'note', 'amend'].forEach(clearBanner);
  if (S.mode !== 'edit') {
    if (S.ro === 'locked') {
      const h = S.holder;
      banner('mode', 'warn', `<b>${esc(h?.editor_name || 'Another doctor')}</b> is editing this summary. You are viewing the last saved version.`,
        [{ label: 'Refresh', onClick: () => location.reload() }, { label: 'Take over editing', onClick: confirmTakeover }]);
    } else if (S.ro === 'self') {
      banner('mode', 'warn', 'You have this summary open for editing in another tab or device. Only one session can edit at a time.',
        [{ label: 'Edit here instead', kind: 'primary', onClick: takeoverReload }]);
    } else if (S.ro === 'paused') {
      banner('mode', '', `Editing was paused after ${config.editIdleReleaseMinutes} minutes of inactivity so colleagues can continue. All changes were saved.`,
        [{ label: 'Resume editing', kind: 'primary', onClick: () => location.reload() }]);
    } else if (S.ro === 'view') {
      banner('mode', '', 'You have <b>view-only</b> access to this summary. You can preview, print and export it.');
    } else if (S.ro === 'reviewer') {
      banner('mode', '', 'This summary is back with the author as a draft. You keep reviewer access to view it.');
    } else if (S.ro === 'error') {
      banner('mode', 'err', 'Editing could not be started (connection problem). You are viewing the last saved version.', [{ label: 'Try again', kind: 'primary', onClick: () => location.reload() }]);
    }
  }
  if (st.status === 'in_review') {
    const mine = st.reviewer_id === S.ctx.id;
    banner('status', '', mine
      ? `<b>Awaiting your review.</b> Submitted ${esc(fmtDateTime(st.submitted_at))}. Approve it, or return it for correction with a note.`
      : `Submitted for review to <b>${esc(st.reviewer_name || '')}</b> on ${esc(fmtDateTime(st.submitted_at))}. Read-only until approved or returned.`,
    mine ? [{ label: 'Return for correction', onClick: returnForCorrection }, { label: 'Approve', kind: 'primary', onClick: approve }]
      : (st.my_access === 'owner' ? [{ label: 'Recall from review', onClick: recall }] : []));
  } else if (st.status === 'approved') {
    banner('status', '', `Approved by <b>${esc(st.approved_by_name || '')}</b> on ${esc(fmtDateTime(st.approved_at))}. Awaiting finalization.`,
      st.reviewer_id === S.ctx.id ? [{ label: 'Return for correction', onClick: returnForCorrection }] : []);
  } else if (st.status === 'finalized') {
    banner('status', 'ok', `<b>Finalized</b> on ${esc(fmtDateTime(st.finalized_at))} by ${esc(st.finalized_by_name || '')}. This summary is protected from editing; corrections are made as a traceable amendment.`);
  }
  if (st.status === 'draft' && st.review_note) banner('note', 'warn', `<b>Returned for correction${st.reviewer_name ? ` by ${esc(st.reviewer_name)}` : ''}:</b> ${esc(st.review_note)}`);
  if (st.superseded_by) banner('amend', 'warn', 'This summary has been amended. The amendment is the current version.', [{ label: 'Open amendment', onClick: () => go(st.superseded_by) }]);
  else if (st.amends_id) banner('amend', '', `This is <b>amendment ${st.amendment_no}</b> of a finalized summary.`, [{ label: 'Open original', onClick: () => go(st.amends_id) }]);
}

function go(id) { location.hash = `id=${id}`; }

async function confirmTakeover() {
  const ok = await confirmDialog({ title: 'Take over editing?', message: `${S.holder?.editor_name || 'The other doctor'} will be switched to read-only. Anything they have not saved yet stays in their browser and they will be told. Continue?`, okText: 'Take over' });
  if (ok) takeoverReload();
}

// ---------------------------------------------------------------------------
// Workflow (all transitions are re-checked on the server)
// ---------------------------------------------------------------------------
async function ensureSaved() {
  if (S.mode !== 'edit') return true;
  const ok = await S.saver.flush();
  if (!ok && S.saver.dirty) { toast('Your latest changes are not saved yet. Resolve the save problem first.', 'err'); return false; }
  return true;
}
const currentVersion = () => (S.mode === 'edit' ? S.saver.version : S.st.version);

function runChecks(stage) {
  const items = validate(engineState(), stage);
  if (!items.length) return Promise.resolve(true);
  const blocking = items.some((i) => i.level === 'block');
  return new Promise((resolve) => {
    const d = dialog({
      title: blocking ? 'Please fix before continuing' : 'Check before continuing',
      body: `<p class="muted small">${blocking ? 'Items marked ✕ must be corrected.' : 'Review these points. They do not prevent you from continuing.'}</p>
        <ul class="vlist">${items.map((i, n) => `<li class="${i.level}"><span>${esc(i.msg)}</span>${i.field && S.mode === 'edit' ? `<button type="button" class="dsp-btn sm ghost" data-go="${n}">Go to field</button>` : ''}</li>`).join('')}</ul>`,
      actions: blocking ? [{ label: 'Close', kind: 'primary', value: 'cancel' }] : [{ label: 'Cancel', kind: 'ghost', value: 'cancel' }, { label: 'Continue', kind: 'primary', value: 'ok' }],
    });
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (!b) return; d.close('cancel'); focusField(items[+b.dataset.go].field); });
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'));
  });
}

function focusField(fid) {
  const el = document.getElementById(fid) || document.getElementById(fid === 'procs' ? 'procs' : fid);
  if (!el) return;
  const fs = el.closest('fieldset'); fs?.classList.remove('cl');
  if (fs?.hidden) document.getElementById(`opt_${fs.dataset.o}`)?.closest('.tg')?.scrollIntoView({ block: 'center' });
  const target = el.closest('.dw')?.querySelector('.dt') || (el.matches('input,textarea,select,button') ? el : el.querySelector('input,textarea,select,button') || el);
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => target.focus?.({ preventScroll: true }), 300);
}

async function transition(fn, args, message) {
  try {
    await rpc(fn, args);
    stopEditing();
    sessionStorage.setItem(`dsp_flash:${docId}`, message);
    location.reload();
  } catch (e) {
    if (e.code === 'conflict') toast('The summary changed in another session. Reload to see the latest version first.', 'err');
    else toast(e.message, 'err');
  }
}

async function submitForReview() {
  if (!(await ensureSaved()) || !(await runChecks('submit'))) return;
  const actions = S.ctx.can('self_approve') ? await chooseSelfApprove() : 'review';
  if (actions === 'self') return approve();
  if (!actions) return;
  const reviewer = await pickReviewer({ ctx: S.ctx });
  if (!reviewer) return;
  transition('submit_for_review', { p_id: docId, p_reviewer: reviewer, p_expected_version: currentVersion() }, 'Submitted for review.');
}

function chooseSelfApprove() {
  return new Promise((resolve) => {
    const d = dialog({ title: 'Review or approve?', body: '<p>You can send this summary to another consultant for review, or approve it yourself.</p>',
      actions: [{ label: 'Cancel', kind: 'ghost', value: 'cancel' }, { label: 'Approve myself', value: 'self' }, { label: 'Send for review', kind: 'primary', value: 'review' }] });
    d.addEventListener('close', () => resolve(d.returnValue === 'cancel' ? null : d.returnValue));
  });
}

async function approve() {
  if (!(await ensureSaved()) || !(await runChecks('approve'))) return;
  const ok = await confirmDialog({ title: 'Approve this summary?', message: 'It will become read-only and ready for finalization.', okText: 'Approve' });
  if (ok) transition('approve_document', { p_id: docId, p_expected_version: currentVersion() }, 'Summary approved.');
}

async function finalize() {
  if (!(await runChecks('finalize'))) return;
  const d = dialog({
    title: 'Finalize discharge summary',
    body: `<p>After finalization the summary cannot be edited. Corrections are made as a separate, traceable amendment.</p>
      <p class="muted small">Confirm each item:</p>
      ${FINAL_CHECKLIST.map(([k, t]) => `<label class="chk"><input type="checkbox" data-k="${k}"> ${esc(t)}</label>`).join('')}
      <p class="form-err" id="fc-e" role="alert"></p>`,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Finalize', kind: 'primary', onClick: async (dd) => {
      const list = {}; $$('input[data-k]', dd).forEach((c) => { list[c.dataset.k] = c.checked; });
      if (REQUIRE_FULL_CHECKLIST && Object.values(list).some((x) => !x)) { dd.querySelector('#fc-e').textContent = 'Please confirm every item.'; return false; }
      await transition('finalize_document', { p_id: docId, p_expected_version: currentVersion(), p_checklist: { ...list, confirmed_at: new Date().toISOString() } }, 'Summary finalized.');
      return false;
    } }],
  });
  return d;
}

function returnForCorrection() {
  dialog({
    title: 'Return for correction',
    body: '<label for="rc-t">Note to the author (optional)</label><textarea id="rc-t" maxlength="2000" placeholder="What needs to be corrected?"></textarea>',
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Return for correction', kind: 'primary', onClick: async (dd) => {
      await transition('return_for_correction', { p_id: docId, p_comment: dd.querySelector('#rc-t').value }, 'Returned for correction.');
      return false;
    } }],
  });
}

async function recall() {
  const ok = await confirmDialog({ title: 'Recall from review?', message: 'The summary returns to Draft and can be edited again. The reviewer keeps view access.', okText: 'Recall' });
  if (ok) transition('recall_from_review', { p_id: docId }, 'Recalled to draft.');
}

async function amend() {
  const ok = await confirmDialog({ title: 'Create an amendment?', message: 'A new draft copy is created for correction. The finalized summary stays unchanged and is marked as amended, so both remain traceable.', okText: 'Create amendment' });
  if (!ok) return;
  try { const id = await rpc('create_amendment', { p_id: docId }); go(id); } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// Files, history, menus
// ---------------------------------------------------------------------------
async function onFileLoaded(d, note) {
  if (S.mode !== 'edit') { toast('This summary is read-only, so a file cannot be loaded into it.', 'err'); return; }
  const ok = await confirmDialog({ title: 'Replace the content with this file?', message: `${note} The current content is kept in History and can be restored.`, okText: 'Load file' });
  if (!ok) { $('#msg').textContent = 'Loading cancelled.'; return; }
  if (!(await ensureSaved())) return;
  try {
    await doSave(JSON.stringify(d), S.saver.version, 'file_load');
    S.saver.stopped = true;
    sessionStorage.setItem(`dsp_flash:${docId}`, note);
    location.reload();
  } catch (e) { toast(e.message, 'err'); }
}

function fileBase() {
  const n = (window.val?.('Name') || 'Patient').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, ' ') || 'Patient';
  return `Discharge Summary - ${n} - ${new Date().toISOString().slice(0, 10)}`;
}
function downloadJSON(obj, label = 'form data') {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'), u = URL.createObjectURL(blob);
  a.href = u; a.download = `${fileBase()}${label === 'form data' ? '' : ` (${label})`}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(u); }, 4000);
  logEvent('exported_json');
}
const downloadMine = () => downloadJSON(engineState(), 'unsaved changes');

const ACT = {
  created: 'Created the summary', editing_started: 'Started editing', editing_ended: 'Finished editing', editing_taken_over: 'Took over editing',
  saved: 'Saved a checkpoint', loaded_from_file: 'Loaded content from a file', revision_restored: 'Restored an earlier version',
  shared: 'Shared', permission_changed: 'Changed access', access_revoked: 'Removed access', submitted_for_review: 'Submitted for review',
  recalled_from_review: 'Recalled from review', returned_for_correction: 'Returned for correction', approved: 'Approved', finalized: 'Finalized',
  amendment_started: 'Started an amendment', copied: 'Made a copy', deleted: 'Deleted', opened: 'Opened', printed: 'Printed',
  exported_docx: 'Saved as Word', copied_for_word: 'Copied for Word', exported_json: 'Downloaded form data',
};
const REASON = { created: 'Created', autosave: 'Autosave', checkpoint: 'Before change', handover: 'Handover', status_change: 'Status change', file_load: 'Loaded from file', restore: 'Restored', manual: 'Saved manually', amendment: 'Amendment start', duplicate: 'Copy' };
const QUIET = new Set(['opened', 'printed', 'exported_docx', 'copied_for_word', 'exported_json', 'editing_started', 'editing_ended']);

function historyDialog() {
  const d = dialog({
    title: 'History', wide: true,
    body: `<div class="dlg-tabs" role="tablist"><button type="button" class="tab" role="tab" aria-selected="true" data-t="v">Versions</button><button type="button" class="tab" role="tab" aria-selected="false" data-t="a">Activity</button></div>
      <div id="h-body"><div class="skel"></div><div class="skel" style="width:60%"></div></div>`,
    actions: [{ label: 'Close', kind: 'primary' }],
  });
  const body = d.querySelector('#h-body');
  let showQuiet = false;
  async function versions() {
    let rows; try { rows = await rpc('list_revisions', { p_id: docId }); } catch (e) { body.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; return; }
    body.innerHTML = `<p class="muted small">Snapshots are kept on handover, status changes, file loads and restores, and roughly every 10 minutes while editing. The current version is always the one shown in the editor.</p>
      <ul class="hist">${rows.map((r) => html`<li><span class="t">${fmtDateTime(r.created_at)}</span><span class="d"><b>${REASON[r.reason] || r.reason}</b> · ${r.edited_by_name}<small>Version ${r.doc_version}</small></span>
        <span><button type="button" class="dsp-btn sm ghost" data-dl="${r.revision_number}">Download</button>${raw(S.mode === 'edit' ? ` <button type="button" class="dsp-btn sm" data-rs="${r.revision_number}">Restore</button>` : '')}</span></li>`).join('')}</ul>`;
  }
  async function activity() {
    let rows; try { rows = await rpc('list_activity', { p_id: docId, p_limit: 300 }); } catch (e) { body.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; return; }
    const shown = rows.filter((r) => showQuiet || !QUIET.has(r.action));
    body.innerHTML = `<label class="chk"><input type="checkbox" id="h-q" ${showQuiet ? 'checked' : ''}> Show views, exports and editing sessions</label>
      <ul class="hist">${shown.map((r) => {
        const m = r.metadata || {};
        const extra = m.user_name ? ` · ${m.user_name}${m.permission ? ` (${ACCESS[m.permission] || m.permission})` : ''}${m.to ? ` → ${ACCESS[m.to] || m.to}` : ''}` : m.reviewer_name ? ` · to ${m.reviewer_name}` : m.previous_editor_name ? ` · from ${m.previous_editor_name}` : '';
        return html`<li><span class="t">${fmtDateTime(r.created_at)}</span><span class="d"><b>${ACT[r.action] || r.action}</b>${extra}<small>${r.actor_name}</small></span></li>`;
      }).join('') || '<li class="muted">No activity.</li>'}</ul>`;
    body.querySelector('#h-q').onchange = (e) => { showQuiet = e.target.checked; activity(); };
  }
  d.querySelector('.dlg-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'); if (!t) return;
    $$('.dlg-tabs .tab', d).forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    (t.dataset.t === 'v' ? versions : activity)();
  });
  body.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]'), rs = e.target.closest('[data-rs]');
    if (!dl && !rs) return;
    const n = +(dl || rs).dataset[dl ? 'dl' : 'rs'];
    let snap; try { snap = await rpc('get_revision', { p_id: docId, p_revision: n }); } catch (x) { toast(x.message, 'err'); return; }
    if (dl) { downloadJSON(snap, `version snapshot ${n}`); return; }
    const ok = await confirmDialog({ title: 'Restore this version?', message: 'The form will be replaced by this snapshot. The current content is kept in History first, so this can be undone.', okText: 'Restore' });
    if (!ok || !(await ensureSaved())) return;
    try {
      await doSave(JSON.stringify(snap), S.saver.version, 'restore');
      S.saver.stopped = true;
      sessionStorage.setItem(`dsp_flash:${docId}`, 'Earlier version restored.');
      location.reload();
    } catch (x) { toast(x.message, 'err'); }
  });
  versions();
}

function shortcutsDialog() {
  const rows = [['Ctrl+Enter', 'Copy for Word'], ['Ctrl+P', 'Print'], ['Alt+V', 'Preview'], ['Alt+W', 'Save Word'], ['Alt+S', 'Spelling'], ['Alt+↑ / Alt+↓', 'Jump between sections'], ['Enter', 'Next field'], ['Ctrl+S', 'Save now (creates a History checkpoint)'], ['/', 'Search (dashboard)']];
  dialog({ title: 'Keyboard shortcuts', body: `<ul class="hist">${rows.map(([k, t]) => `<li><span class="t"><b>${esc(k)}</b></span><span class="d">${esc(t)}</span></li>`).join('')}</ul>`, actions: [{ label: 'Close', kind: 'primary' }] });
}

function moreMenu() {
  const st = S.st, fa = flowAction();
  const embed = S.prefs.embed ?? config.embedRestoreDataDefault;
  menu($('#ab-more'), [
    fa && innerWidth <= 760 ? { label: fa.label, icon: '➜', onClick: fa.run } : null,
    st.status === 'draft' && S.mode === 'edit' && S.ctx.can('self_approve') ? { label: 'Approve myself', icon: '✓', onClick: approve } : null,
    st.status === 'in_review' && st.reviewer_id === S.ctx.id ? { label: 'Return for correction', icon: '↩', onClick: returnForCorrection } : null,
    st.status === 'in_review' && st.my_access === 'owner' ? { label: 'Recall from review', icon: '↩', onClick: recall } : null,
    { label: 'Share…', icon: '👥', onClick: share },
    { label: 'History and activity', icon: '🕘', onClick: historyDialog },
    S.mode === 'edit' ? { label: 'Save now', icon: '💾', hint: 'Ctrl+S · creates a History checkpoint', onClick: saveNow } : null,
    '-',
    { label: 'Download form data (.json)', icon: '⤓', hint: 'Backup; can be loaded with "Load from file"', onClick: () => downloadJSON(engineState()) },
    { label: `Embed restore data in Word files: ${embed ? 'On' : 'Off'}`, icon: embed ? '☑' : '☐', hint: 'Lets "Load from file" restore a .docx exactly. The data includes all form fields.', onClick: () => { S.prefs.embed = !embed; pushPrefs(); toast(`Restore data in Word files ${S.prefs.embed ? 'on' : 'off'}`); } },
    S.ctx.can('create_document') ? { label: 'Make a copy', icon: '⧉', hint: 'New separate draft owned by you', onClick: copyDoc } : null,
    { label: 'Keyboard shortcuts', icon: '⌨', onClick: shortcutsDialog },
    st.my_access === 'owner' && st.status === 'draft' ? '-' : null,
    st.my_access === 'owner' && st.status === 'draft' ? { label: 'Delete draft', icon: '🗑', danger: true, onClick: deleteDoc } : null,
  ]);
}

function share() {
  openShareDialog({ docId, ctx: S.ctx, myAccess: S.st.my_access, onChange: async () => { try { Object.assign(S.st, await rpc('get_editor_state', { p_id: docId }), { form_data: S.st.form_data }); renderMeta(); } catch { /* ignore */ } } });
}

async function saveNow() {
  if (S.mode !== 'edit') return;
  S.saver.checkpoint('manual');
  const ok = await S.saver.flush();
  toast(ok ? 'Saved' : 'Not saved yet — see the status at the top', ok ? 'ok' : 'warn', 2500);
}

async function copyDoc() {
  const ok = await confirmDialog({ title: 'Make a copy?', message: 'A new, separate draft owned by you is created from the last saved version. Sharing is not copied.', okText: 'Make a copy' });
  if (!ok || !(await ensureSaved())) return;
  try { go(await rpc('duplicate_document', { p_id: docId })); } catch (e) { toast(e.message, 'err'); }
}

async function deleteDoc() {
  const ok = await confirmDialog({ title: 'Delete this draft?', message: 'It will be removed for you and everyone it is shared with.', okText: 'Delete draft', danger: true });
  if (!ok) return;
  try { await rpc('delete_document', { p_id: docId }); stopEditing(); S.saver.stopped = true; recovery.clear(S.ctx.id, docId); location.replace('index.html'); }
  catch (e) { toast(e.message, 'err'); }
}

const logged = {};
function logEvent(action) {
  if (logged[action] && Date.now() - logged[action] < 5000) return;
  logged[action] = Date.now();
  rpc('log_client_event', { p_id: docId, p_action: action }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  $('#ab-share').onclick = share;
  $('#ab-more').onclick = moreMenu;
  $('#save').onclick = () => { if (['offline', 'error'].includes(S.saver.state)) S.saver.retryNow(); else if (S.saver.state === 'auth') reauthDialog(); };
  document.addEventListener('input', debounce(renderPatient, 400));

  // audit trail for exports (engine buttons keep their original behaviour)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#word,#prt,#copy,#clr'); if (!b) return;
    if (b.id === 'word') logEvent('exported_docx');
    else if (b.id === 'prt') logEvent('printed');
    else if (b.id === 'copy') logEvent('copied_for_word');
    else if (b.id === 'clr' && window.__arm && S.mode === 'edit') S.saver.checkpoint('manual');   // "Clear all" confirmed: keep the old content in History
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveNow(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) logEvent('printed');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') logEvent('copied_for_word');
    if (e.altKey && e.code === 'KeyW') logEvent('exported_docx');
  }, true);
  // In read-only mode, tapping a medicine must not open the edit pop-up.
  $('#meds')?.addEventListener('click', (e) => { if (S.mode !== 'edit') { e.stopPropagation(); e.preventDefault(); } }, true);

  addEventListener('online', () => S.saver.retryNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.mode === 'edit' && S.saver.dirty) S.saver.flush(); });
  addEventListener('beforeunload', (e) => {
    if (S.mode === 'edit' && S.saver && (S.saver.dirty || S.saver.inflight)) {
      recovery.put(S.ctx.id, docId, { data: S.saver.current, baseVersion: S.saver.version });
      e.preventDefault(); e.returnValue = '';
    }
  });
  addEventListener('pagehide', () => {
    if (S.mode !== 'edit' || !S.lease) return;
    // Unsaved edits stay in the recovery cache; the lease is released either way so nobody is blocked.
    if (S.saver.dirty) recovery.put(S.ctx.id, docId, { data: S.saver.current, baseVersion: S.saver.version });
    rpcKeepalive('release_lease', { p_id: docId, p_token: S.lease.token }, S.token);
  });
  addEventListener('hashchange', () => location.reload());

  window.__dspCanIdleSignOut = async () => !(S.saver && S.saver.dirty);
  // If the session ends while there are unsaved edits, ask for the password here instead of leaving the page.
  window.__dspOnSignedOut = () => { if (S.mode === 'edit' && S.saver?.dirty) { S.saver.status('auth'); reauthDialog(); return true; } return false; };
  window.__dspBeforeSignOut = async () => {
    if (S.mode === 'edit') {
      const saved = await S.saver.flush();
      if (!saved && S.saver.dirty) {
        const go = await confirmDialog({ title: 'Unsaved changes', message: 'Some changes could not be saved to the server. If you sign out now they remain only in this browser. Download them first if you are unsure.', okText: 'Sign out anyway', danger: true });
        if (!go) return false;
      }
      if (S.lease) await rpc('release_lease', { p_id: docId, p_token: S.lease.token }).catch(() => {});
      stopEditing();
    }
    return true;
  };
}

boot().catch((e) => { console.error(e); fatal(e.message || 'Could not open the summary.'); });
