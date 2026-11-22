// End-to-end tests of the multi-doctor application (login, dashboard, editor shell, autosave,
// leases, conflicts, recovery, sharing, workflow) against an in-memory Supabase mock.
// The production build is served with the production security headers (CSP included).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../scripts/serve.mjs';
import { MockSupabase, SUPABASE_URL } from './mock-supabase.mjs';
import { CASES } from '../fixtures/cases.mjs';
import { ROOT } from './harness.mjs';

let srv;
const DIST = join(ROOT, 'tests/.tmp/dist');
test.beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], {
    env: { ...process.env, DSP_OUT_DIR: 'tests/.tmp/dist', SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only', DSP_APP_ENV: 'test', DSP_IDLE_SIGNOUT_MINUTES: '0' },
  });
  srv = await startServer({ dir: DIST });
});
test.afterAll(async () => srv?.server.close());

const problems = [];
async function open(page, mock, path, user = 'd1') {
  await mock.install(page.context());
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) problems.push(`csp: ${m.text()}`); });
  if (user) {
    await page.goto(srv.url + '/favicon.svg');
    await page.evaluate((s) => localStorage.setItem('dsp-auth', JSON.stringify(s)), mock.as(user).session(user));
  }
  await page.goto(srv.url + path);
}
const editorReady = (page) => page.waitForFunction(() => window.DSP && document.querySelectorAll('#nav button').length > 0 && !document.getElementById('ed-boot'));
const saveCalls = (mock) => mock.callsOf('save_document');
async function waitForSave(mock, n) { await expect.poll(() => saveCalls(mock).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(n); }
const typeInto = async (page, sel, text) => { await page.click(sel); await page.keyboard.type(text); };

test.afterEach(() => { expect(problems, 'no page errors or CSP violations').toEqual([]); problems.length = 0; });

test('dashboard lists summaries, searches server-side and opens the editor', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Alpha', f_MRD_No: 'MRD-1', f_Diagnosis: 'Acute pancreatitis' } });
  await open(page, mock, '/index.html');
  await expect(page.locator('#hello')).toContainText('Dr Synthetic One');
  await expect(page.locator('#rows tr.doc')).toHaveCount(1);
  await expect(page.locator('#rows')).toContainText('Test Patient Alpha');
  await expect(page.locator('#rows')).toContainText('MRD MRD-1');
  await page.fill('#q', 'pancrea');
  await expect.poll(() => mock.callsOf('list_documents').at(-1)?.args.p_query).toBe('pancrea');
  expect(await page.evaluate(() => location.search + location.hash)).toBe('');        // search text never goes into the URL
  await page.click('.tab[data-s="all"]');
  await expect.poll(() => mock.callsOf('list_documents').at(-1)?.args.p_scope).toBe('all');
  await page.click('#rows tr.doc');
  await page.waitForURL(`**/editor.html#id=${d.id}`);
  await editorReady(page);
  await expect(page.locator('#ab-pt')).toHaveText('Test Patient Alpha');
  expect(await page.inputValue('#f_Name')).toBe('Test Patient Alpha');
});

test('new summary: autosave is debounced, versioned and lease-checked; status is shown', async ({ page }) => {
  const mock = new MockSupabase();
  await open(page, mock, '/index.html');
  await page.click('#new');
  await editorReady(page);
  const token = mock.callsOf('acquire_lease')[0] && [...mock.docs.values()][0].lease.token;
  await expect(page.locator('#save')).toHaveText('All changes saved');
  await typeInto(page, '#f_Name', 'Test Patient Epsilon');
  await expect(page.locator('#save')).toHaveText('Unsaved changes');
  expect(saveCalls(mock).length).toBe(0);                                      // nothing sent while typing
  await waitForSave(mock, 1);
  expect(saveCalls(mock).length).toBe(1);                                      // one save for the whole burst
  const c = saveCalls(mock)[0].args;
  expect(c.p_expected_version).toBe(1); expect(c.p_lease_token).toBe(token); expect(c.p_form_data.f_Name).toBe('Test Patient Epsilon');
  await expect(page.locator('#save')).toHaveText(/^Saved \d/);
  await expect(page.locator('#ab-pt')).toHaveText('Test Patient Epsilon');
  await page.fill('#f_Age', '61');
  await waitForSave(mock, 2);
  expect(saveCalls(mock)[1].args.p_expected_version).toBe(2);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('f_Age');   // focus untouched by saving
  await page.keyboard.press('Control+KeyS');                                   // explicit checkpoint
  await expect.poll(() => saveCalls(mock).at(-1)?.args.p_reason).toBe('manual');
});

test('offline: changes are kept locally, shown as not saved, and saved after reconnection', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Zeta' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  mock.offline = true;
  await page.fill('#f_Name', 'Test Patient Zeta Updated');
  await expect(page.locator('#save')).toHaveText(/^Offline/, { timeout: 10_000 });
  await expect(page.locator('#save')).not.toHaveText(/Saved/);
  const rec = await page.evaluate(() => Object.entries(sessionStorage).find(([k]) => k.startsWith('dsp_rec:')));
  expect(JSON.parse(JSON.parse(rec[1]).data).f_Name).toBe('Test Patient Zeta Updated');
  mock.offline = false;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.locator('#save')).toHaveText(/^Saved/, { timeout: 10_000 });
  expect(d.form_data.f_Name).toBe('Test Patient Zeta Updated');
  expect(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('dsp_rec:')))).toBe(false);
});

test('conflict: a newer server version is never overwritten; user is told and the form locks', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Eta' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  d.version = 7; d.form_data = { f_Name: 'Changed elsewhere' };              // someone else's write slipped in
  await page.fill('#f_Age', '33');
  await expect(page.getByRole('heading', { name: 'Conflict detected' })).toBeVisible({ timeout: 10_000 });
  expect(d.form_data).toEqual({ f_Name: 'Changed elsewhere' });
  await expect(page.locator('#save')).toHaveText('Conflict detected');
  await expect(page.locator('#f_Age')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download my changes' })).toBeVisible();
});

test('another doctor is editing: read-only view with name, then explicit take-over', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Theta' }, access: {} });
  d.lease = { editor_id: mock.users.d2.id, token: 'other', expires: Date.now() + 120_000 };
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await expect(page.locator('#ed-banners')).toContainText('Dr Synthetic Two is editing this summary');
  await expect(page.locator('#f_Name')).toBeDisabled();
  await expect(page.locator('#addmed')).toBeHidden();
  await expect(page.locator('#save')).toHaveText('Read-only');
  await page.getByRole('button', { name: 'Take over editing' }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Take over' }).click()]);
  await editorReady(page);
  expect(mock.callsOf('acquire_lease').at(-1).args.p_takeover).toBe(true);
  await expect(page.locator('#f_Name')).toBeEnabled();
});

test('editing taken over mid-session: stale editor is stopped with a clear message', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Iota' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  d.lease = { editor_id: mock.users.d2.id, token: 'theirs', expires: Date.now() + 120_000 };
  await page.fill('#f_Age', '70');
  await expect(page.getByRole('heading', { name: 'Editing taken over' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('dialog')).toContainText('Dr Synthetic Two');
  await expect(page.locator('#f_Age')).toBeDisabled();
  expect(d.form_data.f_Age).toBeUndefined();
});

test('view-only access: no lease, no editing controls; preview and export still work', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ created_by: mock.users.d2.id, form_data: CASES.surgical_complex, access: { [mock.users.d1.id]: 'view' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  expect(mock.callsOf('acquire_lease').length).toBe(0);
  await expect(page.locator('#ed-banners')).toContainText('view-only');
  await expect(page.locator('#save')).toHaveText('View only');
  await expect(page.locator('#chk')).toBeHidden();
  await expect(page.locator('#clr')).toBeHidden();
  await page.locator('#meds .mi').first().click();
  await expect(page.locator('#mp')).toBeHidden();                                 // medicine editor does not open
  await page.click('#show');
  await expect(page.locator('#paper')).toContainText('Pancreaticoduodenectomy');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#word')]);
  expect(dl.suggestedFilename()).toMatch(/^Discharge Summary - Test Patient Alpha/);
  await expect.poll(() => mock.callsOf('log_client_event').map((c) => c.args.p_action)).toContain('exported_docx');
  expect(saveCalls(mock).length).toBe(0);
});

test('unsaved changes survive a reload and can be restored on top of the server copy', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Kappa' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  mock.offline = true;
  await page.fill('#f_Name', 'Test Patient Kappa Recovered');
  await expect(page.locator('#save')).toHaveText(/^Offline/, { timeout: 10_000 });
  page.once('dialog', (dlg) => dlg.accept());                                 // "leave page?" warning appears
  mock.offline = false;
  await page.reload();
  await editorReady(page);
  await expect(page.locator('#f_Name')).toBeEnabled();                          // same tab re-acquired its own lease
  await expect(page.locator('#ed-banners')).toContainText('did not reach the server');
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Restore my changes' }).click()]);
  await editorReady(page);
  expect(saveCalls(mock).at(-1).args.p_reason).toBe('restore');
  expect(await page.inputValue('#f_Name')).toBe('Test Patient Kappa Recovered');
  await expect(page.locator('#ed-banners')).not.toContainText('did not reach the server');
});

test('pre-submission checks block missing essentials and jump to the field', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: {} });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.click('#ab-flow');
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('heading')).toHaveText('Please fix before continuing');
  await expect(dlg).toContainText('Patient name is missing.');
  await expect(dlg).toContainText('Diagnosis is missing.');
  await dlg.locator('li', { hasText: 'Patient name is missing.' }).getByRole('button', { name: 'Go to field' }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('f_Name');
  expect(mock.callsOf('submit_for_review').length).toBe(0);
});

test('submit for review → choose consultant → read-only "in review" state', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: CASES.surgical_complex });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.click('#ab-flow');
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();      // warnings only
  await page.getByRole('dialog').locator('.pick', { hasText: 'Dr Consultant One' }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Submit for review' }).click()]);
  await editorReady(page);
  const call = mock.callsOf('submit_for_review')[0].args;
  expect(call.p_reviewer).toBe(mock.users.c1.id); expect(call.p_expected_version).toBe(1);
  await expect(page.locator('#ed-banners')).toContainText('Submitted for review to Dr Consultant One');
  await expect(page.locator('#ab-status')).toHaveText('In review');
  await expect(page.locator('#f_Name')).toBeDisabled();
});

test('consultant approves and finalizes with the checklist; finalized summary is locked', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: CASES.surgical_complex, status: 'in_review', access: {} });
  d.reviewer_id = mock.users.c1.id; d.access[mock.users.c1.id] = 'review'; d.submitted_at = new Date().toISOString();
  await open(page, mock, `/editor.html#id=${d.id}`, 'c1');
  await editorReady(page);
  await expect(page.locator('#ed-banners')).toContainText('Awaiting your review');
  await page.click('#ab-flow');                                                            // Approve
  const dlg = page.getByRole('dialog');
  if (await dlg.getByRole('button', { name: 'Continue' }).isVisible()) await dlg.getByRole('button', { name: 'Continue' }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()]);
  await editorReady(page);
  await expect(page.locator('#ab-status')).toHaveText('Approved');
  await page.click('#ab-flow');                                                            // Finalize
  if (await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).isVisible()) await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
  const fin = page.getByRole('dialog');
  await fin.getByRole('button', { name: 'Finalize' }).click();
  await expect(fin).toContainText('Please confirm every item.');
  for (const c of await fin.locator('input[type=checkbox]').all()) await c.check();
  await Promise.all([page.waitForEvent('load'), fin.getByRole('button', { name: 'Finalize' }).click()]);
  await editorReady(page);
  expect(d.checklist.medicines).toBe(true);
  await expect(page.locator('#ed-banners')).toContainText('Finalized');
  await expect(page.locator('#ab-flow')).toHaveText('Create amendment');
  await expect(page.locator('#f_Name')).toBeDisabled();
  await page.click('#ab-flow');
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Create amendment' }).click()]);
  await editorReady(page);
  await expect(page.locator('#ed-banners')).toContainText('amendment 1');
  await expect(page.locator('#f_Name')).toBeEnabled();
  expect(d.superseded_by).toBeTruthy();
});

test('Load from file in the cloud editor replaces content as a new, recoverable version', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Old content' } });
  const file = join(ROOT, 'tests/.tmp/case.json');
  writeFileSync(file, JSON.stringify(CASES.conservative_minimal));
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.setInputFiles('#ldf', file);
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Load file' }).click()]);
  await editorReady(page);
  expect(saveCalls(mock).at(-1).args.p_reason).toBe('file_load');
  expect(await page.inputValue('#f_Name')).toBe('Test Patient Beta');
});

test('sharing dialog searches doctors and grants edit access', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Lambda' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.click('#ab-share');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('identifiable patient information');
  await dlg.locator('#sh-q').fill('Two');
  await dlg.locator('.pick', { hasText: 'Dr Synthetic Two' }).click();
  await expect(dlg.locator('#sh-acl')).toContainText('Dr Synthetic Two');
  expect(mock.callsOf('share_document')[0].args).toMatchObject({ p_user: mock.users.d2.id, p_permission: 'edit' });
});

test('remembered entries are stored per doctor and synced to their private settings', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: {} });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.fill('#f_Consultant', 'Dr Remembered Consultant');
  await page.locator('#f_Consultant').blur();
  await expect.poll(() => mock.callsOf('user_settings:upsert').at(-1)?.args.dsm_hist?.Consultant, { timeout: 6000 }).toEqual(['Dr Remembered Consultant']);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.startsWith('dsm'))).toEqual([]);                         // nothing in the shared, un-namespaced keys
});

test('print and preview run under the production Content-Security-Policy', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: CASES.surgical_complex });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('#prt');
  await expect.poll(() => page.evaluate(() => { const f = document.querySelector('iframe'); return f ? f.contentDocument.querySelectorAll('.pg').length : 0; })).toBeGreaterThan(1);
  const footer = await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('.pg .ft').textContent);
  expect(footer).toMatch(/^Page 1 of \d+$/);
});

test('login: clear error for wrong password; success goes to the requested page', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Mu' } });
  await open(page, mock, `/editor.html#id=${d.id}`, null);
  await page.waitForURL(/login\.html\?next=editor\.html/);
  await page.fill('#email', 'd1@test.local');
  await page.fill('#pw', 'wrong-password-1');
  await page.click('#go');
  await expect(page.locator('#err')).toHaveText('Email or password is incorrect.');
  await page.click('.pw-toggle');
  await expect(page.locator('#pw')).toHaveAttribute('type', 'text');
  await page.fill('#pw', 'correct-horse-12');
  await page.click('#go');
  await page.waitForURL(`**/editor.html#id=${d.id}`);
  await editorReady(page);
});

test('"Clear all" in a shared draft keeps the previous content as a History checkpoint', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: CASES.conservative_minimal });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  await page.click('#clr');
  await expect(page.locator('#msg')).toContainText('Tap again to confirm');
  await page.click('#clr');
  await waitForSave(mock, 1);
  const c = saveCalls(mock)[0].args;
  expect(c.p_reason).toBe('manual');            // server snapshots the pre-clear state before overwriting
  expect(c.p_form_data.f_Name).toBe('');
});

test('expired session while editing: changes are held, user signs in again in place, save resumes', async ({ page }) => {
  const mock = new MockSupabase();
  const d = mock.addDoc({ form_data: { f_Name: 'Test Patient Nu' } });
  await open(page, mock, `/editor.html#id=${d.id}`);
  await editorReady(page);
  mock.fail.save_document = { status: 401, body: { code: 'PGRST301', message: 'JWT expired', details: null, hint: null }, times: 1 };
  await page.fill('#f_Age', '48');
  await expect(page.getByRole('heading', { name: 'Sign in to keep saving' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#save')).toHaveText('Session expired · Sign in');
  await page.fill('#ra-p', 'correct-horse-12');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#save')).toHaveText(/^Saved/, { timeout: 10_000 });
  expect(d.form_data.f_Age).toBe('48');
});

test('admin console lists accounts; doctors cannot open it', async ({ page }) => {
  const mock = new MockSupabase();
  await open(page, mock, '/admin.html', 'admin');
  await expect(page.locator('#users')).toContainText('Dr Synthetic Two');
  await expect(page.locator('#caps')).toContainText('Finalize');
  await expect(page.locator('#stats')).toContainText('Active users');
  await page.goto(srv.url + '/index.html');
  await expect(page.locator('#sub')).toContainText('no clinical access');
  await expect(page.locator('#new')).toBeHidden();                           // no create_document capability
  const p2 = await page.context().newPage();
  await p2.evaluate(() => 0).catch(() => {});
  await p2.goto(srv.url + '/favicon.svg');
  await p2.evaluate((s) => localStorage.setItem('dsp-auth', JSON.stringify(s)), mock.as('d1').session('d1'));
  await p2.goto(srv.url + '/admin.html');
  await expect(p2.locator('body')).toContainText('You do not have permission to manage users.');
});
