#!/usr/bin/env node
// Refresh the vendored browser libraries from node_modules (run after `npm install`).
// Pinned: typo-js 1.2.4 + dictionary-en 3.2.0 are the exact versions the original tool used.
import { cpSync, mkdirSync } from 'node:fs';
const copy = (a, b) => { cpSync(a, b); console.log(`${a} -> ${b}`); };
mkdirSync('app/vendor/typo', { recursive: true }); mkdirSync('app/vendor/dictionary-en', { recursive: true });
copy('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'app/vendor/supabase.js');
copy('node_modules/typo-js/typo.js', 'app/vendor/typo/typo.js');
copy('node_modules/dictionary-en/index.aff', 'app/vendor/dictionary-en/index.aff');
copy('node_modules/dictionary-en/index.dic', 'app/vendor/dictionary-en/index.dic');
copy('node_modules/dictionary-en/license', 'app/vendor/dictionary-en/LICENSE');
