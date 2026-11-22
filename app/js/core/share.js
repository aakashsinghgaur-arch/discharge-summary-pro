// Share dialog: list who has access, add doctors (view / edit), change or remove access.
// Every change is enforced server-side (share_document / revoke_share); this UI only reflects it.
import { rpc } from './api.js';
import { dialog, toast, html, raw, esc, initials, debounce, ACCESS, confirmDialog } from './ui.js';

export function openShareDialog({ docId, ctx, myAccess, onChange }) {
  const canShare = myAccess === 'owner' || (myAccess === 'edit' && ctx.can('share_document'));
  let level = 'edit';
  const d = dialog({
    title: 'Share summary',
    wide: false,
    body: html`
      <p class="notice warn small" style="margin-top:12px">Sharing gives access to identifiable patient information. Share only with doctors involved in this patient's care.</p>
      ${raw(canShare ? `
      <label for="sh-q">Add a doctor</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="sh-q" type="search" placeholder="Search by name, designation or email" autocomplete="off" style="flex:1;min-width:200px">
        <div class="seg" role="group" aria-label="Access level"><button type="button" data-l="view" aria-pressed="false">View only</button><button type="button" data-l="edit" aria-pressed="true">Can edit</button></div>
      </div>
      <div class="pick-list" id="sh-r" role="listbox" aria-label="Matching doctors"></div>` : '<p class="muted small">You can see who has access. Only the owner or an editor with sharing rights can change it.</p>')}
      <h3 style="margin:18px 0 0;font-size:14px">People with access</h3>
      <ul class="acl" id="sh-acl"><li><div class="skel" style="width:60%"></div></li></ul>`,
    actions: [{ label: 'Done', kind: 'primary' }],
  });
  const acl = d.querySelector('#sh-acl');
  let current = [];

  async function loadAcl() {
    try { current = await rpc('list_doc_access', { p_id: docId }); }
    catch (e) { acl.innerHTML = `<li class="form-err">${esc(e.message)}</li>`; return; }
    acl.innerHTML = current.map((p) => {
      const me = p.user_id === ctx.id;
      const editable = canShare && !p.is_owner && p.permission !== 'review';
      const removable = !p.is_owner && (myAccess === 'owner' || me || canShare);
      return html`<li data-u="${p.user_id}">
        <span class="avatar" aria-hidden="true">${initials(p.full_name)}</span>
        <span class="who"><b>${p.full_name}${me ? ' (you)' : ''}</b><small>${p.designation || ''}${p.granted_by_name ? ` · added by ${p.granted_by_name}` : ''}</small></span>
        ${raw(editable ? `<select aria-label="Access for ${esc(p.full_name)}"><option value="view" ${p.permission === 'view' ? 'selected' : ''}>View only</option><option value="edit" ${p.permission === 'edit' ? 'selected' : ''}>Can edit</option></select>`
          : `<span class="badge">${esc(ACCESS[p.permission] || p.permission)}</span>`)}
        ${raw(removable ? `<button type="button" class="dsp-icon-btn" data-rm aria-label="Remove access for ${esc(p.full_name)}" title="Remove access">✕</button>` : '')}
      </li>`;
    }).join('');
  }

  acl.addEventListener('change', async (e) => {
    const li = e.target.closest('li[data-u]'); if (!li || e.target.tagName !== 'SELECT') return;
    try { await rpc('share_document', { p_id: docId, p_user: li.dataset.u, p_permission: e.target.value }); toast('Access updated', 'ok'); onChange?.(); }
    catch (err) { toast(err.message, 'err'); }
    loadAcl();
  });
  acl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const li = b.closest('li'); const p = current.find((x) => x.user_id === li.dataset.u);
    const self = p.user_id === ctx.id;
    const ok = await confirmDialog({ title: self ? 'Remove your access?' : 'Remove access?', message: self ? 'You will no longer be able to open this summary.' : `${p.full_name} will no longer be able to open this summary.`, okText: 'Remove', danger: true });
    if (!ok) return;
    try { await rpc('revoke_share', { p_id: docId, p_user: p.user_id }); toast('Access removed', 'ok'); onChange?.(); if (self) { location.href = 'index.html'; return; } }
    catch (err) { toast(err.message, 'err'); }
    loadAcl();
  });

  if (canShare) {
    const q = d.querySelector('#sh-q'), res = d.querySelector('#sh-r');
    d.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      level = b.dataset.l; d.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const search = debounce(async () => {
      let rows;
      try { rows = await rpc('search_doctors', { p_query: q.value }); } catch (e) { res.innerHTML = `<p class="form-err" style="padding:8px 12px">${esc(e.message)}</p>`; return; }
      const have = new Set(current.map((x) => x.user_id));
      rows = rows.filter((r) => !have.has(r.id));
      res.innerHTML = rows.length ? rows.map((r) => html`<button type="button" class="pick" role="option" data-u="${r.id}">
          <span class="avatar" aria-hidden="true">${initials(r.full_name)}</span>
          <span class="who"><b>${r.full_name || r.email}</b><small>${r.designation || ''}${r.designation ? ' · ' : ''}${r.email || ''}</small></span><span class="badge">+ Add</span></button>`).join('')
        : '<p class="muted small" style="padding:8px 12px;margin:0">No matching doctors.</p>';
    }, 250);
    q.addEventListener('input', search);
    res.addEventListener('click', async (e) => {
      const b = e.target.closest('.pick'); if (!b) return;
      b.disabled = true;
      try { await rpc('share_document', { p_id: docId, p_user: b.dataset.u, p_permission: level }); toast(`Shared (${level === 'edit' ? 'can edit' : 'view only'})`, 'ok'); onChange?.(); }
      catch (err) { toast(err.message, 'err'); }
      await loadAcl(); search();
    });
    search();
    setTimeout(() => q.focus(), 50);
  }
  loadAcl();
  return d;
}

// Reviewer picker used by "Submit for review".
export function pickReviewer({ ctx }) {
  return new Promise((resolve) => {
    let chosen = null;
    const d = dialog({
      title: 'Submit for review',
      body: html`<p class="muted small" style="margin-top:12px">The reviewer is given review access, and the summary becomes read-only until it is approved or returned for correction.</p>
        <label for="rv-q">Reviewer (consultant)</label><input id="rv-q" type="search" placeholder="Search consultants" autocomplete="off">
        <div class="pick-list" id="rv-r" role="listbox"></div><p class="form-err" id="rv-e" role="alert"></p>`,
      actions: [{ label: 'Cancel', kind: 'ghost', value: 'cancel' }, { label: 'Submit for review', kind: 'primary', onClick: (dd) => { if (!chosen) { dd.querySelector('#rv-e').textContent = 'Choose a reviewer.'; return false; } } }],
    });
    const q = d.querySelector('#rv-q'), res = d.querySelector('#rv-r');
    const search = debounce(async () => {
      try {
        const rows = (await rpc('search_doctors', { p_query: q.value })).filter((r) => r.can_review);
        res.innerHTML = rows.length ? rows.map((r) => html`<button type="button" class="pick ${chosen === r.id ? 'on' : ''}" role="option" aria-selected="${chosen === r.id}" data-u="${r.id}"><span class="avatar" aria-hidden="true">${initials(r.full_name)}</span><span class="who"><b>${r.full_name}</b><small>${r.designation || ''}</small></span></button>`).join('')
          : '<p class="muted small" style="padding:8px 12px;margin:0">No consultants match.</p>';
      } catch (e) { res.innerHTML = `<p class="form-err" style="padding:8px 12px">${esc(e.message)}</p>`; }
    }, 250);
    q.addEventListener('input', search);
    res.addEventListener('click', (e) => {
      const b = e.target.closest('.pick'); if (!b) return;
      chosen = b.dataset.u; res.querySelectorAll('.pick').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    });
    search(); setTimeout(() => q.focus(), 50);
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? chosen : null));
  });
}
