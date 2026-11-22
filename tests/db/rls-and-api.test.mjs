// Database security + workflow tests against a real PostgreSQL server running the real migrations.
// Every "client" call runs as the `authenticated` (or `anon`) role with JWT claims set, exactly like
// PostgREST does for Supabase — so these tests exercise RLS, grants and the SECURITY DEFINER API directly,
// independent of any frontend control.
//
//   bash tests/db/reset-db.sh && node --test tests/db/
//
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const cfg = {
  host: process.env.PGHOST || '127.0.0.1', port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres',
  database: process.env.DSP_TEST_DB || 'dsp_test',
};
let admin; // superuser connection (test setup only)
const U = {};

async function asUser(uid, role, fn) {
  const c = new pg.Client(cfg); await c.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    if (uid) await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { await c.end(); }
}
const client = (name) => ({
  rpc: (fn, args = {}) => asUser(U[name], 'authenticated', async (c) => {
    const keys = Object.keys(args);
    const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const r = await c.query(sql, keys.map((k) => args[k]));
    return r.rows;
  }),
  one: async (fn, args = {}) => { const rows = await client(name).rpc(fn, args); const v = rows[0]; return v && Object.keys(v).length === 1 ? Object.values(v)[0] : v; },
  sql: (q, p = []) => asUser(U[name], 'authenticated', async (c) => (await c.query(q, p)).rows),
});
const anon = { sql: (q, p = []) => asUser(null, 'anon', async (c) => (await c.query(q, p)).rows) };
async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    const m = String(e.message || e);
    if (code && !m.includes(code)) { assert.fail(`expected ${code}, got: ${m}`); }
    return true;
  });
}

const FORM = (name, extra = {}) => ({
  f_Name: name, f_Age: '54', f_Sex: 'Male', f_MRD_No: 'MRD-' + name.slice(0, 3).toUpperCase(), f_IRN: 'IRN-77',
  f_Hospital_No: 'H-1', f_Diagnosis: 'Choledocholithiasis\r\nCholangitis', f_Date_of_admission: '2026-11-01',
  f_Date_of_discharge: '2026-11-08', __labs: { pre: [], post: [] }, __meds: [], __ot: { pre: [], post: [], img: [], hpe: [] }, __procs: [], ...extra,
});

before(async () => {
  admin = new pg.Client(cfg); await admin.connect();
  const mk = async (key, email, role, active, name) => {
    const r = await admin.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { full_name: name }]);
    U[key] = r.rows[0].id;
    if (role) await admin.query(`update public.profiles set role = $2, is_active = $3 where id = $1`, [U[key], role, active]);
  };
  await mk('admin', 'admin@test.local', 'admin', true, 'Test Admin');
  await mk('d1', 'd1@test.local', 'doctor', true, 'Dr Synthetic One');
  await mk('d2', 'd2@test.local', 'doctor', true, 'Dr Synthetic Two');
  await mk('d3', 'd3@test.local', 'doctor', true, 'Dr Synthetic Three');
  await mk('c1', 'c1@test.local', 'consultant', true, 'Dr Consultant One');
  await mk('x', 'inactive@test.local', null, null, 'Dr Pending');
});
after(async () => { await admin?.end(); });

const D1 = client('d1'), D2 = client('d2'), D3 = client('d3'), C1 = client('c1'), A = client('admin'), X = client('x');
let doc, lease1;

test('new auth users get an INACTIVE profile and cannot do anything', async () => {
  const p = await admin.query('select is_active, role from public.profiles where id = $1', [U.x]);
  assert.equal(p.rows[0].is_active, false);
  await rejects(X.one('create_document', { p_form_data: FORM('Nobody') }), 'DSP:inactive');
  const ctx = await X.one('my_context');
  assert.equal(ctx.is_active, false);
  assert.deepEqual(ctx.capabilities, []);
  assert.equal((await X.sql('select * from public.profiles')).length, 1, 'inactive user only sees own profile');
});

test('anon role has no table or function access', async () => {
  await rejects(anon.sql('select * from public.discharge_summaries'), 'permission denied');
  await rejects(anon.sql('select * from public.profiles'), 'permission denied');
  await rejects(anon.sql(`select public.create_document('{}'::jsonb)`), 'permission denied');
  await rejects(anon.sql(`select public.my_context()`), 'permission denied');
});

test('create_document extracts index columns server-side and records revision + activity', async () => {
  doc = await D1.one('create_document', { p_form_data: FORM('Test Patient Alpha') });
  const row = (await D1.sql('select patient_name, mrd_number, diagnosis, status, version, created_by from public.discharge_summaries where id = $1', [doc]))[0];
  assert.equal(row.patient_name, 'Test Patient Alpha');
  assert.equal(row.mrd_number, 'MRD-TES');
  assert.equal(row.diagnosis, 'Choledocholithiasis; Cholangitis');
  assert.equal(row.status, 'draft'); assert.equal(row.version, 1); assert.equal(row.created_by, U.d1);
  const revs = await D1.rpc('list_revisions', { p_id: doc });
  assert.equal(revs.length, 1); assert.equal(revs[0].reason, 'created');
  const act = await D1.rpc('list_activity', { p_id: doc });
  assert.equal(act[0].action, 'created');
});

test('clients cannot write clinical tables directly — even their own rows', async () => {
  await rejects(D1.sql(`update public.discharge_summaries set status = 'finalized' where id = $1`, [doc]), 'permission denied');
  await rejects(D1.sql(`delete from public.discharge_summaries where id = $1`, [doc]), 'permission denied');
  await rejects(D1.sql(`insert into public.discharge_summaries (created_by) values ($1)`, [U.d1]), 'permission denied');
  await rejects(D1.sql(`insert into public.document_permissions (document_id, user_id, permission, granted_by) values ($1, $2, 'edit', $3)`, [doc, U.d2, U.d1]), 'permission denied');
  await rejects(D1.sql(`insert into public.editing_leases (document_id, editor_id, expires_at) values ($1, $2, now() + interval '1 day')`, [doc, U.d1]), 'permission denied');
  await rejects(D1.sql(`update public.profiles set role = 'admin' where id = $1`, [U.d1]), 'permission denied');
});

test('unauthorised doctor cannot read, guess IDs, lease, save or share', async () => {
  assert.equal((await D2.sql('select id from public.discharge_summaries')).length, 0);
  assert.equal((await D2.sql('select * from public.document_revisions')).length, 0);
  assert.equal((await D2.sql('select * from public.document_activity')).length, 0);
  await rejects(D2.one('get_editor_state', { p_id: doc }), 'DSP:not_found');
  await rejects(D2.one('get_editor_state', { p_id: '00000000-0000-4000-8000-000000000000' }), 'DSP:not_found');
  await rejects(D2.one('acquire_lease', { p_id: doc }), 'DSP:not_found');
  await rejects(D2.one('save_document', { p_id: doc, p_expected_version: 1, p_lease_token: '00000000-0000-4000-8000-000000000000', p_form_data: FORM('Hijack') }), 'DSP:not_found');
  await rejects(D2.one('share_document', { p_id: doc, p_user: U.d2, p_permission: 'edit' }), 'DSP:not_found');
  await rejects(D2.one('get_revision', { p_id: doc, p_revision: 1 }), 'DSP:not_found');
  assert.equal((await D2.rpc('list_documents', { p_scope: 'all' })).length, 0);
});

test('admin role has no automatic access to clinical records', async () => {
  assert.equal((await A.sql('select id from public.discharge_summaries')).length, 0);
  await rejects(A.one('get_editor_state', { p_id: doc }), 'DSP:not_found');
  assert.equal((await A.rpc('list_documents', { p_scope: 'all' })).length, 0);
  await rejects(A.one('create_document', { p_form_data: {} }), 'DSP:forbidden');
  const stats = await A.one('admin_stats');
  assert.ok(stats.documents_by_status.draft >= 1, 'admin sees counts only');
});

test('editing lease + optimistic versioning', async () => {
  const l = await D1.one('acquire_lease', { p_id: doc });
  assert.equal(l.acquired, true); lease1 = l.lease_token;
  const s = await D1.one('save_document', { p_id: doc, p_expected_version: 1, p_lease_token: lease1, p_form_data: FORM('Test Patient Alpha', { f_Age: '55' }) });
  assert.equal(s.version, 2);
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 1, p_lease_token: lease1, p_form_data: FORM('Stale') }), 'DSP:conflict');
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: '00000000-0000-4000-8000-000000000000', p_form_data: FORM('X') }), 'DSP:lease_lost');
  const again = await D1.one('acquire_lease', { p_id: doc });
  assert.equal(again.acquired, false, 'second tab of the same user does not silently steal');
  assert.equal(again.held_by_me, true);
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: lease1, p_form_data: { not: 'x', big: 'y'.repeat(2100000) } }), 'DSP:too_large');
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: lease1, p_form_data: FORM('X'), p_reason: 'status_change' }), 'DSP:invalid');
});

test('view-only share: can read, cannot lease, save or reshare', async () => {
  await D1.one('share_document', { p_id: doc, p_user: U.d2, p_permission: 'view' });
  const st = await D2.one('get_editor_state', { p_id: doc });
  assert.equal(st.my_access, 'view'); assert.equal(st.form_data.f_Age, '55');
  assert.equal(st.lease.editor_name, 'Dr Synthetic One');
  await rejects(D2.one('acquire_lease', { p_id: doc }), 'DSP:forbidden');
  await rejects(D2.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: lease1, p_form_data: FORM('X') }), 'DSP:forbidden');
  await rejects(D2.one('share_document', { p_id: doc, p_user: U.d3, p_permission: 'view' }), 'DSP:forbidden');
  const scoped = await D2.rpc('list_documents', { p_scope: 'shared_with_me' });
  assert.equal(scoped.length, 1); assert.equal(scoped[0].my_access, 'view');
});

test('edit share + lease takeover + stale editor is rejected + editor identity cannot be forged', async () => {
  await D1.one('share_document', { p_id: doc, p_user: U.d2, p_permission: 'edit' });
  const busy = await D2.one('acquire_lease', { p_id: doc });
  assert.equal(busy.acquired, false); assert.equal(busy.editor_name, 'Dr Synthetic One');
  const take = await D2.one('acquire_lease', { p_id: doc, p_takeover: true });
  assert.equal(take.acquired, true);
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: lease1, p_form_data: FORM('Late write') }), 'DSP:lease_lost');
  const s = await D2.one('save_document', { p_id: doc, p_expected_version: 2, p_lease_token: take.lease_token, p_form_data: FORM('Test Patient Alpha', { f_Age: '56' }) });
  assert.equal(s.version, 3); assert.equal(s.revision_created, true, 'handover snapshot');
  const row = (await D1.sql('select last_edited_by, created_by from public.discharge_summaries where id = $1', [doc]))[0];
  assert.equal(row.last_edited_by, U.d2); assert.equal(row.created_by, U.d1, 'creator stays identifiable');
  const act = (await D1.rpc('list_activity', { p_id: doc })).map((a) => a.action);
  assert.ok(act.includes('editing_taken_over'));
  // the previous editor's last state (version 2, never snapshotted) was captured before the handover
  const cp = (await admin.query(`select reason, doc_version, edited_by, snapshot->>'f_Age' age from public.document_revisions where document_id = $1 order by revision_number`, [doc])).rows;
  const pre = cp.find((r) => r.reason === 'checkpoint');
  assert.ok(pre, 'checkpoint exists'); assert.equal(pre.doc_version, 2); assert.equal(pre.edited_by, U.d1); assert.equal(pre.age, '55');
  assert.ok(cp.some((r) => r.reason === 'handover' && r.doc_version === 3 && r.age === '56'));
  await D2.one('release_lease', { p_id: doc, p_token: take.lease_token });
  assert.equal((await D1.sql('select * from public.editing_leases where document_id = $1', [doc])).length, 0);
});

test('editors may reshare (view/edit); revocation removes access immediately', async () => {
  await D2.one('share_document', { p_id: doc, p_user: U.d3, p_permission: 'view' });
  assert.equal((await D3.sql('select id from public.discharge_summaries')).length, 1);
  await rejects(D2.one('share_document', { p_id: doc, p_user: U.d3, p_permission: 'review' }), 'DSP:invalid');
  await rejects(D2.one('share_document', { p_id: doc, p_user: U.x, p_permission: 'view' }), 'DSP:invalid');   // inactive recipient
  await rejects(D2.one('share_document', { p_id: doc, p_user: U.admin, p_permission: 'view' }), 'DSP:invalid'); // non-clinical recipient
  await D1.one('revoke_share', { p_id: doc, p_user: U.d3 });
  assert.equal((await D3.sql('select id from public.discharge_summaries')).length, 0);
  await rejects(D3.one('get_editor_state', { p_id: doc }), 'DSP:not_found');
  const access = await D1.rpc('list_doc_access', { p_id: doc });
  assert.deepEqual(access.map((a) => a.permission).sort(), ['edit', 'owner']);
});

test('roles cannot be self-escalated; admin guard rails', async () => {
  await rejects(D1.one('admin_update_user', { p_user: U.d1, p_role: 'admin', p_is_active: true }), 'DSP:forbidden');
  await rejects(D1.one('admin_set_capability', { p_role: 'doctor', p_capability: 'finalize_document', p_enabled: true }), 'DSP:forbidden');
  assert.equal(await D1.one('has_capability', { cap: 'manage_users' }), false);
  await rejects(A.one('admin_update_user', { p_user: U.admin, p_role: 'admin', p_is_active: false }), 'DSP:self_action');
  await rejects(A.one('admin_set_capability', { p_role: 'admin', p_capability: 'manage_users', p_enabled: false }), 'DSP:last_admin');
  const users = await A.rpc('admin_list_users');
  assert.ok(users.length >= 6);
});

test('review workflow: submit, block edits, approve, finalize, protect, amend', async () => {
  const l = await D1.one('acquire_lease', { p_id: doc });
  await rejects(D1.one('submit_for_review', { p_id: doc, p_reviewer: U.d2, p_expected_version: 3 }), 'DSP:reviewer_required');
  await rejects(D1.one('submit_for_review', { p_id: doc, p_reviewer: U.c1, p_expected_version: 2 }), 'DSP:conflict');
  await D1.one('submit_for_review', { p_id: doc, p_reviewer: U.c1, p_expected_version: 3 });
  await rejects(D1.one('save_document', { p_id: doc, p_expected_version: 3, p_lease_token: l.lease_token, p_form_data: FORM('X') }), 'DSP:not_editable');
  assert.equal((await C1.rpc('list_documents', { p_scope: 'pending_review' })).length, 1);
  await rejects(C1.one('acquire_lease', { p_id: doc }), 'DSP:forbidden');           // reviewer access is not edit access
  await rejects(D2.one('approve_document', { p_id: doc, p_expected_version: 3 }), 'DSP:forbidden');
  await C1.one('approve_document', { p_id: doc, p_expected_version: 3 });
  await rejects(D1.one('finalize_document', { p_id: doc, p_expected_version: 3 }), 'DSP:forbidden'); // doctors lack finalize
  await C1.one('finalize_document', { p_id: doc, p_expected_version: 3, p_checklist: { medicines: true, follow_up: true } });
  const fin = await D1.one('get_editor_state', { p_id: doc });
  assert.equal(fin.status, 'finalized'); assert.equal(fin.finalized_by_name, 'Dr Consultant One');
  await rejects(D1.one('acquire_lease', { p_id: doc }), 'DSP:not_editable');
  await rejects(D1.one('delete_document', { p_id: doc }), 'DSP:not_editable');
  await rejects(C1.one('return_for_correction', { p_id: doc, p_comment: 'x' }), 'DSP:not_editable');
  // amendment: new traceable draft, original untouched
  const before = (await admin.query('select form_data, version, updated_at from public.discharge_summaries where id = $1', [doc])).rows[0];
  const am = await D1.one('create_amendment', { p_id: doc });
  const after = (await admin.query('select form_data, version, superseded_by, status from public.discharge_summaries where id = $1', [doc])).rows[0];
  assert.deepEqual(after.form_data, before.form_data); assert.equal(after.version, before.version);
  assert.equal(after.status, 'finalized'); assert.equal(after.superseded_by, am);
  const amd = await D1.one('get_editor_state', { p_id: am });
  assert.equal(amd.status, 'draft'); assert.equal(amd.amends_id, doc); assert.equal(amd.amendment_no, 1);
  assert.equal((await D2.one('get_editor_state', { p_id: am })).my_access, 'edit', 'care team carried over');
  await rejects(D1.one('create_amendment', { p_id: doc }), 'DSP:already_amended');
});

test('return for correction and server-side validation on approval', async () => {
  const id = await D1.one('create_document', { p_form_data: FORM('Test Patient Beta', { f_Date_of_admission: '2026-11-10', f_Date_of_discharge: '2026-11-02' }) });
  await D1.one('submit_for_review', { p_id: id, p_reviewer: U.c1, p_expected_version: 1 });
  await rejects(C1.one('approve_document', { p_id: id, p_expected_version: 1 }), 'DSP:validation');
  await C1.one('return_for_correction', { p_id: id, p_comment: 'Dates reversed' });
  const st = await D1.one('get_editor_state', { p_id: id });
  assert.equal(st.status, 'draft'); assert.equal(st.review_note, 'Dates reversed');
  // self-approval requires the capability (consultant yes, doctor no)
  await rejects(D1.one('approve_document', { p_id: id, p_expected_version: 1 }), 'DSP:forbidden');
  // recall
  await D1.one('submit_for_review', { p_id: id, p_reviewer: U.c1, p_expected_version: 1 });
  await D1.one('recall_from_review', { p_id: id });
  assert.equal((await D1.one('get_editor_state', { p_id: id })).status, 'draft');
  await D1.one('delete_document', { p_id: id });
  await rejects(D1.one('get_editor_state', { p_id: id }), 'DSP:not_found');
  await rejects(C1.one('get_editor_state', { p_id: id }), 'DSP:not_found');
});

test('deactivated doctor loses all access at once', async () => {
  const id = await D1.one('create_document', { p_form_data: FORM('Test Patient Gamma') });
  await D1.one('share_document', { p_id: id, p_user: U.d3, p_permission: 'edit' });
  const l = await D3.one('acquire_lease', { p_id: id });
  assert.equal(l.acquired, true);
  await A.one('admin_update_user', { p_user: U.d3, p_role: 'doctor', p_is_active: false });
  assert.equal((await D3.sql('select id from public.discharge_summaries')).length, 0);
  await rejects(D3.one('get_editor_state', { p_id: id }), 'DSP:inactive');
  await rejects(D3.one('save_document', { p_id: id, p_expected_version: 1, p_lease_token: l.lease_token, p_form_data: FORM('X') }), 'DSP:inactive');
  assert.equal((await admin.query('select count(*)::int n from public.editing_leases where editor_id = $1', [U.d3])).rows[0].n, 0);
  await A.one('admin_update_user', { p_user: U.d3, p_role: 'doctor', p_is_active: true });
});

test('dashboard listing: scopes, search, wildcard escaping, counts, no form body', async () => {
  const id = await D2.one('create_document', { p_form_data: FORM('Zeta Synthetic', { f_MRD_No: 'MRD-998877' }) });
  const mine = await D2.rpc('list_documents', { p_scope: 'my_drafts', p_query: '998877' });
  assert.equal(mine.length, 1); assert.equal(mine[0].id, id); assert.equal(mine[0].total_count, '1');
  assert.ok(!('form_data' in mine[0]));
  assert.equal((await D2.rpc('list_documents', { p_scope: 'all', p_query: '%' })).length, 0, '% is literal');
  assert.equal((await D2.rpc('list_documents', { p_scope: 'all', p_query: 'cholangitis' })).length >= 1, true);
  await rejects(D2.rpc('list_documents', { p_scope: 'everything' }), 'DSP:invalid');
  const counts = await D2.one('dashboard_counts');
  assert.equal(counts.my_drafts, 1); assert.ok(counts.shared_with_me >= 1);
  assert.equal((await D1.rpc('list_documents', { p_scope: 'all' })).some((r) => r.id === id), false);
});

test('user settings are private to each doctor', async () => {
  await D1.sql(`insert into public.user_settings (user_id, data) values ($1, '{"dsm_hist":{"Diagnosis":["x"]}}')`, [U.d1]);
  assert.equal((await D2.sql('select * from public.user_settings')).length, 0);
  await rejects(D2.sql(`insert into public.user_settings (user_id, data) values ($1, '{}')`, [U.d1]), 'row-level security');
  await rejects(D2.sql(`update public.user_settings set data = '{}' where user_id = $1 returning 1`, [U.d1]).then((r) => { if (!r.length) throw new Error('row-level security: 0 rows'); }), 'row-level security');
});

test('revision retention keeps at most 100 autosave snapshots', async () => {
  const id = await D1.one('create_document', { p_form_data: FORM('Retention') });
  await asUser(U.d1, 'postgres', async (c) => {
    for (let i = 0; i < 110; i++) await c.query(`select public._add_revision($1, '{}'::jsonb, 1, 'autosave')`, [id]);
  });
  const n = (await admin.query(`select count(*) filter (where reason='autosave')::int a, count(*) filter (where reason='created')::int c from public.document_revisions where document_id=$1`, [id])).rows[0];
  assert.equal(n.a, 100); assert.equal(n.c, 1);
});

test('internal helpers are not callable by clients; client events are whitelisted', async () => {
  await rejects(D1.sql(`select public._add_revision(gen_random_uuid(), '{}'::jsonb, 1, 'autosave')`), 'permission denied');
  await rejects(D1.sql(`select public._log(null, 'x')`), 'permission denied');
  const id = await D1.one('create_document', { p_form_data: FORM('Events') });
  await D1.one('log_client_event', { p_id: id, p_action: 'exported_docx' });
  await rejects(D1.one('log_client_event', { p_id: id, p_action: 'finalized' }), 'DSP:invalid');
});

test('rate limiting on document creation', async () => {
  await admin.query(`update public.rate_limits set count = 60 where user_id = $1 and bucket = 'create'`, [U.d1]);
  await rejects(D1.one('create_document', { p_form_data: {} }), 'DSP:rate_limited');
  await admin.query(`delete from public.rate_limits where user_id = $1`, [U.d1]);
});
