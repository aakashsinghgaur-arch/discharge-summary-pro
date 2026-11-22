// Visual snapshots for manual design review (not assertions). Run: npx playwright test screens
import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer } from '../../scripts/serve.mjs';
import { MockSupabase, SUPABASE_URL } from './mock-supabase.mjs';
import { CASES } from '../fixtures/cases.mjs';
import { ROOT } from './harness.mjs';

let srv;
test.beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { env: { ...process.env, DSP_OUT_DIR: 'tests/.tmp/dist', SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only', DSP_APP_ENV: 'test', DSP_IDLE_SIGNOUT_MINUTES: '0' } });
  srv = await startServer({ dir: join(ROOT, 'tests/.tmp/dist') });
});
test.afterAll(() => srv?.server.close());
const shot = (page, name) => page.screenshot({ path: join(ROOT, 'tests/.tmp/shots', `${name}.png`), fullPage: false });

for (const [label, vp, scheme] of [['desktop', { width: 1366, height: 860 }, 'light'], ['mobile', { width: 390, height: 844 }, 'light'], ['dark', { width: 1366, height: 860 }, 'dark']]) {
  test(`screens ${label}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1, isMobile: label === 'mobile', hasTouch: label === 'mobile' });
    const page = await ctx.newPage();
    const mock = new MockSupabase();
    await mock.install(ctx);
    await page.goto(srv.url + '/login.html'); await shot(page, `${label}-login`);
    const a = mock.addDoc({ form_data: CASES.surgical_complex, access: { [mock.users.d2.id]: 'edit' } });
    mock.addDoc({ form_data: CASES.conservative_minimal, status: 'in_review', reviewer_id: mock.users.c1.id });
    const c = mock.addDoc({ form_data: CASES.legacy_keys, created_by: mock.users.d2.id, access: { [mock.users.d1.id]: 'view' } });
    c.lease = { editor_id: mock.users.d2.id, token: 't', expires: Date.now() + 1e6 };
    await page.goto(srv.url + '/favicon.svg');
    await page.evaluate((s) => localStorage.setItem('dsp-auth', JSON.stringify(s)), mock.session('d1'));
    await page.goto(srv.url + '/index.html'); await page.waitForSelector('[data-open]', { state: 'attached' }); await page.click('.tab[data-s=all]'); await page.waitForTimeout(400); await shot(page, `${label}-dashboard`);
    await page.goto(srv.url + `/editor.html#id=${a.id}`); await page.waitForFunction(() => !document.getElementById('ed-boot'));
    await page.fill('#f_Age', '55'); await page.waitForTimeout(3500); await shot(page, `${label}-editor`);
    await page.evaluate(() => window.scrollTo(0, 1500)); await page.waitForTimeout(300); await shot(page, `${label}-editor-scrolled`);
    await page.click('#ab-share'); await page.locator('#sh-q').fill('Dr'); await page.waitForTimeout(600); await shot(page, `${label}-share`);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.click('#ab-more'); await page.waitForTimeout(200); await shot(page, `${label}-menu`);
    await page.keyboard.press('Escape');
    await Promise.all([page.waitForEvent("load"), page.goto(srv.url + `/editor.html#id=${c.id}`)]); await page.waitForFunction(() => !document.getElementById('ed-boot')); await page.waitForTimeout(300); await shot(page, `${label}-viewonly`);
    await ctx.close();
  });
}
