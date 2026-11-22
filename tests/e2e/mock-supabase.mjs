// In-memory stand-in for the Supabase REST/Auth API, installed with Playwright request routing.
// It mirrors the server contract of the real RPC functions closely enough to exercise the UI
// (versions, leases, permissions, DSP:<code> errors). The real SQL is tested in tests/db/.
import { randomUUID } from 'node:crypto';

export const SUPABASE_URL = 'https://test-project.supabase.co';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const CAPS = {
  doctor: ['create_document', 'share_document'],
  consultant: ['create_document', 'finalize_document', 'review_document', 'self_approve', 'share_document'],
  admin: ['manage_users', 'view_operations'],
};

class DspError extends Error { constructor(code, detail) { super(`DSP:${code}`); this.code = code; this.detail = detail; } }

export class MockSupabase {
  constructor() {
    this.users = {
      d1: { id: '11111111-1111-4111-8111-111111111111', email: 'd1@test.local', full_name: 'Dr Synthetic One', designation: 'Senior Resident', role: 'doctor', is_active: true },
      d2: { id: '22222222-2222-4222-8222-222222222222', email: 'd2@test.local', full_name: 'Dr Synthetic Two', designation: 'Junior Resident', role: 'doctor', is_active: true },
      c1: { id: '33333333-3333-4333-8333-333333333333', email: 'c1@test.local', full_name: 'Dr Consultant One', designation: 'Professor', role: 'consultant', is_active: true },
      admin: { id: '44444444-4444-4444-8444-444444444444', email: 'admin@test.local', full_name: 'Test Admin', designation: 'IT', role: 'admin', is_active: true },
    };
    this.me = this.users.d1;
    this.docs = new Map(); this.calls = []; this.fail = {}; this.offline = false; this.settings = null; this.perms = [];
  }

  as(key) { this.me = this.users[key]; return this; }

  addDoc(over = {}) {
    const d = { id: randomUUID(), status: 'draft', version: 1, form_data: {}, created_by: this.users.d1.id, last_edited_by: this.users.d1.id,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reviewer_id: null, lease: null, review_note: null,
      amends_id: null, amendment_no: 0, superseded_by: null, access: {}, ...over };
    this.docs.set(d.id, d); return d;
  }

  name(id) { return Object.values(this.users).find((u) => u.id === id)?.full_name || null; }
  access(d) { return d.created_by === this.me.id ? 'owner' : d.access[this.me.id] || null; }
  callsOf(fn) { return this.calls.filter((c) => c.fn === fn); }

  session(userKey = 'd1') {
    const u = this.users[userKey];
    return { access_token: fakeJwt(u.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + u.id,
      user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
  }

  async install(context) {
    await context.route(`${SUPABASE_URL}/**`, (route) => this.handle(route));
  }

  async handle(route) {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (this.offline) return route.abort('internetdisconnected');

    if (path === '/auth/v1/user') return json(200, this.session(Object.keys(this.users).find((k) => this.users[k] === this.me)).user);
    if (path === '/auth/v1/logout') return json(204);
    if (path === '/auth/v1/token') {
      const body = JSON.parse(req.postData() || '{}');
      const key = Object.keys(this.users).find((k) => this.users[k].email === body.email);
      if (!key || body.password !== 'correct-horse-12') return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      this.me = this.users[key];
      return json(200, this.session(key));
    }
    if (path === '/rest/v1/user_settings') {
      if (req.method() === 'GET') {
        if ((req.headers().accept || '').includes('vnd.pgrst.object')) {
          return this.settings ? json(200, { data: this.settings }) : json(406, { code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        }
        return json(200, this.settings ? [{ data: this.settings }] : []);
      }
      this.settings = JSON.parse(req.postData() || '{}').data; this.calls.push({ fn: 'user_settings:upsert', args: this.settings });
      return json(201);
    }
    if (path === '/rest/v1/role_capabilities') return json(200, Object.entries(CAPS).flatMap(([role, caps]) => caps.map((capability) => ({ role, capability }))));

    const m = path.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (m) {
      const fn = m[1], args = JSON.parse(req.postData() || '{}');
      this.calls.push({ fn, args, at: Date.now() });
      const f = this.fail[fn];
      if (f) {
        if (f.times !== undefined && --f.times <= 0) delete this.fail[fn];
        if (f.abort) return route.abort('failed');
        if (f.status) return json(f.status, f.body);
        return json(400, { code: 'P0001', message: `DSP:${f.code}`, details: f.detail ? JSON.stringify(f.detail) : null, hint: null });
      }
      const h = this[`rpc_${fn}`];
      if (!h) return json(404, { code: 'PGRST202', message: `no function ${fn}` });
      try { return json(200, h.call(this, args)); }
      catch (e) { if (e instanceof DspError) return json(400, { code: 'P0001', message: e.message, details: e.detail ? JSON.stringify(e.detail) : null, hint: null }); throw e; }
    }
    return json(404, { message: 'not mocked: ' + path });
  }

  doc(id) { const d = this.docs.get(id); if (!d || !this.access(d)) throw new DspError('not_found'); return d; }

  // ------------------------------------------------------------------ RPCs
  rpc_my_context() { const u = this.me; return { ...u, capabilities: CAPS[u.role] }; }
  rpc_log_client_event() { return null; }
  rpc_dashboard_counts() { return { my_drafts: [...this.docs.values()].filter((d) => d.created_by === this.me.id && d.status !== 'finalized').length, shared_with_me: 0, shared_by_me: 0, pending_review: 0, completed: 0, all: this.docs.size }; }
  rpc_list_documents({ p_scope, p_query }) {
    const rows = [...this.docs.values()].filter((d) => this.access(d))
      .filter((d) => p_scope !== 'my_drafts' || (d.created_by === this.me.id && d.status !== 'finalized'))
      .filter((d) => !p_query || JSON.stringify(d.form_data).toLowerCase().includes(p_query.toLowerCase()));
    return rows.map((d) => ({ id: d.id, patient_name: d.form_data.f_Name || '', mrd_number: d.form_data.f_MRD_No || '', irn: '', hospital_number: '', diagnosis: (d.form_data.f_Diagnosis || '').split('\n').join('; '),
      status: d.status, created_at: d.created_at, updated_at: d.updated_at, created_by: d.created_by, created_by_name: this.name(d.created_by), last_edited_by_name: this.name(d.last_edited_by),
      reviewer_name: this.name(d.reviewer_id), my_access: this.access(d), shared_with: [], editing_by: d.lease ? this.name(d.lease.editor_id) : null, amends_id: null, amendment_no: 0, superseded_by: null, total_count: rows.length }));
  }
  rpc_create_document({ p_form_data }) { return this.addDoc({ form_data: p_form_data || {}, created_by: this.me.id, last_edited_by: this.me.id }).id; }
  rpc_get_editor_state({ p_id }) {
    const d = this.doc(p_id), live = d.lease && d.lease.expires > Date.now() ? d.lease : null;
    return { id: d.id, status: d.status, version: d.version, form_data: structuredClone(d.form_data), created_by: d.created_by, created_by_name: this.name(d.created_by),
      last_edited_by_name: this.name(d.last_edited_by), updated_at: d.updated_at, reviewer_id: d.reviewer_id, reviewer_name: this.name(d.reviewer_id), review_note: d.review_note,
      submitted_at: d.submitted_at, approved_at: d.approved_at, approved_by_name: this.name(d.approved_by), finalized_at: d.finalized_at, finalized_by_name: this.name(d.finalized_by),
      amends_id: d.amends_id, amendment_no: d.amendment_no, superseded_by: d.superseded_by, my_access: this.access(d),
      lease: live ? { editor_id: live.editor_id, editor_name: this.name(live.editor_id), expires_at: new Date(live.expires).toISOString(), mine: live.editor_id === this.me.id } : null };
  }
  rpc_acquire_lease({ p_id, p_takeover }) {
    const d = this.doc(p_id), a = this.access(d);
    if (!['owner', 'edit'].includes(a)) throw new DspError('forbidden');
    if (d.status !== 'draft') throw new DspError('not_editable');
    const l = d.lease;
    if (l && l.expires > Date.now() && !p_takeover) return { acquired: false, editor_id: l.editor_id, editor_name: this.name(l.editor_id), expires_at: new Date(l.expires).toISOString(), held_by_me: l.editor_id === this.me.id };
    d.lease = { editor_id: this.me.id, token: randomUUID(), expires: Date.now() + 180_000 };
    return { acquired: true, lease_token: d.lease.token, expires_at: new Date(d.lease.expires).toISOString(), editor_id: this.me.id, editor_name: this.me.full_name, held_by_me: true };
  }
  rpc_renew_lease({ p_id, p_token }) { const d = this.doc(p_id); if (!d.lease || d.lease.token !== p_token) throw new DspError('lease_lost', { editor_name: d.lease ? this.name(d.lease.editor_id) : null }); d.lease.expires = Date.now() + 180_000; return new Date(d.lease.expires).toISOString(); }
  rpc_release_lease({ p_id, p_token }) { const d = this.doc(p_id); if (d.lease?.token === p_token) { d.lease = null; return true; } return false; }
  rpc_save_document({ p_id, p_expected_version, p_lease_token, p_form_data, p_reason }) {
    const d = this.doc(p_id);
    if (!['owner', 'edit'].includes(this.access(d))) throw new DspError('forbidden');
    if (d.status !== 'draft') throw new DspError('not_editable');
    if (!d.lease || d.lease.token !== p_lease_token || d.lease.editor_id !== this.me.id) throw new DspError('lease_lost', { editor_name: d.lease ? this.name(d.lease.editor_id) : null, held_by_me: false });
    if (d.version !== p_expected_version) throw new DspError('conflict', { server_version: d.version, last_edited_by_name: this.name(d.last_edited_by) });
    d.form_data = p_form_data; d.version++; d.last_edited_by = this.me.id; d.updated_at = new Date().toISOString(); d.lastReason = p_reason;
    return { version: d.version, updated_at: d.updated_at, lease_expires_at: new Date(d.lease.expires).toISOString(), revision_created: false };
  }
  rpc_list_doc_access({ p_id }) { const d = this.doc(p_id); return [{ user_id: d.created_by, full_name: this.name(d.created_by), designation: '', permission: 'owner', granted_by_name: null, is_owner: true },
    ...Object.entries(d.access).map(([u, p]) => ({ user_id: u, full_name: this.name(u), designation: '', permission: p, granted_by_name: this.me.full_name, is_owner: false }))]; }
  rpc_search_doctors({ p_query }) { return Object.values(this.users).filter((u) => u.id !== this.me.id && u.role !== 'admin' && u.full_name.toLowerCase().includes((p_query || '').toLowerCase()))
    .map((u) => ({ id: u.id, full_name: u.full_name, designation: u.designation, role: u.role, email: u.email, can_review: u.role === 'consultant' })); }
  rpc_share_document({ p_id, p_user, p_permission }) { const d = this.doc(p_id); if (this.access(d) !== 'owner') throw new DspError('forbidden'); d.access[p_user] = p_permission; return { changed: true }; }
  rpc_revoke_share({ p_id, p_user }) { const d = this.doc(p_id); delete d.access[p_user]; return null; }
  rpc_list_revisions() { return [{ revision_number: 1, doc_version: 1, reason: 'created', edited_by_name: this.me.full_name, created_at: new Date().toISOString() }]; }
  rpc_list_activity() { return [{ action: 'created', actor_name: this.me.full_name, created_at: new Date().toISOString(), metadata: {} }]; }
  rpc_submit_for_review({ p_id, p_reviewer, p_expected_version }) { const d = this.doc(p_id); if (d.version !== p_expected_version) throw new DspError('conflict'); d.status = 'in_review'; d.reviewer_id = p_reviewer; d.lease = null; d.submitted_at = new Date().toISOString(); d.access[p_reviewer] ||= 'review'; return { status: 'in_review' }; }
  rpc_approve_document({ p_id }) { const d = this.doc(p_id); d.status = 'approved'; d.approved_by = this.me.id; d.approved_at = new Date().toISOString(); return { status: 'approved' }; }
  rpc_finalize_document({ p_id, p_checklist }) { const d = this.doc(p_id); d.status = 'finalized'; d.finalized_by = this.me.id; d.finalized_at = new Date().toISOString(); d.checklist = p_checklist; return { status: 'finalized' }; }
  rpc_admin_list_users() { return Object.values(this.users).map((u) => ({ ...u, created_at: new Date().toISOString(), last_sign_in_at: null, invited_pending: true })); }
  rpc_admin_stats() { return { users_active: 3, users_inactive: 0, documents_by_status: { draft: this.docs.size }, documents_updated_7d: this.docs.size, active_editing_sessions: 0, revisions_stored: 0 }; }
  rpc_admin_recent_events() { return []; }
  rpc_admin_update_user(args) { const u = Object.values(this.users).find((x) => x.id === args.p_user); u.role = args.p_role; u.is_active = args.p_is_active; return null; }
  rpc_create_amendment({ p_id }) { const d = this.doc(p_id); const n = this.addDoc({ form_data: structuredClone(d.form_data), created_by: this.me.id, amends_id: d.id, amendment_no: 1 }); d.superseded_by = n.id; return n.id; }
}
