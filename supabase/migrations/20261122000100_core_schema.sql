-- =============================================================================
-- Discharge Summary Pro — core schema
-- Multi-doctor discharge summaries for Surgical Gastroenterology, LT & HPB, GMCH.
-- Patient data lives ONLY in public.discharge_summaries (form_data + extracted
-- index columns) and public.document_revisions (snapshots). Every other table
-- holds identifiers, timestamps and non-clinical metadata.
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- New functions must not be executable by everyone by default.
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'doctor', 'consultant');
create type public.doc_status as enum ('draft', 'in_review', 'approved', 'finalized');
create type public.doc_permission as enum ('view', 'edit', 'review');

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user). No passwords here: Supabase Auth owns credentials.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '' check (char_length(full_name) <= 120),
  email       text check (char_length(email) <= 320),
  designation text not null default '' check (char_length(designation) <= 120),
  role        public.app_role not null default 'doctor',
  is_active   boolean not null default false,          -- default-deny: an admin activates
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'Application profile per Supabase Auth user. is_active=false blocks all data access through RLS.';

-- ---------------------------------------------------------------------------
-- Configurable role -> capability mapping (kept out of the frontend)
-- ---------------------------------------------------------------------------
create table public.role_capabilities (
  role       public.app_role not null,
  capability text not null check (capability in (
               'create_document',   -- start new summaries, duplicate, amend
               'share_document',    -- share drafts (owners can always share their own)
               'review_document',   -- be assigned as reviewer, approve, return for correction
               'self_approve',      -- approve own/edited draft without a separate reviewer
               'finalize_document', -- finalize an approved summary
               'manage_users',      -- invite, activate/deactivate, change roles, edit this table
               'view_operations')), -- non-clinical operational statistics
  primary key (role, capability)
);

insert into public.role_capabilities (role, capability) values
  ('doctor',     'create_document'), ('doctor', 'share_document'),
  ('consultant', 'create_document'), ('consultant', 'share_document'),
  ('consultant', 'review_document'), ('consultant', 'self_approve'),
  ('consultant', 'finalize_document'),
  ('admin',      'manage_users'),    ('admin', 'view_operations');
-- Note: admins get NO clinical capability and NO automatic document access.

-- ---------------------------------------------------------------------------
-- Discharge summaries
-- ---------------------------------------------------------------------------
create table public.discharge_summaries (
  id               uuid primary key default gen_random_uuid(),
  -- Index columns: extracted server-side from form_data on every save (never trusted from the client).
  patient_name     text not null default '',
  hospital_number  text not null default '',
  mrd_number       text not null default '',
  irn              text not null default '',
  diagnosis        text not null default '',
  created_by       uuid not null references public.profiles (id) on delete restrict,
  status           public.doc_status not null default 'draft',
  form_data        jsonb not null default '{}'::jsonb,   -- complete original form state ("dsm2" format)
  schema_version   integer not null default 1,           -- database row layout version
  format_version   text not null default 'dsm2',         -- form-state format (same as the original tool)
  version          integer not null default 1,           -- optimistic-concurrency counter
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_edited_by   uuid references public.profiles (id) on delete restrict,
  reviewer_id      uuid references public.profiles (id) on delete restrict,
  submitted_at     timestamptz,
  submitted_by     uuid references public.profiles (id) on delete restrict,
  approved_at      timestamptz,
  approved_by      uuid references public.profiles (id) on delete restrict,
  finalized_at     timestamptz,
  finalized_by     uuid references public.profiles (id) on delete restrict,
  review_note      text check (char_length(review_note) <= 2000),
  review_checklist jsonb,
  amends_id        uuid references public.discharge_summaries (id) on delete restrict,
  amendment_no     integer not null default 0,
  superseded_by    uuid references public.discharge_summaries (id) on delete set null,
  deleted_at       timestamptz,
  deleted_by       uuid references public.profiles (id) on delete restrict,
  search_text      text generated always as (
                     lower(patient_name || ' ' || hospital_number || ' ' || mrd_number || ' ' || irn || ' ' || diagnosis)
                   ) stored,
  constraint form_data_is_object check (jsonb_typeof(form_data) = 'object'),
  constraint finalized_has_actor check (status <> 'finalized' or (finalized_at is not null and finalized_by is not null))
);
comment on column public.discharge_summaries.form_data is 'Exact form state produced by the original engine (keys f_*, opt_*, __labs, __meds, __ot, __procs).';

create index discharge_summaries_created_by_idx on public.discharge_summaries (created_by, updated_at desc) where deleted_at is null;
create index discharge_summaries_status_idx     on public.discharge_summaries (status, updated_at desc) where deleted_at is null;
create index discharge_summaries_reviewer_idx   on public.discharge_summaries (reviewer_id) where deleted_at is null and status = 'in_review';
create index discharge_summaries_search_idx     on public.discharge_summaries using gin (search_text extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Document-level permissions (explicit sharing). The creator is the implicit owner.
-- ---------------------------------------------------------------------------
create table public.document_permissions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.discharge_summaries (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete restrict,
  permission  public.doc_permission not null,
  granted_by  uuid not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles (id) on delete restrict
);
create unique index document_permissions_active_uq on public.document_permissions (document_id, user_id) where revoked_at is null;
create index document_permissions_user_idx on public.document_permissions (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Revisions: periodic snapshots (not every keystroke) — see save_document().
-- ---------------------------------------------------------------------------
create table public.document_revisions (
  id              bigint generated always as identity primary key,
  document_id     uuid not null references public.discharge_summaries (id) on delete cascade,
  revision_number integer not null,
  doc_version     integer not null,
  edited_by       uuid not null references public.profiles (id) on delete restrict,
  reason          text not null default 'autosave'
                  check (reason in ('created','autosave','checkpoint','handover','status_change','file_load','restore','manual','amendment','duplicate')),
  snapshot        jsonb not null,
  created_at      timestamptz not null default now(),
  unique (document_id, revision_number)
);
create index document_revisions_doc_idx on public.document_revisions (document_id, revision_number desc);

-- ---------------------------------------------------------------------------
-- Activity / audit log. Never stores clinical field values.
-- document_id is null for account-administration events.
-- ---------------------------------------------------------------------------
create table public.document_activity (
  id          bigint generated always as identity primary key,
  document_id uuid references public.discharge_summaries (id) on delete cascade,
  actor_id    uuid not null references public.profiles (id) on delete restrict,
  action      text not null check (char_length(action) <= 60),
  created_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb
);
create index document_activity_doc_idx on public.document_activity (document_id, created_at desc);
create index document_activity_admin_idx on public.document_activity (created_at desc) where document_id is null;

-- ---------------------------------------------------------------------------
-- Editing leases: single active editor per document, time-limited.
-- ---------------------------------------------------------------------------
create table public.editing_leases (
  document_id uuid primary key references public.discharge_summaries (id) on delete cascade,
  editor_id   uuid not null references public.profiles (id) on delete cascade,
  lease_token uuid not null default gen_random_uuid(),
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-user settings: remembered suggestions, personal dictionary, preferences.
-- Strictly private to the user (never shared between doctors).
-- ---------------------------------------------------------------------------
create table public.user_settings (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 512000),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Simple per-user rate limiting buckets (written only by SECURITY DEFINER functions).
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null default now(),
  count        integer not null default 0,
  primary key (user_id, bucket)
);

-- ---------------------------------------------------------------------------
-- New auth user -> inactive profile (an administrator must activate it).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, designation)
  values (
    new.id,
    new.email,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    left(coalesce(new.raw_user_meta_data ->> 'designation', ''), 120)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep updated_at honest on profile edits
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
