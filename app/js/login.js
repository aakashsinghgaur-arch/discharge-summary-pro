import { sb } from './core/supabase.js';
import { isConfigured } from './core/env.js';
import { safeNext } from './core/auth.js';
import { $, setBusy } from './core/ui.js';

const q = new URLSearchParams(location.search);
const next = safeNext(q.get('next'));
const NOTES = {
  inactive: ['Your account is not active yet. An administrator must approve it before you can use the application.', 'warn'],
  expired: ['Your session expired. Please sign in again.', ''],
  idle: ['You were signed out after a period of inactivity.', ''],
  signed_out: ['You have been signed out.', ''],
  reset_sent: ['If the address belongs to an authorised account, a reset link has been sent. Check your inbox.', 'ok'],
  password_set: ['Password saved. Please sign in.', 'ok'],
};

function note(key) {
  const n = NOTES[key]; const el = $('#note');
  if (!n) { el.hidden = true; return; }
  el.textContent = n[0]; el.className = `notice ${n[1]}`; el.hidden = false;
}

if (!isConfigured()) {
  $('#note').textContent = 'This deployment is not configured yet (Supabase URL / publishable key missing). See README → Deployment.';
  $('#note').className = 'notice err'; $('#note').hidden = false;
  $('#go').disabled = true;
} else {
  note(q.get('msg'));
  // Already signed in? Go straight on.
  sb().auth.getSession().then(({ data }) => { if (data.session && !q.get('msg')) location.replace(next); });
}

// Password visibility
document.querySelectorAll('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
  const i = document.getElementById(b.getAttribute('aria-controls'));
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show));
  i.focus();
}));

$('#signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim(), password = $('#pw').value, err = $('#err');
  err.textContent = '';
  if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; $('#email').focus(); return; }
  if (!password) { err.textContent = 'Enter your password.'; $('#pw').focus(); return; }
  setBusy($('#go'), true, 'Signing in…');
  try {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) {
      err.textContent = /invalid login|invalid credentials/i.test(error.message) ? 'Email or password is incorrect.'
        : /rate|too many/i.test(error.message) ? 'Too many attempts. Please wait a few minutes and try again.'
        : /fetch|network/i.test(error.message) ? 'Cannot reach the server. Check the internet connection.' : error.message;
      setBusy($('#go'), false); $('#pw').select(); return;
    }
    location.replace(next);
  } catch {
    err.textContent = 'Cannot reach the server. Check the internet connection.';
    setBusy($('#go'), false);
  }
});

$('#forgot').addEventListener('click', () => { $('#signin').hidden = true; $('#reset').hidden = false; $('#remail').value = $('#email').value; $('#remail').focus(); });
$('#back').addEventListener('click', () => { $('#reset').hidden = true; $('#signin').hidden = false; $('#email').focus(); });

$('#reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#remail').value.trim(), err = $('#rerr');
  err.textContent = '';
  if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
  setBusy($('#rgo'), true, 'Sending…');
  const redirectTo = new URL('reset.html', location.href).href;
  const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo }).catch((x) => ({ error: x }));
  setBusy($('#rgo'), false);
  if (error && /fetch|network/i.test(error.message)) { err.textContent = 'Cannot reach the server. Check the internet connection.'; return; }
  // Same message whether or not the account exists (no account enumeration).
  $('#reset').hidden = true; $('#signin').hidden = false; note('reset_sent');
});
