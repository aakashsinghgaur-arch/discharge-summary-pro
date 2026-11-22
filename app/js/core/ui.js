// Small, dependency-free UI helpers shared by all pages.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Tagged template that escapes interpolations unless they are wrapped with raw().
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    if (i >= vals.length) return out + s;
    const v = vals[i];
    const t = Array.isArray(v) ? v.map((x) => (x && x[RAW] !== undefined ? x[RAW] : esc(x))).join('') : v && v[RAW] !== undefined ? v[RAW] : esc(v);
    return out + s + t;
  }, '');
}

// ---------- formatting ----------
const dtf = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const tf = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (v) => (v ? dtf.format(new Date(v)) : '');
export const fmtDate = (v) => (v ? df.format(new Date(v)) : '');
export const fmtTime = (v) => (v ? tf.format(new Date(v)) : '');
export function fmtRelative(v) {
  if (!v) return '';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 && new Date(v).toDateString() === new Date().toDateString()) return `today ${fmtTime(v)}`;
  if (s < 172800) return `yesterday ${fmtTime(v)}`;
  return fmtDate(v);
}
export function initials(name) {
  const p = String(name || '?').replace(/^(dr\.?|prof\.?)\s+/i, '').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

export const STATUS = {
  draft: { label: 'Draft', cls: 'st-draft' },
  in_review: { label: 'In review', cls: 'st-review' },
  approved: { label: 'Approved', cls: 'st-approved' },
  finalized: { label: 'Finalized', cls: 'st-final' },
};
export const statusBadge = (s) => html`<span class="badge ${STATUS[s]?.cls || ''}">${STATUS[s]?.label || s}</span>`;
export const ACCESS = { owner: 'Owner', edit: 'Can edit', review: 'Reviewer', view: 'View only' };

// ---------- toasts ----------
let toastHost;
export function toast(message, type = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'dsp-toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = `dsp-toast ${type}`;
  t.textContent = message;
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- dialogs (native <dialog>, focus-trapped and Esc-closable by the browser) ----------
export function dialog({ title, body = '', actions = [], wide = false, onOpen, dismissible = true, className = '' }) {
  const d = document.createElement('dialog');
  d.className = `dsp-dlg ${wide ? 'wide' : ''} ${className}`;
  d.innerHTML = html`<form method="dialog" class="dsp-dlg-in">
    <header class="dsp-dlg-h"><h2>${title}</h2>${raw(dismissible ? '<button type="button" class="dsp-icon-btn" data-close aria-label="Close">✕</button>' : '')}</header>
    <div class="dsp-dlg-b">${raw(body)}</div>
    ${raw(actions.length ? `<footer class="dsp-dlg-f">${actions.map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="dsp-btn ${a.kind || ''}" data-act="${i}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</footer>` : '')}
  </form>`;
  // Keep key presses inside dialogs away from the form engine's global shortcuts.
  d.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  d.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
  d.querySelector('[data-close]')?.addEventListener('click', () => d.close('cancel'));
  d.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
    const a = actions[+b.dataset.act];
    if (!a.onClick) { d.close(a.value ?? 'ok'); return; }
    e.preventDefault();
    b.disabled = true;
    try { const r = await a.onClick(d, b); if (r !== false) d.close(a.value ?? 'ok'); }
    finally { if (d.open) b.disabled = false; }
  }));
  document.body.appendChild(d);
  d.showModal();
  onOpen?.(d);
  return d;
}

export function confirmDialog({ title, message, okText = 'Confirm', cancelText = 'Cancel', danger = false, html: isHtml = false }) {
  return new Promise((resolve) => {
    const d = dialog({
      title,
      body: isHtml ? message : `<p>${esc(message)}</p>`,
      actions: [
        { label: cancelText, kind: 'ghost', value: 'cancel' },
        { label: okText, kind: danger ? 'danger' : 'primary', value: 'ok' },
      ],
    });
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'));
  });
}

// ---------- popup menus ----------
export function menu(anchor, items) {
  document.querySelectorAll('.dsp-menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'dsp-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.filter(Boolean).map((it, i) => it === '-' ? '<hr>' :
    `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${it.icon ? `<span class="mi-ic" aria-hidden="true">${it.icon}</span>` : ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(220, m.offsetWidth);
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  const list = items.filter(Boolean);
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); anchor.focus?.(); };
  const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => {
    const btns = [...m.querySelectorAll('button:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1])?.focus(); }
    else if (e.key === 'Tab') close();
  };
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = list[+b.dataset.i]; close(); it.onClick?.();
  });
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); m.querySelector('button:not([disabled])')?.focus(); });
  return m;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(text || 'Please wait…')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export function fatal(message) {
  document.body.innerHTML = html`<main class="dsp-fatal"><div class="dsp-card"><div class="brand-mark">✚</div><h1>Discharge Summary Pro</h1><p>${message}</p><p><a class="dsp-btn primary" href="index.html">Go to dashboard</a></p></div></main>`;
}
