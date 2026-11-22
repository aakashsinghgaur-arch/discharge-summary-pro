# Stage 2 — Architecture

## 1. Overview

```
 Browser (static files from Vercel)                         Supabase
 ┌──────────────────────────────────────────────┐          ┌───────────────────────────────────┐
 │ login.html / reset.html  ── Supabase Auth ───┼─────────▶│ Auth (email + password, invites)  │
 │ index.html (dashboard)   ── RPC (PostgREST) ─┼─────────▶│ PostgreSQL                        │
 │ admin.html               ── Edge Function ───┼─────────▶│   RLS (default deny, SELECT only) │
 │ editor.html                                  │          │   SECURITY DEFINER API functions  │
 │   editor-shell.js  (cloud integration)       │          │ Edge Function admin-users         │
 │     ⇅ window.DSP adapter                     │          │   (service-role key, invite/ban)  │
 │   form-engine.js   (ORIGINAL clinical form)  │          └───────────────────────────────────┘
 └──────────────────────────────────────────────┘
```

* No frontend framework and no bundler. The original DOM-generating engine is loaded unchanged except for
  eight marked patches. All new code is plain ES modules.
* No custom backend server. Every operation is a Supabase RPC (SQL function) or a direct `SELECT`
  restricted by RLS; only privileged account operations use one Edge Function.
* No Supabase Storage bucket: Word/print files are generated in the browser, as in the original, and nothing
  is uploaded. (Storage would only be justified for scanned attachments, which the form does not have.)
* No Realtime subscriptions: single-editor leases make them unnecessary; the dashboard refreshes on focus.

## 2. Frontend modules

| Module | Responsibility |
|---|---|
| `core/env.js` | Reads the public `window.DSP_CONFIG` (generated `config.js`) |
| `core/supabase.js` | Single Supabase client (implicit flow so invite/reset links work on any device) |
| `core/api.js` | `rpc()` wrapper, `DSP:<code>` → human message, network/auth detection, keepalive requests, Edge Function calls |
| `core/auth.js` | Session guard (`requireUser`), inactive-account handling, idle sign-out, account menu, profile/password dialogs |
| `core/ui.js` | Escaping templates, dialogs (`<dialog>`), menus, toasts, formatting, status badges |
| `core/share.js` | Share dialog and reviewer picker |
| `core/autosave.js` | DOM-free autosave state machine (debounce, versions, back-off, stop conditions) |
| `core/recovery.js` | Local recovery cache (`off` / `session` / `local`) |
| `core/validation.js` | Configurable pre-submission / approval / finalisation checks (read-only) |
| `editor-shell.js` | Loads document, leases, boots engine, autosave, banners, workflow, history, files, lifecycle |
| `form-engine.js` | The original clinical form (generation, suggestions, output, Word, print, spelling) |

Engine ↔ shell contract (`window.DSP`): `bootData()`, `onSave(state)`, `applyLoaded(data, note)`,
`userKey(k)`, `prefChanged(k)`, `embedRestoreData()`, `vendorBase`, `appBarHeight()`.
Without `window.DSP` the engine behaves exactly like the original single file (used by the regression tests).

## 3. Database schema (`supabase/migrations/`)

| Table | Purpose | Key points |
|---|---|---|
| `profiles` | One row per Auth user | `role` (admin/doctor/consultant), `is_active` (default **false**), name, designation, email; created by trigger on `auth.users` |
| `role_capabilities` | Role → capability mapping | Capabilities: create_document, share_document, review_document, self_approve, finalize_document, manage_users, view_operations. Editable by admins; never hard-coded in the UI |
| `discharge_summaries` | The documents | `form_data` JSONB = complete original form state (`format_version` 'dsm2'); index columns (patient_name, mrd_number, irn, hospital_number, diagnosis) **extracted on the server**; `version` for optimistic concurrency; status, reviewer, approval/finalisation actors and times; amendments (`amends_id`, `superseded_by`); soft delete; trigram search index |
| `document_permissions` | Explicit sharing | view / edit / review; unique active grant per user; revocations kept (`revoked_at/by`) |
| `document_revisions` | History snapshots | reasons: created, autosave, checkpoint, handover, status_change, file_load, restore, manual, amendment, duplicate; retention keeps the newest 100 autosaves, all others kept |
| `document_activity` | Audit log | actions + ids only, never clinical values; `document_id` null for account events |
| `editing_leases` | Single active editor | one row per document, token, 180-second expiry, renewed every 60 s |
| `user_settings` | Private per-user data | remembered entries, personal dictionary, preferences |
| `rate_limits` | Abuse protection | per-user buckets used by the API |

Deletion policies: profiles referenced by documents cannot be deleted (`on delete restrict`) — deactivate
instead; documents are soft-deleted (drafts only); finalised documents can never be deleted from the app.

## 4. Authentication flow

1. Admin invites a doctor (Edge Function → `inviteUserByEmail`, profile set active with role).
2. The invite e-mail links to `reset.html`; the doctor sets a password (min 10, letters + digits) and signs in.
3. Every page calls `requireUser()` → `my_context()`; inactive accounts are signed out with an explanation.
4. Sessions persist in the browser and refresh automatically; if a refresh fails while editing, an in-place
   sign-in dialog appears and unsaved work is held until the save succeeds.
5. Idle sign-out (default 120 min) protects shared ward computers; it waits if there are unsaved changes.
6. Public sign-up is disabled in Supabase Auth; password reset uses the standard e-mail flow without
   revealing whether an account exists.

## 5. Authorisation model

* `doc_access(id)` returns `owner | edit | review | view | null` for the caller (null for deleted documents
  and inactive users). It is the single source of truth for RLS and every API function.
* RLS: clients may only `SELECT`. No INSERT/UPDATE/DELETE privileges on clinical tables exist for
  `authenticated`; `anon` has nothing.
* Writes go through SECURITY DEFINER functions with `search_path=''`, which check: active user → capability →
  document access → status → lease → version. Errors use `DSP:<code>`; "no access" and "does not exist" are
  the same `not_found`, so IDs cannot be probed.
* Admin role grants account management only; no automatic document access.
* Owner can share view/edit; editors can share if their role has `share_document`; reviewer access is granted
  only through "submit for review".

## 6. Autosave strategy

* The engine calls `DSP.onSave(state)` on every input (as it called `localStorage` before).
* `Autosaver` compares with the last saved JSON, persists to the recovery cache (debounced), and sends one
  `save_document` 2.5 s after typing stops — never moving focus or re-rendering the form.
* Each save carries `expected_version` and the lease token; the server increments `version`.
* States: *Unsaved changes → Saving… → Saved hh:mm*; *Offline · kept in this browser tab* (exponential
  back-off up to 60 s, immediate retry on `online`); *Save failed · Retry*; *Session expired · Sign in*;
  *Conflict detected*; *Read-only*.
* Page hidden → flush; closing with unsaved changes → browser warning + recovery copy; page hide → lease released.
* Ctrl+S / "Save now" sends an explicit `manual` checkpoint (snapshot in History).

## 7. Sharing workflow

Share dialog → search active clinical users (`search_doctors`) → choose View only / Can edit →
`share_document` (server checks owner/editor + capability, recipient active and clinical) → recipient sees it
under *Shared with me* → opens the same document (no copy). Access can be changed or removed (`revoke_share`);
removal also drops the person's editing lease. "Make a copy" is a separate, explicit action.

## 8. Editing-conflict strategy (single active editor)

* Opening a draft with edit rights calls `acquire_lease`: granted if free/expired; otherwise read-only view
  with the editor's name and a **Take over editing** action (confirmed, audited).
* A second tab of the same user does not silently steal; the same tab reloading reclaims its own lease.
* Leases renew every 60 s, expire after 180 s without renewal, are released on page hide and after 20 min
  idle (configurable) so forgotten tabs never lock a document.
* `save_document` rejects a stale lease (`lease_lost`) and a stale version (`conflict`). The stale editor is
  stopped, told who took over, and keeps unsaved work in the recovery cache (download / restore later).
* Before a handover or any explicit replace (file load, restore, "Clear all", manual checkpoint) the server
  snapshots the current state if it is not yet in History — another doctor's work is never lost silently.

## 9. Revision and approval lifecycle

```
            submit_for_review (to a consultant)              finalize_document (+ checklist)
  DRAFT ───────────────────────────────▶ IN REVIEW ── approve ──▶ APPROVED ─────────────────▶ FINALIZED
    ▲  ▲          recall (owner)  │            │                     │                            │
    │  └──────────────────────────┘            │ return (note)       │ return (note)              │ create_amendment
    └──────────────────────────────────────────┴─────────────────────┘                            ▼
    DRAFT ── approve (self_approve capability) ──▶ APPROVED                         new DRAFT (amends_id → original;
                                                                                    original keeps its content, marked superseded)
```

Every transition re-checks permissions and version on the server, records actor and time, snapshots the
document, and logs an activity event. Finalised documents are immutable in the application.
