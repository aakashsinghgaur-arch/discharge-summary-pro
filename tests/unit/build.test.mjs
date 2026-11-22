// The build must never ship a secret key and must keep the CSP hash in step with the print script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paginatorScript, sha256 } from '../../scripts/csp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const build = (env) => spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, env: { PATH: process.env.PATH, DSP_OUT_DIR: 'tests/.tmp/build-check', ...env }, encoding: 'utf8' });

test('refuses a service-role JWT', () => {
  const r = build({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.x` });
  assert.equal(r.status, 1); assert.match(r.stderr, /service_role/);
});
test('refuses an sb_secret_ key', () => {
  const r = build({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' });
  assert.equal(r.status, 1); assert.match(r.stderr, /SECRET/);
});
test('production build requires configuration', () => {
  const r = build({ VERCEL_ENV: 'production' });
  assert.equal(r.status, 1);
});
test('accepts a publishable key and writes only public config', () => {
  const r = build({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xyz', VERCEL_ENV: 'production' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readFileSync(join(root, 'tests/.tmp/build-check/config.js'), 'utf8');
  assert.match(cfg, /sb_publishable_xyz/); assert.doesNotMatch(cfg, /secret|service/i);
});
test('vercel.json CSP allows exactly the current print script', () => {
  const hash = sha256(paginatorScript(readFileSync(join(root, 'app/js/form-engine.js'), 'utf8')));
  assert.ok(readFileSync(join(root, 'vercel.json'), 'utf8').includes(hash));
});
