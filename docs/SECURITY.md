# Security and privacy

> **Prerequisite:** do not enter identifiable patient information until the hospital has approved the
> deployment (data-protection, hosting location, retention and access policy — see §8).
> Use synthetic data for testing and training.

## 1. Where patient information exists

| Location | Content | Protection |
|---|---|---|
| `discharge_summaries.form_data` + index columns | Full summary | RLS + API checks; TLS; Supabase encryption at rest |
| `document_revisions.snapshot` | Historical copies | Same access as the document |
| Browser memory while editing | Current form | Signed-in session only |
| Recovery cache (unsent edits only) | Latest unsaved state | `sessionStorage` by default (cleared when the tab closes); `local` only with approval; `off` keeps it in memory |
| Remembered entries (per doctor) | Free-text lines the doctor typed | Per-user keys, removed from the browser at sign-out; private server copy (`user_settings`, RLS own-row) |
| Exported Word / print / JSON files | The summary | Controlled by the user; Word files may embed the full form state (see §5) |

Never present: URLs (only the document UUID), page titles, activity metadata, application logs, analytics
(none are used), notifications.

## 2. Controls implemented

* **Authentication:** Supabase Auth, email + password (min 10, letters and digits), invitation-only,
  public sign-up disabled, password reset without account enumeration, idle sign-out on shared PCs.
* **Default deny:** RLS on every table; `anon` has no privileges; `authenticated` has `SELECT` only on
  clinical tables, further limited by RLS; all writes through checked SECURITY DEFINER functions with
  `search_path=''` and qualified names; internal helpers not executable by clients.
* **Server-side authorisation:** document access, edit, review and finalisation are decided in SQL, never by
  hiding buttons. Role/ownership fields sent by clients are never trusted (the caller is always `auth.uid()`;
  `last_edited_by`, `created_by`, approvers are set by the server).
* **ID probing:** unauthorised and non-existent documents return the same `not_found`.
* **Deactivation:** `is_active=false` removes all data access immediately (checked in RLS), drops leases;
  the Edge Function also bans the Auth user so sessions cannot be refreshed.
* **Admins** manage accounts but have no automatic access to records.
* **Audit trail:** creation, edits sessions, take-overs, sharing changes, submissions, approvals, returns,
  finalisation, amendments, deletion, file loads, restores, openings and exports. No clinical values logged.
* **Integrity:** optimistic versioning + leases; pre-change checkpoints; finalised records immutable;
  corrections only via traceable amendments.
* **Rate limits:** per-user limits on creation (60/h), sharing (120/h), saves (400/10 min), events; Supabase
  Auth has its own sign-in limits.
* **Transport and browser:** HTTPS + HSTS; strict Content-Security-Policy (`script-src 'self'` plus the hash of
  the original print paginator), `frame-ancestors 'none'`, `X-Frame-Options DENY`, `nosniff`,
  `Referrer-Policy no-referrer`, `noindex`. All libraries are vendored (no CDN at runtime).
* **Secrets:** only the publishable/anon key reaches the browser. The build **fails** if a secret or
  service-role key is configured. The service-role key exists only as an Edge Function secret.
* **Sizes:** form data capped at 2 MB per save, settings at 512 kB.

## 3. Why SECURITY DEFINER functions

The clinical tables deny all direct writes. Each write needs to combine several checks atomically (lease,
version, status, permission) and to set server-owned columns (actor, timestamps, extracted index columns,
revisions, audit). Definer functions are the minimal way to do that inside PostgreSQL. Every one of them:
has `set search_path = ''`, re-validates the caller, and is explicitly granted to `authenticated` only.

## 4. Recovery cache

Unsaved edits are copied locally so that a dropped connection or closed tab never loses work. It is never the
authoritative record. Default `session` mode keeps it only in the tab. `local` mode keeps it in the browser
profile until saved or discarded — enable only if the institution approves storage of identifiable data on
ward computers (use full-disk encryption and individual OS accounts). Set with `DSP_RECOVERY_CACHE`.

## 5. Restore data embedded in Word files (original behaviour)

The original tool stores the complete form state inside each `.docx` (hidden custom properties) so that
"Load from file" can restore it exactly. That data can include text of sections not printed. It is kept on by
default for compatibility; each doctor can switch it off (⋯ menu → *Embed restore data in Word files*).
Files exported without it can still be imported best-effort. Whether it should default to off is listed for
clinical/governance decision in ANALYSIS.md §8.

## 6. Verified by tests

`tests/db/rls-and-api.test.mjs` (real PostgreSQL, separate authenticated test users, direct SQL/RPC —
no frontend involved) proves that users cannot: read another doctor's draft, guess IDs, edit view-only
documents, write tables directly, escalate their role, change capabilities, share without permission,
forge the editor, overwrite finalised documents, bypass leases or versions, read others' settings, or call
internal helpers; and that admins have no record access, deactivation is immediate and revisions are kept.
Browser tests verify CSP compliance, read-only enforcement in the UI and that no patient data is written to
un-namespaced browser storage.

## 7. Residual risks / out of scope

* Exported files and printouts leave the system; handle them under hospital policy.
* Browser extensions and compromised devices can read what a signed-in doctor can read.
* Supabase project-level settings (MFA, password breach protection, SMTP, backups, region) must be configured
  in the dashboard as described in DEPLOYMENT.md.
* No penetration test has been performed; recommended before go-live.

## 8. Institutional checklist before real patient data

- [ ] Hospital approval for cloud hosting of patient records (data-protection impact assessment; India DPDP Act 2023 and hospital policy)
- [ ] Supabase project region chosen per policy (e.g. `ap-south-1` Mumbai) and a paid plan with backups/PITR
- [ ] Data-processing terms with Supabase and Vercel reviewed
- [ ] Access policy agreed: who may be invited, which roles review/finalise (admin console)
- [ ] Retention period for summaries, revisions and audit logs agreed
- [ ] Clinical sign-off of validation rules and checklist (ANALYSIS.md §8)
- [ ] Custom SMTP sender configured for invitations/resets
- [ ] MFA considered for consultants and admins
- [ ] Incident-response contact and breach procedure defined
