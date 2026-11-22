import { requireUser, mountAccountMenu, startIdleSignout } from './core/auth.js';
import { rpc } from './core/api.js';
import { $, $$, html, raw, esc, toast, menu, confirmDialog, debounce, statusBadge, initials, fmtRelative, fmtDateTime, ACCESS, setBusy } from './core/ui.js';
import { openShareDialog } from './core/share.js';

const PAGE = 25;
const EMPTY = {
  my_drafts: ['No drafts yet', 'Start a new discharge summary. It is saved automatically as you type.'],
  shared_with_me: ['Nothing shared with you', 'Summaries other doctors share with you appear here.'],
  shared_by_me: ['You have not shared any summaries', 'Open a summary and use Share to hand it over to a colleague.'],
  pending_review: ['No summaries waiting for your review', 'Summaries submitted to you for review appear here.'],
  completed: ['No finalized summaries yet', 'Finalized summaries you can access appear here.'],
  all: ['No summaries', 'Summaries you created or that were shared with you appear here.'],
};
// Only non-identifying UI state is remembered (never the search text).
const saved = (() => { try { return JSON.parse(sessionStorage.getItem('dsp_dash') || '{}'); } catch { return {}; } })();
const state = { scope: saved.scope || 'my_drafts', q: '', status: saved.status || '', sort: saved.sort || 'updated_desc', offset: 0, total: 0, rows: [] };
let ctx, seq = 0;

function remember() { try { sessionStorage.setItem('dsp_dash', JSON.stringify({ scope: state.scope, status: state.status, sort: state.sort })); } catch { /* ignore */ } }

async function init() {
  ctx = await requireUser();
  startIdleSignout();
  mountAccountMenu($('#acct'), ctx);
  const h = new Date().getHours();
  $('#hello').textContent = `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${ctx.displayName}`;
  if (ctx.can('create_document')) $('#new').hidden = false;
  if (!ctx.can('create_document') && !ctx.can('review_document')) {
    // e.g. administrators: no clinical access by design
    $('#sub').textContent = ctx.can('manage_users') ? 'Your administrator account has no clinical access. Use User administration from the account menu.' : 'Your account has no clinical permissions.';
    ['#tabs', '.toolbar', '#list'].forEach((s) => { $(s).hidden = true; });
    if (ctx.can('manage_users')) { const a = document.createElement('a'); a.className = 'dsp-btn primary'; a.href = 'admin.html'; a.textContent = 'Open user administration'; $('.dash-head').appendChild(a); }
    $('#main').setAttribute('aria-busy', 'false');
    return;
  }
  $('#st').value = state.status; $('#so').value = state.sort;
  selectTab(state.scope, false);
  bind();
  await Promise.all([loadCounts(), load()]);
  $('#main').setAttribute('aria-busy', 'false');
  // refresh when returning to the tab (another doctor may have shared or edited)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadCounts(); load(); } });
}

function bind() {
  $('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) selectTab(t.dataset.s, true); });
  $('#tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tabs = $$('.tab'), i = tabs.indexOf(document.activeElement); if (i < 0) return;
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; n.focus(); selectTab(n.dataset.s, true);
  });
  const reload = debounce(() => { state.offset = 0; load(); }, 300);
  $('#q').addEventListener('input', () => { state.q = $('#q').value; reload(); });
  $('#st').addEventListener('change', () => { state.status = $('#st').value; state.offset = 0; remember(); load(); });
  $('#so').addEventListener('change', () => { state.sort = $('#so').value; state.offset = 0; remember(); load(); });
  $('#prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
  $('#nextp').addEventListener('click', () => { state.offset += PAGE; load(); });
  $('#new').addEventListener('click', newSummary);
  // row interactions (table + cards)
  $('#list').addEventListener('click', (e) => {
    const act = e.target.closest('[data-more]');
    if (act) { e.stopPropagation(); rowMenu(act, state.rows.find((r) => r.id === act.dataset.more)); return; }
    const row = e.target.closest('[data-open]');
    if (row && !e.target.closest('a,button:not(.doc-card)')) open(row.dataset.open);
  });
  $('#list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-open]')) open(e.target.dataset.open); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });
}

function selectTab(scope, fetch) {
  state.scope = scope; state.offset = 0; remember();
  $$('.tab').forEach((t) => { const on = t.dataset.s === scope; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  if (fetch) load();
}

async function loadCounts() {
  try {
    const c = await rpc('dashboard_counts');
    Object.entries(c).forEach(([k, v]) => { const el = $(`[data-c="${k}"]`); if (el) el.textContent = v; });
    const pr = $('.tab[data-s="pending_review"]');
    pr.hidden = !ctx.can('review_document') && !c.pending_review;
  } catch { /* counts are cosmetic */ }
}

async function load() {
  const my = ++seq;
  $('#list').setAttribute('aria-busy', 'true');
  if (!state.rows.length) $('#rows').innerHTML = Array.from({ length: 4 }, () => '<tr><td colspan="7"><div class="skel" style="width:70%"></div><div class="skel" style="width:40%"></div></td></tr>').join('');
  let rows;
  try {
    rows = await rpc('list_documents', { p_scope: state.scope, p_query: state.q.trim(), p_status: state.status, p_sort: state.sort, p_limit: PAGE, p_offset: state.offset });
  } catch (e) {
    if (my !== seq) return;
    $('#rows').innerHTML = ''; $('#cards').innerHTML = '';
    showEmpty('Could not load summaries', e.message, true);
    return;
  }
  if (my !== seq) return;            // a newer request superseded this one
  state.rows = rows; state.total = rows[0] ? Number(rows[0].total_count) : 0;
  render();
  $('#list').setAttribute('aria-busy', 'false');
}

function showEmpty(title, text, retry) {
  const e = $('#empty');
  e.innerHTML = html`<b>${title}</b>${text}${raw(retry ? '<p><button type="button" class="dsp-btn sm" id="retry">Try again</button></p>' : '')}`;
  e.hidden = false; $('#pager').hidden = true;
  $('#retry')?.addEventListener('click', load);
}

function team(r) {
  const people = [{ name: r.created_by_name }, ...(r.shared_with || [])];
  const shown = people.slice(0, 4);
  return `<span class="people" title="${esc(people.map((p) => p.name + (p.permission ? ` (${ACCESS[p.permission]})` : ' (owner)')).join(', '))}">${shown.map((p) => `<span class="avatar">${esc(initials(p.name))}</span>`).join('')}${people.length > 4 ? `<span class="more">+${people.length - 4}</span>` : ''}</span>`;
}

function ids(r) { return [r.mrd_number && `MRD ${r.mrd_number}`, r.irn && `IRN ${r.irn}`, r.hospital_number && `Hosp ${r.hospital_number}`].filter(Boolean); }

function render() {
  const rows = state.rows;
  $('#sub').textContent = `${state.total} ${state.total === 1 ? 'summary' : 'summaries'}${state.q ? ' match your search' : ''}`;
  if (!rows.length) {
    $('#rows').innerHTML = ''; $('#cards').innerHTML = '';
    const [t, x] = state.q || state.status ? ['No matches', 'Try a different search or status filter.'] : EMPTY[state.scope];
    showEmpty(t, x); return;
  }
  $('#empty').hidden = true;
  $('#rows').innerHTML = rows.map((r) => html`<tr class="doc" data-open="${r.id}" tabindex="0" aria-label="Open summary for ${r.patient_name || 'unnamed patient'}">
    <td class="pt"><b>${r.patient_name || 'Unnamed patient'}</b><small>${r.created_by === ctx.id ? 'Created by you' : `By ${r.created_by_name}`} · ${ACCESS[r.my_access] || ''}</small>${raw(r.amendment_no ? `<small>Amendment ${r.amendment_no}</small>` : '')}</td>
    <td><span class="sub">${ids(r).join(' · ') || '—'}</span></td>
    <td><span class="dx">${r.diagnosis || '—'}</span></td>
    <td>${raw(statusBadge(r.status))}${raw(r.superseded_by ? '<span class="sub">Amended</span>' : '')}${raw(r.status === 'in_review' && r.reviewer_name ? `<span class="sub">Reviewer: ${esc(r.reviewer_name)}</span>` : '')}</td>
    <td>${raw(team(r))}${raw(r.editing_by ? `<span class="editing-now">${esc(r.editing_by)} editing</span>` : '')}</td>
    <td><span title="${fmtDateTime(r.updated_at)}">${fmtRelative(r.updated_at)}</span><span class="sub">${r.last_edited_by_name || ''}</span></td>
    <td class="acts"><button type="button" class="dsp-icon-btn" data-more="${r.id}" aria-label="More actions">⋯</button></td>
  </tr>`).join('');
  $('#cards').innerHTML = rows.map((r) => html`<div class="doc-card" data-open="${r.id}" role="button" tabindex="0">
    <div class="r1"><b>${r.patient_name || 'Unnamed patient'}</b><span>${raw(statusBadge(r.status))} <button type="button" class="dsp-icon-btn" data-more="${r.id}" aria-label="More actions">⋯</button></span></div>
    <div class="dx">${r.diagnosis || ''}</div>
    <div class="meta"><span>${ids(r).join(' · ')}</span><span>${fmtRelative(r.updated_at)} · ${r.last_edited_by_name || ''}</span>${raw(r.editing_by ? `<span class="editing-now">${esc(r.editing_by)} editing</span>` : '')}</div>
  </div>`).join('');
  $('#cards').onkeydown = (e) => { if (e.key === 'Enter' && e.target.dataset.open) open(e.target.dataset.open); };
  const end = Math.min(state.offset + rows.length, state.total);
  $('#pager').hidden = state.total <= PAGE;
  $('#pinfo').textContent = `${state.offset + 1}–${end} of ${state.total}`;
  $('#prev').disabled = state.offset === 0; $('#nextp').disabled = end >= state.total;
}

function open(id) { location.href = `editor.html#id=${id}`; }

async function newSummary() {
  setBusy($('#new'), true, 'Creating…');
  try { const id = await rpc('create_document', { p_form_data: {} }); open(id); }
  catch (e) { toast(e.message, 'err'); setBusy($('#new'), false); }
}

function rowMenu(anchor, r) {
  if (!r) return;
  const canShare = r.my_access === 'owner' || (r.my_access === 'edit' && ctx.can('share_document'));
  menu(anchor, [
    { label: 'Open', icon: '↗', onClick: () => open(r.id) },
    { label: canShare ? 'Share…' : 'People with access', icon: '👥', onClick: () => openShareDialog({ docId: r.id, ctx, myAccess: r.my_access, onChange: () => { loadCounts(); load(); } }) },
    ctx.can('create_document') ? { label: 'Make a copy', icon: '⧉', hint: 'Creates a separate new draft you own', onClick: () => copy(r) } : null,
    r.my_access === 'owner' && r.status === 'draft' ? '-' : null,
    r.my_access === 'owner' && r.status === 'draft' ? { label: 'Delete draft', icon: '🗑', danger: true, onClick: () => del(r) } : null,
  ]);
}

async function copy(r) {
  const ok = await confirmDialog({ title: 'Make a copy?', message: `A new, separate draft owned by you will be created from "${r.patient_name || 'this summary'}". The original is not changed and sharing is not copied.`, okText: 'Make a copy' });
  if (!ok) return;
  try { const id = await rpc('duplicate_document', { p_id: r.id }); toast('Copy created', 'ok'); open(id); } catch (e) { toast(e.message, 'err'); }
}

async function del(r) {
  const ok = await confirmDialog({ title: 'Delete this draft?', message: `The draft for "${r.patient_name || 'unnamed patient'}" will be removed for you and everyone it is shared with. This cannot be undone from the application.`, okText: 'Delete draft', danger: true });
  if (!ok) return;
  try { await rpc('delete_document', { p_id: r.id }); toast('Draft deleted', 'ok'); loadCounts(); load(); } catch (e) { toast(e.message, 'err'); }
}

init().catch((e) => { toast(e.message || 'Could not start', 'err'); $('#sub').textContent = e.message || 'Could not start.'; });
