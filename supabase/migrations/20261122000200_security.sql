-- =============================================================================
-- Discharge Summary Pro — access helpers and Row Level Security
-- Model: default deny. Clients may only SELECT what RLS allows; every write to
-- clinical tables goes through SECURITY DEFINER functions (next migration) that
-- re-check identity, activity status, document access, status and leases.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers (used by policies, so they must be executable by `authenticated`)
-- ---------------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and is_active
  );
$$;

create or replace function public.has_capability(cap text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.role_capabilities rc on rc.role = p.role
    where p.id = (select auth.uid()) and p.is_active and rc.capability = cap
  );
$$;

-- Returns 'owner' | 'edit' | 'review' | 'view' | null for the current user.
-- Deleted documents and inactive users always get null.
create or replace function public.doc_access(p_doc uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when d.created_by = (select auth.uid()) then 'owner'
           else (select dp.permission::text
                 from public.document_permissions dp
                 where dp.document_id = d.id
                   and dp.user_id = (select auth.uid())
                   and dp.revoked_at is null)
         end
  from public.discharge_summaries d
  where d.id = p_doc
    and d.deleted_at is null
    and public.is_active_user();
$$;

-- ---------------------------------------------------------------------------
-- Table privileges: strip everything, then grant the minimum.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles, public.role_capabilities, public.discharge_summaries,
                public.document_permissions, public.document_revisions,
                public.document_activity, public.editing_leases
  to authenticated;
grant select, insert, update on public.user_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.role_capabilities    enable row level security;
alter table public.discharge_summaries  enable row level security;
alter table public.document_permissions enable row level security;
alter table public.document_revisions   enable row level security;
alter table public.document_activity    enable row level security;
alter table public.editing_leases       enable row level security;
alter table public.user_settings        enable row level security;
alter table public.rate_limits          enable row level security;   -- no policies: definer-only

-- Profiles: you can always read your own; active users can read the staff directory
-- (needed to choose whom to share with). No client-side writes (use update_my_profile).
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_active_user());

create policy role_capabilities_select on public.role_capabilities
  for select to authenticated
  using (public.is_active_user());

create policy summaries_select on public.discharge_summaries
  for select to authenticated
  using (public.doc_access(id) is not null);

create policy permissions_select on public.document_permissions
  for select to authenticated
  using (public.doc_access(document_id) is not null);

create policy revisions_select on public.document_revisions
  for select to authenticated
  using (public.doc_access(document_id) is not null);

create policy activity_select on public.document_activity
  for select to authenticated
  using (
    (document_id is not null and public.doc_access(document_id) is not null)
    or (document_id is null and public.has_capability('manage_users'))
  );

create policy leases_select on public.editing_leases
  for select to authenticated
  using (public.doc_access(document_id) is not null);

create policy user_settings_own on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user())
  with check (user_id = (select auth.uid()) and public.is_active_user());
