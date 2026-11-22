# Testing

```bash
npm install
npm run test:unit                     # autosave state machine, validation rules, build/key guards
npm run test:db                       # real PostgreSQL: migrations, RLS, API, workflow (needs a local server, see below)
CHROME_PATH=/path/to/chrome npm run test:e2e   # browser: original-vs-new regression + full application flows
npm run screens                       # optional: screenshots for design review → tests/.tmp/shots/
```

* **DB tests** run the real migrations on PostgreSQL 15/16 with a small Supabase stand-in
  (`tests/db/supabase-stub.sql`: roles `anon/authenticated/service_role`, `auth.users`, `auth.uid()`,
  Supabase-style default grants). Connection via `PGHOST/PGPORT/PGUSER/PGPASSWORD`, database `DSP_TEST_DB`
  (default `dsp_test`, recreated by `tests/db/reset-db.sh`).
* **Browser tests** use Playwright with Chromium; set `CHROME_PATH` to use an installed Chrome/Chromium.
  The application tests build the production bundle and serve it with the production security headers; the
  Supabase API is replaced by an in-memory mock (`tests/e2e/mock-supabase.mjs`) that follows the same contract.
* All test data is synthetic ("Test Patient Alpha" …).

## Results (this delivery)

| Suite | Tests | Result |
|---|---|---|
| Unit (`tests/unit`) | 20 | ✅ 20 passed |
| Database security & workflow (`tests/db`) | 19 | ✅ 19 passed (PostgreSQL 16.15) |
| Regression original-vs-new (`tests/e2e/regression.spec.mjs`) | 11 | ✅ 11 passed |
| Application flows (`tests/e2e/app.spec.mjs`) | 19 | ✅ 19 passed (repeated twice, no flakes) |

### What the regression suite proves
For three synthetic cases (complex surgical, conservative/minimal with hidden optional text, legacy-format
data) and for an identical sequence of UI actions, the original file and the new engine produce **identical**:
clinical catalogs (sections, fields, suggestions, units, profiles, drugs, anaesthesia, grammar rules), form
markup, navigator, toolbar and action bar, preview/Copy-for-Word HTML, A4 print document, saved form state,
every part of the `.docx`, and the embedded restore data. It also checks keyboard shortcuts, Word round-trip,
best-effort import, the bundled offline dictionary, and reproduces the original spelling-panel defect.

### Database tests (direct SQL/RPC as separate authenticated users)
Inactive accounts; anon denial; server-side extraction; no direct writes (even own rows); ID guessing;
admin has no record access; lease + versioning; view-only; edit share + take-over + stale writer rejected +
creator retained + pre-handover checkpoint; resharing limits and revocation; role escalation and admin
guard rails; full review → approve → finalise → protection → amendment; return for correction, server
validation, self-approval capability, recall, delete; deactivation; listing scopes/search/escaping; private
settings; revision retention; helper functions not callable; event whitelist; rate limit.

### Application flows
Dashboard listing/search/tabs/open; debounced versioned autosave with lease token and focus preserved;
Ctrl+S checkpoint; offline with local recovery and reconnection; conflict lock; read-only when another doctor
edits + take-over; take-over mid-session; view-only (no lease, no edit controls, preview/export + audit);
recovery after reload + restore; validation dialog + go-to-field; submit for review; approve + finalise with
checklist + amendment; load from file as a recoverable version; sharing; private remembered entries; print
paginator under CSP; login errors and redirect; admin console access; "Clear all" checkpoint; expired session
re-login in place. Every test also fails on any page error or CSP violation.

## Not verified automatically (needs the real environment)

* Real Supabase Auth e-mails (invite, reset), SMTP delivery and redirect URLs.
* The Edge Function against a live project (syntax-checked with the TypeScript compiler; deploy and test on staging).
* Clipboard "Copy for Word" paste into Microsoft Word, printing on physical A4 printers, opening the `.docx`
  in Word/LibreOffice (the files are byte-identical to the original tool's, which is already in clinical use).
* Safari/iOS and Firefox (tests use Chromium); layout was reviewed on desktop, phone and dark-mode screenshots.

## Manual regression checklist (run on staging before each release)

1. Sign in; wrong password message; forgot-password e-mail arrives and `reset.html` sets a new password.
2. New summary → fill every section incl. 2 procedures, lab profile + repeated value, custom test, medicine with custom frequency, all optional sections.
3. Watch the save pill: *Unsaved changes → Saving… → Saved*. Turn Wi-Fi off, type, see *Offline*, turn on, see *Saved*.
4. Preview, Copy for Word → paste into Word; Print → A4 with page numbers; Save Word → open in Word.
5. Load the saved .docx into a new summary → identical; load a Word file typed by hand → best-effort note.
6. Spelling (Alt+S) with Wi-Fi off → dictionary suggestions appear; field names are correct.
7. Share with a colleague (edit). Colleague opens → sees "Dr X is editing" → Take over. Original doctor sees "Editing taken over".
8. Colleague submits for review to a consultant → consultant returns with a note → author sees the note → resubmits → consultant approves → finalises with checklist.
9. Finalised summary cannot be edited; Create amendment → new draft linked to the original.
10. History shows versions and activity; restore an older version.
11. Dashboard tabs/counts/search by name, MRD, IRN, diagnosis; delete a draft.
12. Admin: invite, deactivate (user is signed out of data immediately), change role, permissions table.
13. Phone: all sections reachable, medicine pop-up usable, action bar reachable, dark mode readable.
