// Landing page for password-recovery and invitation e-mails (Supabase redirects here
// with a one-time session in the URL fragment). The user sets a password, then signs in.
import { sb } from './core/supabase.js';
import { passwordRules } from './core/auth.js';
import { $, setBusy } from './core/ui.js';

const note = (t, cls = '') => { const n = $('#note'); n.textContent = t; n.className = `notice ${cls}`; n.hidden = !t; };

async function init() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_description')) { note(`This link cannot be used: ${hash.get('error_description')}. Ask for a new one from the sign-in page.`, 'err'); return; }
  // supabase-js consumes the fragment (detectSessionInUrl) during initialisation.
  const { data } = await sb().auth.getSession();
  if (!data.session) { note('This link is invalid or has expired. Use "Forgot password?" on the sign-in page to get a new one.', 'err'); return; }
  history.replaceState(null, '', location.pathname);   // never leave tokens in the address bar / history
  note(`Signed in as ${data.session.user.email}. Choose a new password.`);
  $('#setpw').hidden = false; $('#pw1').focus();
}

document.querySelector('.pw-toggle').addEventListener('click', (e) => {
  const i = $('#pw1'), show = i.type === 'password';
  i.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show'; e.target.setAttribute('aria-pressed', String(show));
});

$('#setpw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = $('#pw1').value, b = $('#pw2').value, err = $('#err');
  const issues = passwordRules(a);
  if (issues.length) { err.textContent = `Password needs ${issues.join(' and ')}.`; return; }
  if (a !== b) { err.textContent = 'The two passwords do not match.'; return; }
  setBusy($('#go'), true, 'Saving…');
  const { error } = await sb().auth.updateUser({ password: a });
  if (error) { err.textContent = error.message; setBusy($('#go'), false); return; }
  window.__dspSigningOut = true;
  await sb().auth.signOut({ scope: 'local' });
  location.replace('login.html?msg=password_set');
});

init();
