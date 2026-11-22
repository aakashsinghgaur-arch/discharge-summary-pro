// Shared helpers for browser tests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A page with the production editor markup and the form engine, but WITHOUT the cloud shell
// (no window.DSP), so the engine runs in its original single-file mode. Generated from
// app/editor.html so that markup drift between production and the test harness is impossible.
export function writeStandaloneHarness() {
  const ed = readFileSync(join(ROOT, 'app/editor.html'), 'utf8');
  let h = ed
    .replace(/<header class="ab"[\s\S]*?<\/header>\n/, '')
    .replace(/<div id="ed-banners"[^>]*><\/div>\n/, '')
    .replace(/<div id="ed-boot"[\s\S]*?<\/div>\n/, '')
    .replace('<main id="dsp-main" hidden>', '<main id="dsp-main">')
    .replace(/<link rel="stylesheet" href="css\/(shell|editor)\.css">\n/g, '')
    .replace(/<script src="config\.js"><\/script>[\s\S]*<\/body>/, '<script src="js/form-engine.js"></script>\n</body>')
    .replace('<head>', '<head>\n<base href="/app/">');
  if (!h.includes('js/form-engine.js') || h.includes('editor-shell')) throw new Error('harness generation failed');
  const dir = join(ROOT, 'tests/.tmp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'engine-standalone.html'), h);
  writeFileSync(join(dir, 'blank.html'), '<!doctype html><title>blank</title>');
  return '/tests/.tmp/engine-standalone.html';
}

export const ORIGINAL = '/original/Discharge-maker.html';

export async function openWithState(page, base, path, state) {
  await page.goto(base + '/tests/.tmp/blank.html');
  await page.evaluate((s) => { localStorage.clear(); if (s) localStorage.setItem('dsm2', JSON.stringify(s)); }, state || null);
  await page.goto(base + path);
  await page.waitForFunction(() => typeof window.build === 'function' && document.querySelectorAll('#form fieldset').length === 19 && document.querySelectorAll('#nav button').length > 0);
}

export async function outputs(page) {
  return page.evaluate(async () => {
    const b = window.build();
    const p = window.docHTML(false);
    const blob = window.buildDocx();
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    window.save();
    return { build: b, print: p, docx: btoa(s), state: localStorage.getItem('dsm2') };
  });
}

export async function unzipDocx(b64) {
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const files = {};
  for (const name of Object.keys(zip.files).sort()) files[name] = await zip.files[name].async('string');
  // decode the embedded restore payload so it can be compared as data
  const cx = files['docProps/custom.xml'] || '';
  const parts = []; const re = /name="dsm(\d+)"[^>]*><vt:lpwstr>([^<]*)</g; let m;
  while ((m = re.exec(cx))) parts[+m[1]] = m[2];
  const payload = parts.join('') ? JSON.parse(Buffer.from(parts.join(''), 'base64').toString('utf8')) : null;
  return { files, payload };
}
