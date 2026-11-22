# Deployment (Supabase + Vercel)

Use **two Supabase projects**: `staging` (Vercel Preview deployments, synthetic data only) and `production`.
Everything below is done once per project unless stated otherwise.

## 1. Prerequisites

* Node.js 20+ and the Supabase CLI (`npm i -g supabase` or see supabase.com/docs/guides/cli)
* A Git repository connected to Vercel
* Hospital approval for the hosting arrangement (SECURITY.md §8) before production data

## 2. Supabase project

1. Create the project (choose the region required by hospital policy, e.g. Mumbai `ap-south-1`).
2. Apply the database:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push            # applies supabase/migrations/*.sql in order
   ```
   (Alternative: paste the three migration files, in order, into the SQL editor.)
3. **Authentication settings** (dashboard → Authentication):
   * Email provider enabled; **"Allow new users to sign up" OFF** (invitation only).
   * Minimum password length 10, require letters and digits; enable leaked-password protection if available.
   * URL configuration — **Site URL**: `https://<your-production-domain>`; **Redirect URLs**:
     `https://<your-production-domain>/reset.html` and, for staging, `https://*-<vercel-team>.vercel.app/reset.html`.
   * JWT expiry 3600 s (default) is fine; sessions refresh automatically.
   * Configure custom SMTP (hospital sender) so invitation and reset e-mails are delivered reliably.
4. **Edge Function** (invitations and sign-in blocking):
   ```bash
   supabase secrets set ALLOWED_ORIGINS="https://<your-production-domain>"
   supabase functions deploy admin-users
   ```
   The service-role key is provided to the function by the platform; never put it anywhere else.
5. **Housekeeping job** (optional, recommended): enable the `pg_cron` extension and run in the SQL editor:
   ```sql
   select cron.schedule('dsp-cleanup', '15 3 * * *', 'select public.cleanup_expired()');
   ```
6. **Backups:** use a plan with daily backups; enable Point-in-Time Recovery for production. See §8.

## 3. Vercel project

1. Import the repository. Framework preset **Other**. Build settings come from `vercel.json`
   (build `node scripts/build.mjs`, output `dist`, no install step needed).
2. Environment variables (Settings → Environment Variables), set **separately for Production and Preview**:

   | Variable | Production | Preview |
   |---|---|---|
   | `SUPABASE_URL` | production project URL | staging project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | production publishable/anon key | staging key |
   | `DSP_RECOVERY_CACHE` | `session` (default) | `session` |
   | `DSP_IDLE_SIGNOUT_MINUTES` | `120` | `120` |
   | `DSP_EDIT_IDLE_RELEASE_MINUTES` | `20` | `20` |

   The build refuses secret/service-role keys and refuses a production build without configuration.
3. Deploy. Vercel adds HTTPS; `vercel.json` adds the security headers (CSP, HSTS, frame denial, no-index).
4. If Supabase is served from a **custom domain**, add it to `connect-src` in `vercel.json`.
5. Attach the hospital's domain (optional) and update the Supabase Site URL / redirect URLs and `ALLOWED_ORIGINS`.

## 4. First administrator

1. Supabase dashboard → Authentication → Users → **Invite user** (or Add user) with your e-mail.
2. SQL editor:
   ```sql
   update public.profiles
      set role = 'admin', is_active = true, full_name = 'Your Name', designation = 'Your designation'
    where email = 'you@hospital.example';
   ```
3. Sign in at `https://<domain>/login.html` → account menu → **User administration** → invite doctors and
   consultants. Review the role-permission table and confirm it matches the agreed access policy.
   An administrator account has no clinical access by default; use a separate doctor/consultant account for
   clinical work (or grant clinical capabilities to the admin role deliberately).

## 5. Local development

```bash
npm install                 # dev tools only (Playwright, pg, jszip); the app has no runtime dependencies
cp .env.example .env        # point at your staging project
set -a; . ./.env; set +a
npm run dev                 # builds to dist/ and serves http://127.0.0.1:5173
```
With the Supabase CLI you can also run everything locally: `supabase start` (uses `supabase/config.toml`),
`supabase db reset` (applies migrations + seed), then set `SUPABASE_URL=http://127.0.0.1:54321` and the local
anon key printed by `supabase start`.

## 6. Preview vs production

* Preview deployments (every branch/PR) use the **staging** Supabase project — never production data.
* Database changes: add a new file in `supabase/migrations/`, test with `npm run test:db`, apply to staging
  (`supabase db push` against staging), verify the Preview deployment, then apply to production and promote.

## 7. Rollback

* **Frontend:** Vercel → Deployments → select the previous good deployment → *Promote to Production*
  (instant, no rebuild).
* **Database:** migrations are forward-only. Before every production migration take an on-demand backup
  (or note the PITR timestamp). To revert, write a new corrective migration; for a severe problem restore the
  backup / PITR point into a new project and switch `SUPABASE_URL`. Frontend and database versions are
  compatible as long as RPC signatures are kept (add new functions instead of changing existing ones).

## 8. Backup and recovery

* Supabase daily backups + PITR (production). Test a restore into a scratch project at least quarterly.
* Additional encrypted off-site export (authorised DBA only):
  `supabase db dump --data-only -f dsp-$(date +%F).sql` — store encrypted, under hospital retention rules.
* Individual summaries: every document keeps revisions (History → Download / Restore). Doctors can download
  form data (.json) and Word files; these restore via *Load from file*.

## 9. Go-live checklist

- [ ] Migrations applied; `npm run test:db` green against a copy
- [ ] Sign-up disabled, redirect URLs set, SMTP configured
- [ ] Edge Function deployed with `ALLOWED_ORIGINS`
- [ ] Vercel env vars for Production and Preview point to the right projects
- [ ] First admin created; roles reviewed; doctors invited
- [ ] Synthetic end-to-end run: create → share → hand over → review → finalise → export
- [ ] Backups/PITR enabled; restore tested
- [ ] Institutional approvals complete (SECURITY.md §8)
