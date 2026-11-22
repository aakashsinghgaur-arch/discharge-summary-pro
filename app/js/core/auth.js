import { sb } from './supabase.js';
import { rpc } from './api.js';
import { config, isConfigured } from './env.js';
import { dialog, menu, toast, esc, html, raw, initials, fatal } from './ui.js';

const NEXT_OK = /^(index|editor|admin)\.html(#id=[0-9a-f-]{36})?$/;

export function safeNext(v) { return v && NEXT_OK.test(v) ? v : 'index.html'; }

export function redirectToLogin(reason) {
  const page = location.pathname.split('/').pop() || 'index.html';
  const next = page + (location.hash.match(/^#id=[0-9a-f-]{36}$/) ? location.hash : '');
  const q = new URLSearchParams();
  if (reason) q.set('msg', reason);
  if (NEXT_OK.test(next) && next !== 'index.html') q.set('next', next);
  location.replace('login.html' + (q.toString() ? `?${q}` : ''));
}

const never = () => new Promise(() => {});

// Ensures a signed-in, ACTIVE user. Returns the profile + capabilities.
export async function requireUser() {
  if (!isConfigured()) { fatal('This deployment is not configured yet. See README → Deployment.'); return never(); }
  const { data: { session } } = await sb().auth.getSession();
  if (!session) { redirectToLogin(); return never(); }
  let ctx;
  try { ctx = await rpc('my_context'); }
  catch (e) {
    if (e.code === 'auth') { await sb().auth.signOut({ scope: 'local' }); redirectToLogin('expired'); return never(); }
    throw e;
  }
  if (!ctx.is_active) { await sb().auth.signOut({ scope: 'local' }); redirectToLogin('inactive'); return never(); }
  ctx.can = (cap) => (ctx.capabilities || []).includes(cap);
  ctx.displayName = ctx.full_name || ctx.email;
  sb().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !window.__dspSigningOut && !(window.__dspOnSignedOut?.())) redirectToLogin('signed_out');
  });
  return ctx;
}

// Signs out after confirming with the page (e.g. editor flushes unsaved changes first).
export async function signOut(reason) {
  if (typeof window.__dspBeforeSignOut === 'function') {
    const ok = await window.__dspBeforeSignOut();
    if (!ok) return;
  }
  window.__dspSigningOut = true;
  // Remembered suggestions are cached per user in this browser; the server keeps the master copy.
  try { Object.keys(localStorage).filter((k) => k.startsWith('dsp_u:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  try { await sb().auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  location.replace('login.html' + (reason ? `?msg=${encodeURIComponent(reason)}` : ''));
}

// Shared-workstation safety: sign out after a period without any interaction.
export function startIdleSignout() {
  const mins = config.idleSignoutMinutes;
  if (!mins || mins <= 0) return;
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach((e) => addEventListener(e, bump, { passive: true, capture: true }));
  setInterval(async () => {
    if (Date.now() - last < mins * 60_000) return;
    if (typeof window.__dspCanIdleSignOut === 'function' && !(await window.__dspCanIdleSignOut())) { bump(); return; }
    signOut('idle');
  }, 30_000);
}

export function mountAccountMenu(btn, ctx, { extra = [] } = {}) {
  btn.innerHTML = html`<span class="avatar" aria-hidden="true">${initials(ctx.displayName)}</span><span class="acct-name">${ctx.displayName}</span>`;
  btn.setAttribute('aria-label', `Account: ${ctx.displayName}`);
  btn.addEventListener('click', () => menu(btn, [
    { label: ctx.displayName, hint: `${ctx.designation || ''}${ctx.designation ? ' · ' : ''}${roleLabel(ctx.role)}`, disabled: true },
    '-',
    ...extra,
    { label: 'My profile', icon: '👤', onClick: () => profileDialog(ctx) },
    { label: 'Change password', icon: '🔑', onClick: () => passwordDialog() },
    ctx.can('manage_users') ? { label: 'User administration', icon: '⚙', onClick: () => { location.href = 'admin.html'; } } : null,
    '-',
    { label: 'Sign out', icon: '⎋', onClick: () => signOut() },
  ]));
}

export const roleLabel = (r) => ({ admin: 'Administrator', doctor: 'Doctor', consultant: 'Consultant / Reviewer' }[r] || r);

export function profileDialog(ctx) {
  dialog({
    title: 'My profile',
    body: html`<label for="pf-n">Full name (as it should appear to colleagues)</label><input id="pf-n" maxlength="120" value="${ctx.full_name || ''}" autocomplete="name">
      <label for="pf-d">Designation</label><input id="pf-d" maxlength="120" value="${ctx.designation || ''}" placeholder="e.g. Senior Resident">
      <p class="muted small">Email: ${ctx.email || ''} · Role: ${roleLabel(ctx.role)} (changed by an administrator)</p>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Save', kind: 'primary', onClick: async (d) => {
        const n = d.querySelector('#pf-n').value.trim(), g = d.querySelector('#pf-d').value.trim();
        if (n.length < 2) { d.querySelector('#pf-n').focus(); return false; }
        try { await rpc('update_my_profile', { p_full_name: n, p_designation: g }); ctx.full_name = n; ctx.designation = g; toast('Profile updated', 'ok'); }
        catch (e) { toast(e.message, 'err'); return false; }
      } },
    ],
  });
}

export function passwordRules(p) {
  const issues = [];
  if (p.length < 10) issues.push('at least 10 characters');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) issues.push('letters and numbers');
  return issues;
}

export function passwordDialog() {
  dialog({
    title: 'Change password',
    body: html`<label for="pw-1">New password</label><input id="pw-1" type="password" autocomplete="new-password" minlength="10">
      <label for="pw-2">Confirm new password</label><input id="pw-2" type="password" autocomplete="new-password">
      <p class="muted small">Use at least 10 characters with letters and numbers.</p><p class="form-err" id="pw-e" role="alert"></p>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Update password', kind: 'primary', onClick: async (d) => {
        const a = d.querySelector('#pw-1').value, b = d.querySelector('#pw-2').value, err = d.querySelector('#pw-e');
        const issues = passwordRules(a);
        if (issues.length) { err.textContent = `Password needs ${issues.join(' and ')}.`; return false; }
        if (a !== b) { err.textContent = 'The two passwords do not match.'; return false; }
        const { error } = await sb().auth.updateUser({ password: a });
        if (error) { err.textContent = error.message; return false; }
        toast('Password updated', 'ok');
      } },
    ],
  });
}

export { esc, raw };
