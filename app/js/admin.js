import { requireUser, mountAccountMenu, startIdleSignout, roleLabel } from './core/auth.js';
import { rpc, adminFunction } from './core/api.js';
import { sb } from './core/supabase.js';
import { $, html, raw, esc, toast, dialog, confirmDialog, fmtDateTime, fmtRelative, fatal } from './core/ui.js';

const ROLES = ['doctor', 'consultant', 'admin'];
const CAPS = [
  ['create_document', 'Create summaries'], ['share_document', 'Share (as editor)'], ['review_document', 'Review / approve'],
  ['self_approve', 'Approve own drafts'], ['finalize_document', 'Finalize'], ['manage_users', 'Manage users'], ['view_operations', 'View statistics'],
];
let ctx, users = [];

async function init() {
  ctx = await requireUser();
  if (!ctx.can('manage_users')) { fatal('You do not have permission to manage users.'); return; }
  startIdleSignout();
  mountAccountMenu($('#acct'), ctx);
  $('#invite').onclick = inviteDialog;
  $('#uq').oninput = renderUsers;
  $('#users').addEventListener('change', onUserChange);
  await Promise.all([loadStats(), loadUsers(), loadCaps(), loadEvents()]);
}

async function loadStats() {
  if (!ctx.can('view_operations')) { $('#stats').hidden = true; return; }
  try {
    const s = await rpc('admin_stats'), b = s.documents_by_status || {};
    const cell = (n, t) => html`<div class="dsp-card stat"><b>${n ?? 0}</b><span>${t}</span></div>`;
    $('#stats').innerHTML = [cell(s.users_active, 'Active users'), cell(s.users_inactive, 'Inactive / pending'), cell(b.draft, 'Drafts'), cell(b.in_review, 'In review'),
      cell(b.finalized, 'Finalized'), cell(s.documents_updated_7d, 'Edited in last 7 days'), cell(s.active_editing_sessions, 'Editing now')].join('');
  } catch (e) { $('#stats').innerHTML = `<p class="form-err">${esc(e.message)}</p>`; }
}

async function loadUsers() {
  try { users = await rpc('admin_list_users'); renderUsers(); } catch (e) { $('#users').innerHTML = `<tr><td colspan="4" class="form-err">${esc(e.message)}</td></tr>`; }
}

function renderUsers() {
  const q = $('#uq').value.trim().toLowerCase();
  const rows = users.filter((u) => !q || [u.full_name, u.email, u.designation].join(' ').toLowerCase().includes(q));
  $('#users').innerHTML = rows.map((u) => {
    const self = u.id === ctx.id;
    return html`<tr data-u="${u.id}">
      <td class="pt"><b>${u.full_name || '(no name)'}${self ? ' (you)' : ''}</b><small>${u.email || ''}${u.designation ? ` · ${u.designation}` : ''}</small></td>
      <td><select data-f="role" aria-label="Role for ${u.full_name || u.email}" ${self ? 'disabled' : ''}>${raw(ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join(''))}</select></td>
      <td><label class="chk" style="margin:0!important"><input type="checkbox" data-f="active" ${u.is_active ? 'checked' : ''} ${self ? 'disabled' : ''}> ${u.is_active ? 'Active' : 'Inactive'}</label>${raw(u.invited_pending ? '<span class="badge">Invite pending</span>' : '')}</td>
      <td><span title="${u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : ''}">${u.last_sign_in_at ? fmtRelative(u.last_sign_in_at) : 'Never'}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">No accounts match.</td></tr>';
}

async function onUserChange(e) {
  const tr = e.target.closest('tr[data-u]'); if (!tr) return;
  const u = users.find((x) => x.id === tr.dataset.u);
  const role = tr.querySelector('[data-f=role]').value, active = tr.querySelector('[data-f=active]').checked;
  if (!active && u.is_active) {
    const ok = await confirmDialog({ title: 'Deactivate account?', message: `${u.full_name || u.email} will immediately lose access to every summary and will be signed out of the application. Their records and audit history are kept.`, okText: 'Deactivate', danger: true });
    if (!ok) { renderUsers(); return; }
  }
  if (role !== u.role && (role === 'admin' || u.role === 'admin')) {
    const ok = await confirmDialog({ title: 'Change role?', message: `Change ${u.full_name || u.email} from ${roleLabel(u.role)} to ${roleLabel(role)}?`, okText: 'Change role' });
    if (!ok) { renderUsers(); return; }
  }
  try {
    await rpc('admin_update_user', { p_user: u.id, p_role: role, p_is_active: active });
    if (active !== u.is_active) {
      // also block / unblock sign-in at the authentication layer (best effort; access is already enforced in the database)
      try { await adminFunction({ action: 'set_access', user_id: u.id, active }); }
      catch (x) { toast(`Saved. Sign-in block could not be updated: ${x.message}`, 'warn', 7000); }
    }
    toast('Account updated', 'ok');
  } catch (x) { toast(x.message, 'err'); }
  await Promise.all([loadUsers(), loadEvents(), loadStats()]);
}

async function loadCaps() {
  const { data, error } = await sb().from('role_capabilities').select('role, capability');
  if (error) { $('#caps').innerHTML = `<tr><td class="form-err">${esc(error.message)}</td></tr>`; return; }
  const has = new Set(data.map((r) => `${r.role}:${r.capability}`));
  $('#caps').innerHTML = `<thead><tr><th>Permission</th>${ROLES.map((r) => `<th>${esc(roleLabel(r).split(' ')[0])}</th>`).join('')}</tr></thead><tbody>${
    CAPS.map(([c, label]) => `<tr><td>${esc(label)}</td>${ROLES.map((r) => `<td><input type="checkbox" aria-label="${esc(label)} for ${esc(r)}" data-r="${r}" data-c="${c}" ${has.has(`${r}:${c}`) ? 'checked' : ''} ${r === 'admin' && c === 'manage_users' ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}</tbody>`;
  $('#caps').onchange = async (e) => {
    const i = e.target; if (!i.dataset.c) return;
    if (['review_document', 'finalize_document', 'self_approve'].includes(i.dataset.c) || i.dataset.c === 'manage_users') {
      const ok = await confirmDialog({ title: 'Change a clinical-governance permission?', message: `"${CAPS.find((x) => x[0] === i.dataset.c)[1]}" for ${roleLabel(i.dataset.r)} will be ${i.checked ? 'granted' : 'removed'} for everyone with that role. Confirm this matches the hospital's approved access policy.`, okText: 'Apply' });
      if (!ok) { i.checked = !i.checked; return; }
    }
    try { await rpc('admin_set_capability', { p_role: i.dataset.r, p_capability: i.dataset.c, p_enabled: i.checked }); toast('Permission updated', 'ok'); loadEvents(); }
    catch (x) { i.checked = !i.checked; toast(x.message, 'err'); }
  };
}

const EV = { user_updated: 'Account updated', capability_changed: 'Permission changed', user_invited: 'Invited', access_synced: 'Sign-in access updated' };
async function loadEvents() {
  try {
    const rows = await rpc('admin_recent_events', { p_limit: 40 });
    $('#events').innerHTML = rows.map((r) => {
      const m = r.metadata || {};
      const what = m.user_name ? m.user_name : m.capability ? `${m.capability} → ${m.role} (${m.enabled ? 'on' : 'off'})` : m.email || '';
      return html`<li><span class="t">${fmtDateTime(r.created_at)}</span><span class="d"><b>${EV[r.action] || r.action}</b> ${what}<small>by ${r.actor_name}</small></span></li>`;
    }).join('') || '<li class="muted">No events yet.</li>';
  } catch (e) { $('#events').innerHTML = `<li class="form-err">${esc(e.message)}</li>`; }
}

function inviteDialog() {
  dialog({
    title: 'Invite a doctor',
    body: html`<p class="muted small">An invitation e-mail with a link to set a password is sent. The account is active straight away; the doctor can sign in once the password is set. Invite only staff authorised under the hospital's access policy.</p>
      <label for="iv-e">Hospital email</label><input id="iv-e" type="email" autocomplete="off">
      <label for="iv-n">Full name</label><input id="iv-n" maxlength="120" placeholder="Dr …">
      <label for="iv-d">Designation</label><input id="iv-d" maxlength="120" placeholder="e.g. Senior Resident">
      <label for="iv-r">Role</label><select id="iv-r">${raw(ROLES.map((r) => `<option value="${r}">${esc(roleLabel(r))}</option>`).join(''))}</select>
      <p class="form-err" id="iv-x" role="alert"></p>`,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Send invitation', kind: 'primary', onClick: async (d) => {
      const email = d.querySelector('#iv-e').value.trim(), name = d.querySelector('#iv-n').value.trim();
      const x = d.querySelector('#iv-x');
      if (!/^\S+@\S+\.\S+$/.test(email)) { x.textContent = 'Enter a valid email.'; return false; }
      if (name.length < 2) { x.textContent = 'Enter the full name.'; return false; }
      try {
        await adminFunction({ action: 'invite', email, full_name: name, designation: d.querySelector('#iv-d').value.trim(), role: d.querySelector('#iv-r').value, redirect_to: new URL('reset.html', location.href).href });
        toast(`Invitation sent to ${email}`, 'ok');
      } catch (e) { x.textContent = e.message; return false; }
      loadUsers(); loadEvents(); loadStats();
    } }],
  });
}

init().catch((e) => fatal(e.message));
