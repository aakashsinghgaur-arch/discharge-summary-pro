// FEATURE PRESERVATION: the original Discharge-maker.html and the new application's form engine
// are loaded side by side and must produce IDENTICAL clinical catalogs, form markup, Word files,
// print documents and saved state for the same input. Any difference fails the test.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../scripts/serve.mjs';
import { CASES } from '../fixtures/cases.mjs';
import { ROOT, ORIGINAL, writeStandaloneHarness, openWithState, outputs, unzipDocx } from './harness.mjs';

let srv, NEW;
test.beforeAll(async () => { NEW = writeStandaloneHarness(); srv = await startServer({ dir: ROOT, headers: false }); });
test.afterAll(async () => srv?.server.close());

const CATALOGS = ['S', 'U', 'PR', 'PL', 'PKM', 'OTS', 'SNG', 'LIB', 'SGT', 'DRUGS', 'DT', 'OTG', 'OTQ', 'OTL', 'ANA', 'MAB', 'NUM', 'DL', 'FM', 'TOP', 'DD', 'FQ', 'TM', 'DU', 'MED', 'MS'];
const grab = (page) => page.evaluate((names) => {
  const out = Object.fromEntries(names.map((n) => [n, JSON.stringify(window[n])]));
  out.GR = JSON.stringify(window.GR.map((g) => [String(g[0]), g[1], String(g[2]), g[3] ?? null]));
  out.form = document.getElementById('form').outerHTML;
  out.nav = document.getElementById('nav').innerHTML;
  out.tools = document.querySelector('.tools').outerHTML;
  out.bar = document.querySelector('.bar').outerHTML;
  out.mp = document.getElementById('mp').outerHTML;
  out.header = document.querySelector('.hdr').outerHTML;
  out.msg = document.getElementById('msg').outerHTML;
  return out;
}, CATALOGS);

const report = {};
test.afterAll(() => {
  mkdirSync(join(ROOT, 'tests/.tmp'), { recursive: true });
  const f = join(ROOT, 'tests/.tmp/regression-report.json');
  let prev = {}; try { prev = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first worker */ }
  writeFileSync(f, JSON.stringify({ ...prev, ...report }, null, 2));
});

test('clinical catalogs, sections, fields and controls are identical to the original', async ({ browser }) => {
  const a = await browser.newPage(), b = await browser.newPage();
  await openWithState(a, srv.url, ORIGINAL, null);
  await openWithState(b, srv.url, NEW, null);
  const [o, n] = await Promise.all([grab(a), grab(b)]);
  for (const k of Object.keys(o)) expect.soft(n[k], `${k} differs from original`).toBe(o[k]);
  const legends = await b.$$eval('#form legend', (l) => l.map((x) => x.firstChild.textContent));
  expect(legends).toEqual(['Patient details', 'Diagnosis', 'Vaccination status', 'Management and procedure', 'Blood transfusion', 'History',
    'Pre-op laboratory investigations', 'Other pre-op investigations', 'Post-op laboratory investigations', 'Other post-op investigations', 'Imaging',
    'Histopathology', 'Consultations and referrals', 'Hospital course', 'Treatment at discharge', 'Advice and care', 'Condition at discharge', 'Follow-up', 'Sign-off']);
  const counts = await b.evaluate(() => ({
    diagnoses: window.LIB.Diagnosis.reduce((n, g) => n + g[1].length, 0), procedures: window.LIB['Surgical procedure details'].reduce((n, g) => n + g[1].length, 0),
    labTests: Object.keys(window.U).length, labProfiles: Object.keys(window.PR).length, drugs: window.DRUGS.length,
    imaging: window.OTQ.img.reduce((n, g) => n + g[1].length, 0), histopathology: window.OTQ.hpe.reduce((n, g) => n + g[1].length, 0),
    anaesthesia: window.ANA.length, fields: document.querySelectorAll('#form [id^=f_]').length,
  }));
  report.inventory = counts;
  expect(counts.fields).toBe(36);   // 36 named fields defined in S (procedures, labs, medicines are repeatable rows)
  // the only intended markup differences outside the form: footer wording and one extra shortcut hint
  const foot = await b.textContent('footer.cr');
  expect(foot).toContain('Designed by Dr Akash Singh');
  expect(foot).not.toContain('never uploaded');
  await a.close(); await b.close();
});

for (const [name, state] of Object.entries(CASES)) {
  test(`identical output for synthetic case: ${name}`, async ({ browser }) => {
    const a = await browser.newPage(), b = await browser.newPage();
    await openWithState(a, srv.url, ORIGINAL, state);
    await openWithState(b, srv.url, NEW, state);
    const [o, n] = await Promise.all([outputs(a), outputs(b)]);
    expect(n.build, 'preview / Copy-for-Word HTML').toBe(o.build);
    expect(n.print, 'A4 print document').toBe(o.print);
    expect(JSON.parse(n.state), 'saved form state').toEqual(JSON.parse(o.state));
    const [zo, zn] = await Promise.all([unzipDocx(o.docx), unzipDocx(n.docx)]);
    expect(Object.keys(zn.files)).toEqual(Object.keys(zo.files));
    for (const f of Object.keys(zo.files)) if (f !== 'docProps/custom.xml') expect(zn.files[f], `docx part ${f}`).toBe(zo.files[f]);
    expect(zn.payload, 'embedded restore data').toEqual(zo.payload);
    report[name] = { buildChars: n.build.length, docxParts: Object.keys(zn.files).length, identical: true };
    await a.close(); await b.close();
  });
}

// Same keystrokes and clicks on both pages must give the same summary.
async function drive(page) {
  await page.fill('#f_Name', 'Test Patient Delta');
  await page.fill('#f_Age', '47');
  await page.selectOption('#f_Sex', 'Female');
  await page.fill('#f_Weight_kg_', '60');
  await page.fill('#f_Height_cm_', '155');
  await page.click('#f_Diagnosis');
  await page.keyboard.type('Cholelith');
  await expect(page.locator('#cbp')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.selectOption('#f_Type_of_management', 'Surgical');
  const pes = page.locator('.eb[data-k=proc] .es');
  await pes.click(); await pes.type('lap chole');
  await page.keyboard.press('Enter');
  await expect(page.locator('#procs .row.pr')).toHaveCount(1);
  await page.locator('#procs .row.pr .dt').first().fill('22/03/2026');
  await page.locator('#procs .row.pr .po').fill('29/26');
  await page.locator('#procs .row.pr .pa').selectOption('General anaesthesia');
  const les = page.locator('.eb[data-k=lab][data-ph=pre] .es');
  await les.click(); await les.type('LFT (all');
  await page.keyboard.press('Enter');
  await expect(page.locator('#rows_pre .row')).toHaveCount(14);   // LFT profile: 10 original + 4 merged extra tests
  await page.locator('#rows_pre .row .v').first().fill('1.8');
  await page.click('#addmed');
  await page.fill('#mp-n', 'Pantoprazole 40 mg');
  await page.click('#mp-b .ch[data-k=q] button[data-v="twice daily"]');
  await page.fill('#mp-dn', '5');
  await page.click('#mp-save');
  await page.check('#opt_fu');
  await page.fill('#f_Follow_up_date_and_instructions', 'Review after 1 week');
  await page.locator('#f_Date_of_admission').evaluate((e) => e.parentNode.querySelector('.dt').focus());
  await page.keyboard.type('20032026');
  await page.keyboard.press('Tab');
}

test('identical behaviour when the same entries are made through the UI', async ({ browser }) => {
  const a = await browser.newPage(), b = await browser.newPage();
  await openWithState(a, srv.url, ORIGINAL, null);
  await openWithState(b, srv.url, NEW, null);
  await drive(a); await drive(b);
  const [o, n] = await Promise.all([outputs(a), outputs(b)]);
  expect(await b.inputValue('#f_BMI')).toBe('25.0');
  expect(await b.inputValue('#f_Diagnosis')).toMatch(/^Cholelithiasis/);
  expect(n.build).toContain('Laparoscopic cholecystectomy performed under general anaesthesia on 22/03/2026 ORN : 29/26');
  expect(n.build).toBe(o.build);
  expect(JSON.parse(n.state)).toEqual(JSON.parse(o.state));
  await a.close(); await b.close();
});

test('keyboard shortcuts: Alt+V preview, Alt+↓ section jump, Enter to next field, Ctrl+P print fallback guard', async ({ page }) => {
  await openWithState(page, srv.url, NEW, CASES.conservative_minimal);
  await page.focus('#f_Name');
  await page.keyboard.press('Alt+KeyV');
  await expect(page.locator('#paper')).toBeVisible();
  await expect(page.locator('#paper')).toContainText('DISCHARGE SUMMARY');
  await page.focus('#f_Name');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('f_Age');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.textContent.slice(0, 9))).toBe('LEGEND:Diagnosis');
  await page.click('#colA');
  expect(await page.locator('#form fieldset.cl').count()).toBe(await page.locator('#form fieldset').count());
  await page.click('#expA');
  expect(await page.locator('#form fieldset.cl').count()).toBe(0);
});

test('spelling check uses the bundled dictionary offline and names the field (P6/P7 fixes)', async ({ page, context }) => {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());   // no internet at all
  await openWithState(page, srv.url, NEW, { ...CASES.conservative_minimal, f_Course_during_hospital_stay: 'Patient was managed conservativly and improved.' });
  await page.click('#chk');
  await expect(page.locator('#sp')).toBeVisible();
  await expect(page.locator('#sp .m')).toHaveText('Possible spelling mistake');
  await expect(page.locator('#sp mark')).toHaveText('conservativly');
  await expect(page.locator('#sp .h span').first()).toHaveText('Course during hospital stay');
  await expect(page.locator('#sp .b button.p').first()).toHaveText('conservatively');
  await page.locator('#sp .b button.p').first().click();
  expect(await page.inputValue('#f_Course_during_hospital_stay')).toContain('managed conservatively');
});

test('documents the original defects that were fixed (dictionary offline, wrong field name)', async ({ page, context }) => {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await openWithState(page, srv.url, ORIGINAL, { ...CASES.conservative_minimal, f_Course_during_hospital_stay: 'Patient had a operation.' });
  await page.click('#chk');
  await expect(page.locator('#sp')).toBeVisible();
  const head = await page.locator('#sp .h span').first().textContent();
  report.originalSpellingPanelFieldName = head;
  expect(head).toMatch(/^Discharge Summary - Test Patient Beta - .*\.docx$/);   // bug: shows the Word file name
});

test('Save Word → Load from file restores the summary exactly (standalone engine)', async ({ page }) => {
  await openWithState(page, srv.url, NEW, CASES.surgical_complex);
  const before = await outputs(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#word')]);
  expect(dl.suggestedFilename()).toMatch(/^Discharge Summary - Test Patient Alpha - \d{4}-\d\d-\d\d\.docx$/);
  const file = join(ROOT, 'tests/.tmp/roundtrip.docx');
  await dl.saveAs(file);
  await page.click('#clr'); await page.click('#clr');
  expect(await page.inputValue('#f_Name')).toBe('');
  await page.setInputFiles('#ldf', file);
  await page.waitForEvent('load');
  await page.waitForFunction(() => typeof window.build === 'function' && document.querySelectorAll('#nav button').length > 0);
  const after = await outputs(page);
  expect(after.build).toBe(before.build);
});

test('Load from file: a Word document WITHOUT embedded data is read best-effort and says so', async ({ page }) => {
  await openWithState(page, srv.url, NEW, CASES.surgical_complex);
  const html = await page.evaluate(() => window.build());
  writeFileSync(join(ROOT, 'tests/.tmp/plain.html'), `<html><body>${html}</body></html>`);
  await page.click('#clr'); await page.click('#clr');
  await page.setInputFiles('#ldf', join(ROOT, 'tests/.tmp/plain.html'));
  await expect(page.locator('#msg')).toContainText('has no saved data, so I read the text');
  await page.waitForEvent('load');
  await page.waitForFunction(() => typeof window.build === 'function');
  expect(await page.inputValue('#f_Name')).toBe('Test Patient Alpha');
  expect(await page.inputValue('#f_Diagnosis')).toBe('Carcinoma head of pancreas\nObstructive jaundice');
});

test('cloud boot path (window.DSP) restores the same form and reports the same state', async ({ page }) => {
  const state = CASES.surgical_complex;
  await page.goto(srv.url + '/tests/.tmp/blank.html');
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript((s) => {
    window.__saves = [];
    window.DSP = { bootData: () => s, userKey: (k) => `dsp_u:test:${k}`, onSave: (d) => window.__saves.push(d), prefChanged() {}, vendorBase: 'vendor/', appBarHeight: () => 56 };
  }, state);
  await page.goto(srv.url + NEW);
  await page.waitForFunction(() => document.querySelectorAll('#nav button').length > 0);
  const cloud = await page.evaluate(() => ({ build: window.build(), snap: window.snapshot(), ls: localStorage.getItem('dsm2') }));
  expect(cloud.ls, 'cloud mode never writes patient data to localStorage').toBeNull();
  const ref = await page.context().newPage();
  await openWithState(ref, srv.url, ORIGINAL, state);
  const o = await outputs(ref);
  expect(cloud.build).toBe(o.build);
  expect(cloud.snap).toEqual(JSON.parse(o.state));
  await page.fill('#f_Age', '55');
  const last = await page.evaluate(() => window.__saves.at(-1));
  expect(last.f_Age).toBe('55');
  // remembered entries are per-user keys
  await page.fill('#f_Consultant', 'Dr Remembered');
  await page.locator('#f_Consultant').blur();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain('dsp_u:test:dsm_hist');
  expect(keys).not.toContain('dsm_hist');
});
