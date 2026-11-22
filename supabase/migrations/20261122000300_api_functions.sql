-- =============================================================================
-- Discharge Summary Pro — server-side API (Supabase RPC)
-- Every function: SECURITY DEFINER, empty search_path, fully qualified names,
-- re-checks the caller (auth.uid(), is_active) and the document access level.
-- Errors are raised as 'DSP:<code>' with an optional JSON detail; the frontend
-- maps codes to clear messages. "not_found" is also used for "no access" so that
-- document IDs cannot be probed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers (NOT executable by clients)
-- ---------------------------------------------------------------------------
create or replace function public._lease_seconds() returns integer
language sql immutable set search_path = '' as $$ select 180 $$;

create or replace function public._require_active() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception using errcode = 'P0001', message = 'DSP:auth';
  end if;
  if not exists (select 1 from public.profiles where id = v and is_active) then
    raise exception using errcode = 'P0001', message = 'DSP:inactive';
  end if;
  return v;
end $$;

create or replace function public._name(p uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(full_name, ''), email, 'Unknown user') from public.profiles where id = p
$$;

create or replace function public._rate_limit(p_bucket text, p_max integer, p_window interval) returns void
language plpgsql security definer set search_path = '' as $$
declare c integer;
begin
  insert into public.rate_limits as r (user_id, bucket, window_start, count)
  values (auth.uid(), p_bucket, now(), 1)
  on conflict (user_id, bucket) do update set
    count        = case when r.window_start < now() - p_window then 1 else r.count + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning count into c;
  if c > p_max then
    raise exception using errcode = 'P0001', message = 'DSP:rate_limited';
  end if;
end $$;

create or replace function public._log(p_doc uuid, p_action text, p_meta jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.document_activity (document_id, actor_id, action, metadata)
  values (p_doc, auth.uid(), p_action, coalesce(p_meta, '{}'::jsonb));
$$;

-- Normalise a free-text value for an index column.
create or replace function public._clean(p text, p_len integer) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_len)
$$;

-- Extracted index columns from the original form keys.
create or replace function public._meta(p jsonb)
returns table (patient_name text, hospital_number text, mrd_number text, irn text, diagnosis text)
language sql immutable set search_path = '' as $$
  select public._clean(p ->> 'f_Name', 200),
         public._clean(p ->> 'f_Hospital_No', 80),
         public._clean(p ->> 'f_MRD_No', 80),
         public._clean(p ->> 'f_IRN', 80),
         left(coalesce((
           select string_agg(public._clean(l, 300), '; ' order by n)
           from regexp_split_to_table(replace(coalesce(p ->> 'f_Diagnosis', ''), chr(13), ''), chr(10))
                with ordinality as t(l, n)
           where btrim(l) <> ''), ''), 600)
$$;

create or replace function public._check_payload(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"form_data must be an object"}';
  end if;
  if pg_column_size(p) > 2000000 then
    raise exception using errcode = 'P0001', message = 'DSP:too_large';
  end if;
end $$;

create or replace function public._add_revision(p_doc uuid, p_snapshot jsonb, p_version integer, p_reason text, p_editor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select coalesce(max(revision_number), 0) + 1 into n from public.document_revisions where document_id = p_doc;
  insert into public.document_revisions (document_id, revision_number, doc_version, edited_by, reason, snapshot)
  values (p_doc, n, p_version, coalesce(p_editor, auth.uid()), p_reason, p_snapshot);
  -- Retention: keep the newest 100 autosave snapshots; all other reasons are kept.
  delete from public.document_revisions r
  where r.document_id = p_doc and r.reason = 'autosave'
    and r.id not in (select id from public.document_revisions
                     where document_id = p_doc and reason = 'autosave'
                     order by revision_number desc limit 100);
end $$;

-- Minimal server-side checks before approval/finalisation (clinical checks run in the UI and are configurable).
create or replace function public._server_checks(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare a date; d date;
begin
  if coalesce(btrim(p ->> 'f_Name'), '') = '' then
    raise exception using errcode = 'P0001', message = 'DSP:validation', detail = '{"rule":"patient_name"}';
  end if;
  begin
    a := nullif(p ->> 'f_Date_of_admission', '')::date;
    d := nullif(p ->> 'f_Date_of_discharge', '')::date;
  exception when others then
    raise exception using errcode = 'P0001', message = 'DSP:validation', detail = '{"rule":"date_format"}';
  end;
  if a is not null and d is not null and d < a then
    raise exception using errcode = 'P0001', message = 'DSP:validation', detail = '{"rule":"discharge_before_admission"}';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Session context
-- ---------------------------------------------------------------------------
create or replace function public.my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles; caps text[];
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then
    raise exception using errcode = 'P0001', message = 'DSP:auth';
  end if;
  select coalesce(array_agg(capability order by capability), '{}') into caps
  from public.role_capabilities where role = p.role and p.is_active;
  return jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'email', p.email, 'designation', p.designation,
    'role', p.role, 'is_active', p.is_active, 'capabilities', to_jsonb(caps));
end $$;

create or replace function public.update_my_profile(p_full_name text, p_designation text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active();
begin
  if char_length(btrim(coalesce(p_full_name, ''))) < 2 then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"name"}';
  end if;
  update public.profiles
     set full_name = left(btrim(p_full_name), 120), designation = left(btrim(coalesce(p_designation, '')), 120)
   where id = me;
end $$;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create or replace function public.create_document(p_form_data jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); v_id uuid; m record;
begin
  if not public.has_capability('create_document') then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  perform public._rate_limit('create', 60, interval '1 hour');
  perform public._check_payload(p_form_data);
  select * into m from public._meta(p_form_data);
  insert into public.discharge_summaries
    (created_by, last_edited_by, form_data, patient_name, hospital_number, mrd_number, irn, diagnosis)
  values (me, me, p_form_data, m.patient_name, m.hospital_number, m.mrd_number, m.irn, m.diagnosis)
  returning id into v_id;
  perform public._add_revision(v_id, p_form_data, 1, 'created');
  perform public._log(v_id, 'created');
  return v_id;
end $$;

-- Everything the editor needs in one round trip.
create or replace function public.get_editor_state(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; l public.editing_leases;
begin
  acc := public.doc_access(p_id);
  if acc is null then
    raise exception using errcode = 'P0001', message = 'DSP:not_found';
  end if;
  select * into d from public.discharge_summaries where id = p_id;
  select * into l from public.editing_leases where document_id = p_id and expires_at > now();
  return jsonb_build_object(
    'id', d.id, 'status', d.status, 'version', d.version, 'form_data', d.form_data,
    'format_version', d.format_version, 'schema_version', d.schema_version,
    'created_at', d.created_at, 'updated_at', d.updated_at,
    'created_by', d.created_by, 'created_by_name', public._name(d.created_by),
    'last_edited_by', d.last_edited_by, 'last_edited_by_name', public._name(d.last_edited_by),
    'reviewer_id', d.reviewer_id, 'reviewer_name', public._name(d.reviewer_id),
    'submitted_at', d.submitted_at, 'approved_at', d.approved_at, 'approved_by_name', public._name(d.approved_by),
    'finalized_at', d.finalized_at, 'finalized_by_name', public._name(d.finalized_by),
    'review_note', d.review_note, 'amends_id', d.amends_id, 'amendment_no', d.amendment_no,
    'superseded_by', d.superseded_by,
    'my_access', acc,
    'lease', case when l.document_id is null then null else jsonb_build_object(
               'editor_id', l.editor_id, 'editor_name', public._name(l.editor_id),
               'expires_at', l.expires_at, 'mine', l.editor_id = me) end);
end $$;

-- Atomic lease acquisition. Returns {acquired, lease_token?, expires_at, editor_id, editor_name, held_by_me}.
create or replace function public.acquire_lease(p_id uuid, p_takeover boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; st public.doc_status; l public.editing_leases;
        v_exp timestamptz := now() + make_interval(secs => public._lease_seconds()); v_tok uuid := gen_random_uuid();
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if acc not in ('owner', 'edit') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  select status into st from public.discharge_summaries where id = p_id for update;   -- serialises lease changes
  if st <> 'draft' then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;

  select * into l from public.editing_leases where document_id = p_id for update;
  if not found then
    insert into public.editing_leases (document_id, editor_id, lease_token, expires_at)
    values (p_id, me, v_tok, v_exp);
    perform public._log(p_id, 'editing_started');
  elsif l.expires_at <= now() then
    update public.editing_leases set editor_id = me, lease_token = v_tok, acquired_at = now(), expires_at = v_exp, updated_at = now()
     where document_id = p_id;
    perform public._log(p_id, 'editing_started', jsonb_build_object('expired_lease_of', l.editor_id));
  elsif p_takeover then
    update public.editing_leases set editor_id = me, lease_token = v_tok, acquired_at = now(), expires_at = v_exp, updated_at = now()
     where document_id = p_id;
    perform public._log(p_id, 'editing_taken_over', jsonb_build_object('previous_editor', l.editor_id, 'same_user', l.editor_id = me));
  else
    return jsonb_build_object('acquired', false, 'editor_id', l.editor_id, 'editor_name', public._name(l.editor_id),
                              'expires_at', l.expires_at, 'held_by_me', l.editor_id = me);
  end if;
  return jsonb_build_object('acquired', true, 'lease_token', v_tok, 'expires_at', v_exp,
                            'editor_id', me, 'editor_name', public._name(me), 'held_by_me', true);
end $$;

create or replace function public.renew_lease(p_id uuid, p_token uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); v_exp timestamptz := now() + make_interval(secs => public._lease_seconds());
        l public.editing_leases;
begin
  if coalesce(public.doc_access(p_id), '') not in ('owner', 'edit') then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  update public.editing_leases set expires_at = v_exp, updated_at = now()
   where document_id = p_id and editor_id = me and lease_token = p_token and expires_at > now();
  if not found then
    select * into l from public.editing_leases where document_id = p_id and expires_at > now();
    raise exception using errcode = 'P0001', message = 'DSP:lease_lost',
      detail = jsonb_build_object('editor_name', public._name(l.editor_id), 'held_by_me', l.editor_id = me)::text;
  end if;
  return v_exp;
end $$;

create or replace function public.release_lease(p_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active();
begin
  delete from public.editing_leases where document_id = p_id and editor_id = me and lease_token = p_token;
  if found then perform public._log(p_id, 'editing_ended'); return true; end if;
  return false;
end $$;

-- Optimistic, lease-checked save. Returns {version, updated_at, lease_expires_at, revision_created}.
create or replace function public.save_document(
  p_id uuid, p_expected_version integer, p_lease_token uuid, p_form_data jsonb, p_reason text default 'autosave')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; l public.editing_leases;
        m record; v_new integer; v_rev boolean := false;
        v_exp timestamptz := now() + make_interval(secs => public._lease_seconds());
begin
  if p_reason not in ('autosave', 'file_load', 'restore', 'manual') then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"reason"}';
  end if;
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if acc not in ('owner', 'edit') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  perform public._check_payload(p_form_data);
  perform public._rate_limit('save', 400, interval '10 minutes');

  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'DSP:not_editable', detail = jsonb_build_object('status', d.status)::text;
  end if;
  select * into l from public.editing_leases
   where document_id = p_id and editor_id = me and lease_token = p_lease_token and expires_at > now();
  if not found then
    select * into l from public.editing_leases where document_id = p_id and expires_at > now();
    raise exception using errcode = 'P0001', message = 'DSP:lease_lost',
      detail = jsonb_build_object('editor_name', public._name(l.editor_id), 'held_by_me', l.editor_id = me)::text;
  end if;
  if d.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'DSP:conflict',
      detail = jsonb_build_object('server_version', d.version, 'last_edited_by_name', public._name(d.last_edited_by),
                                  'updated_at', d.updated_at)::text;
  end if;

  -- Never lose a colleague's work: before a handover or an explicit replace (file load, restore,
  -- manual checkpoint), make sure the CURRENT server state is captured in history.
  if (p_reason <> 'autosave' or d.last_edited_by is distinct from me)
     and not exists (select 1 from public.document_revisions where document_id = p_id and doc_version = d.version) then
    perform public._add_revision(p_id, d.form_data, d.version, 'checkpoint', d.last_edited_by);
  end if;

  select * into m from public._meta(p_form_data);
  update public.discharge_summaries
     set form_data = p_form_data, version = version + 1, last_edited_by = me, updated_at = now(),
         patient_name = m.patient_name, hospital_number = m.hospital_number, mrd_number = m.mrd_number,
         irn = m.irn, diagnosis = m.diagnosis
   where id = p_id
  returning version into v_new;
  update public.editing_leases set expires_at = v_exp, updated_at = now() where document_id = p_id;

  -- Snapshot policy: on handover (first save by a different editor), on explicit reasons,
  -- otherwise at most one autosave snapshot per editor every 10 minutes.
  if p_reason <> 'autosave' then
    perform public._add_revision(p_id, p_form_data, v_new, p_reason); v_rev := true;
    perform public._log(p_id, case p_reason when 'file_load' then 'loaded_from_file'
                                            when 'restore' then 'revision_restored' else 'saved' end);
  elsif d.last_edited_by is distinct from me then
    perform public._add_revision(p_id, p_form_data, v_new, 'handover'); v_rev := true;
  elsif not exists (select 1 from public.document_revisions
                    where document_id = p_id and edited_by = me and created_at > now() - interval '10 minutes') then
    perform public._add_revision(p_id, p_form_data, v_new, 'autosave'); v_rev := true;
  end if;

  return jsonb_build_object('version', v_new, 'updated_at', now(), 'lease_expires_at', v_exp, 'revision_created', v_rev);
end $$;

create or replace function public.delete_document(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); d public.discharge_summaries;
begin
  if public.doc_access(p_id) is distinct from 'owner' then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'DSP:not_editable', detail = jsonb_build_object('status', d.status)::text;
  end if;
  update public.discharge_summaries set deleted_at = now(), deleted_by = me where id = p_id;
  delete from public.editing_leases where document_id = p_id;
  if d.amends_id is not null then
    update public.discharge_summaries set superseded_by = null where id = d.amends_id and superseded_by = p_id;
  end if;
  perform public._log(p_id, 'deleted');
end $$;

create or replace function public.duplicate_document(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); d public.discharge_summaries; v_id uuid;
begin
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if not public.has_capability('create_document') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  perform public._rate_limit('create', 60, interval '1 hour');
  select * into d from public.discharge_summaries where id = p_id;
  insert into public.discharge_summaries
    (created_by, last_edited_by, form_data, patient_name, hospital_number, mrd_number, irn, diagnosis)
  values (me, me, d.form_data, d.patient_name, d.hospital_number, d.mrd_number, d.irn, d.diagnosis)
  returning id into v_id;
  perform public._add_revision(v_id, d.form_data, 1, 'duplicate');
  perform public._log(v_id, 'created', jsonb_build_object('copied_from', p_id));
  perform public._log(p_id, 'copied', jsonb_build_object('copy_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Review / approval / finalisation workflow
--   draft --submit--> in_review --approve--> approved --finalize--> finalized
--   in_review --return/recall--> draft ; approved --return--> draft
--   draft --approve (self_approve capability)--> approved
--   finalized --create_amendment--> new draft (amends_id), original untouched
-- ---------------------------------------------------------------------------
create or replace function public.submit_for_review(p_id uuid, p_reviewer uuid, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; rp public.profiles;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if acc not in ('owner', 'edit') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'draft' then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;
  if d.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'DSP:conflict', detail = jsonb_build_object('server_version', d.version)::text;
  end if;
  if p_reviewer is null or p_reviewer = me then
    raise exception using errcode = 'P0001', message = 'DSP:reviewer_required';
  end if;
  select * into rp from public.profiles where id = p_reviewer and is_active;
  if not found or not exists (select 1 from public.role_capabilities where role = rp.role and capability = 'review_document') then
    raise exception using errcode = 'P0001', message = 'DSP:reviewer_required';
  end if;

  if p_reviewer <> d.created_by and not exists (
       select 1 from public.document_permissions where document_id = p_id and user_id = p_reviewer and revoked_at is null) then
    insert into public.document_permissions (document_id, user_id, permission, granted_by)
    values (p_id, p_reviewer, 'review', me);
  end if;
  update public.discharge_summaries
     set status = 'in_review', reviewer_id = p_reviewer, submitted_at = now(), submitted_by = me, review_note = null,
         updated_at = now()
   where id = p_id;
  delete from public.editing_leases where document_id = p_id;
  perform public._add_revision(p_id, d.form_data, d.version, 'status_change');
  perform public._log(p_id, 'submitted_for_review', jsonb_build_object('reviewer', p_reviewer));
  return jsonb_build_object('status', 'in_review');
end $$;

create or replace function public.recall_from_review(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'in_review' then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;
  if not (acc = 'owner' or d.submitted_by = me) then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  update public.discharge_summaries set status = 'draft', updated_at = now() where id = p_id;
  perform public._log(p_id, 'recalled_from_review');
  return jsonb_build_object('status', 'draft');
end $$;

create or replace function public.return_for_correction(p_id uuid, p_comment text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); d public.discharge_summaries;
begin
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status not in ('in_review', 'approved') then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;
  if d.reviewer_id is distinct from me or not public.has_capability('review_document') then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  update public.discharge_summaries
     set status = 'draft', review_note = left(nullif(btrim(coalesce(p_comment, '')), ''), 2000),
         approved_at = null, approved_by = null, updated_at = now()
   where id = p_id;
  perform public._add_revision(p_id, d.form_data, d.version, 'status_change');
  perform public._log(p_id, 'returned_for_correction', jsonb_build_object('from', d.status, 'has_comment', coalesce(btrim(p_comment), '') <> ''));
  return jsonb_build_object('status', 'draft');
end $$;

create or replace function public.approve_document(p_id uuid, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'DSP:conflict', detail = jsonb_build_object('server_version', d.version)::text;
  end if;
  if d.status = 'in_review' then
    if d.reviewer_id is distinct from me or not public.has_capability('review_document') then
      raise exception using errcode = 'P0001', message = 'DSP:forbidden';
    end if;
  elsif d.status = 'draft' then
    if acc not in ('owner', 'edit') or not public.has_capability('self_approve') then
      raise exception using errcode = 'P0001', message = 'DSP:forbidden';
    end if;
  else
    raise exception using errcode = 'P0001', message = 'DSP:not_editable';
  end if;
  perform public._server_checks(d.form_data);
  update public.discharge_summaries
     set status = 'approved', approved_at = now(), approved_by = me, reviewer_id = coalesce(reviewer_id, me), updated_at = now()
   where id = p_id;
  delete from public.editing_leases where document_id = p_id;
  perform public._add_revision(p_id, d.form_data, d.version, 'status_change');
  perform public._log(p_id, 'approved', jsonb_build_object('from', d.status));
  return jsonb_build_object('status', 'approved');
end $$;

create or replace function public.finalize_document(p_id uuid, p_expected_version integer, p_checklist jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if not public.has_capability('finalize_document') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'approved' then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;
  if d.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'DSP:conflict', detail = jsonb_build_object('server_version', d.version)::text;
  end if;
  if not (d.approved_by = me or d.reviewer_id = me or acc in ('owner', 'edit')) then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  if p_checklist is not null and (jsonb_typeof(p_checklist) <> 'object' or pg_column_size(p_checklist) > 4000) then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"checklist"}';
  end if;
  perform public._server_checks(d.form_data);
  update public.discharge_summaries
     set status = 'finalized', finalized_at = now(), finalized_by = me, review_checklist = p_checklist, updated_at = now()
   where id = p_id;
  perform public._add_revision(p_id, d.form_data, d.version, 'status_change');
  perform public._log(p_id, 'finalized');
  return jsonb_build_object('status', 'finalized');
end $$;

create or replace function public.create_amendment(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; v_id uuid;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if acc = 'view' or not public.has_capability('create_document') then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  if d.status <> 'finalized' then raise exception using errcode = 'P0001', message = 'DSP:not_editable'; end if;
  if d.superseded_by is not null then
    raise exception using errcode = 'P0001', message = 'DSP:already_amended', detail = jsonb_build_object('amendment_id', d.superseded_by)::text;
  end if;
  insert into public.discharge_summaries
    (created_by, last_edited_by, form_data, patient_name, hospital_number, mrd_number, irn, diagnosis, amends_id, amendment_no)
  values (me, me, d.form_data, d.patient_name, d.hospital_number, d.mrd_number, d.irn, d.diagnosis, p_id, d.amendment_no + 1)
  returning id into v_id;
  -- carry the care team across: original owner + active collaborators keep their access level
  insert into public.document_permissions (document_id, user_id, permission, granted_by)
  select v_id, x.user_id, x.permission, me from (
    select d.created_by as user_id, 'edit'::public.doc_permission as permission where d.created_by <> me
    union
    select user_id, case when permission = 'review' then 'view'::public.doc_permission else permission end
      from public.document_permissions where document_id = p_id and revoked_at is null and user_id <> me and user_id <> d.created_by
  ) x;
  update public.discharge_summaries set superseded_by = v_id where id = p_id;
  perform public._add_revision(v_id, d.form_data, 1, 'amendment');
  perform public._log(v_id, 'created', jsonb_build_object('amends', p_id));
  perform public._log(p_id, 'amendment_started', jsonb_build_object('amendment_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------
create or replace function public.search_doctors(p_query text default '') returns table (
  id uuid, full_name text, designation text, role public.app_role, email text, can_review boolean)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := public._require_active(); q text := lower(btrim(coalesce(p_query, '')));
begin
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.full_name, p.designation, p.role, p.email,
           exists (select 1 from public.role_capabilities rc where rc.role = p.role and rc.capability = 'review_document')
    from public.profiles p
    where p.is_active and p.id <> me
      and exists (select 1 from public.role_capabilities rc where rc.role = p.role
                  and rc.capability in ('create_document', 'review_document'))   -- clinical users only
      and (q = '' or lower(p.full_name) like '%' || q || '%' or lower(coalesce(p.email, '')) like '%' || q || '%'
           or lower(p.designation) like '%' || q || '%')
    order by p.full_name
    limit 25;
end $$;

create or replace function public.share_document(p_id uuid, p_user uuid, p_permission public.doc_permission) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; cur public.document_permissions; tp public.profiles;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if not (acc = 'owner' or (acc = 'edit' and public.has_capability('share_document'))) then
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  if p_permission not in ('view', 'edit') then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"permission"}';
  end if;
  perform public._rate_limit('share', 120, interval '1 hour');
  select * into d from public.discharge_summaries where id = p_id for update;
  select * into tp from public.profiles where id = p_user and is_active;
  if not found or p_user = me or p_user = d.created_by
     or not exists (select 1 from public.role_capabilities rc where rc.role = tp.role
                    and rc.capability in ('create_document', 'review_document')) then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"recipient"}';
  end if;
  select * into cur from public.document_permissions where document_id = p_id and user_id = p_user and revoked_at is null for update;
  if found then
    if cur.permission = p_permission then return jsonb_build_object('changed', false); end if;
    if acc <> 'owner' and cur.granted_by <> me then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
    if cur.permission = 'review' and d.status = 'in_review' and d.reviewer_id = p_user then
      raise exception using errcode = 'P0001', message = 'DSP:reviewer_assigned';
    end if;
    update public.document_permissions set permission = p_permission, updated_at = now() where id = cur.id;
    if p_permission = 'view' then delete from public.editing_leases where document_id = p_id and editor_id = p_user; end if;
    perform public._log(p_id, 'permission_changed', jsonb_build_object('user', p_user, 'from', cur.permission, 'to', p_permission));
  else
    insert into public.document_permissions (document_id, user_id, permission, granted_by) values (p_id, p_user, p_permission, me);
    perform public._log(p_id, 'shared', jsonb_build_object('user', p_user, 'permission', p_permission));
  end if;
  return jsonb_build_object('changed', true);
end $$;

create or replace function public.revoke_share(p_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); acc text; d public.discharge_summaries; cur public.document_permissions;
begin
  acc := public.doc_access(p_id);
  if acc is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  select * into d from public.discharge_summaries where id = p_id for update;
  select * into cur from public.document_permissions where document_id = p_id and user_id = p_user and revoked_at is null for update;
  if not found then return; end if;
  if not (acc = 'owner' or cur.granted_by = me or p_user = me) then   -- anyone may remove their own access
    raise exception using errcode = 'P0001', message = 'DSP:forbidden';
  end if;
  if d.status in ('in_review', 'approved') and d.reviewer_id = p_user then
    raise exception using errcode = 'P0001', message = 'DSP:reviewer_assigned';
  end if;
  update public.document_permissions set revoked_at = now(), revoked_by = me, updated_at = now() where id = cur.id;
  delete from public.editing_leases where document_id = p_id and editor_id = p_user;
  perform public._log(p_id, 'access_revoked', jsonb_build_object('user', p_user, 'permission', cur.permission));
end $$;

create or replace function public.list_doc_access(p_id uuid) returns table (
  user_id uuid, full_name text, designation text, permission text, granted_by_name text, granted_at timestamptz, is_owner boolean)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := public._require_active();
begin
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  return query
    select d.created_by, public._name(d.created_by), p.designation, 'owner'::text, null::text, d.created_at, true
      from public.discharge_summaries d join public.profiles p on p.id = d.created_by where d.id = p_id
    union all
    select dp.user_id, public._name(dp.user_id), p.designation, dp.permission::text, public._name(dp.granted_by), dp.created_at, false
      from public.document_permissions dp join public.profiles p on p.id = dp.user_id
     where dp.document_id = p_id and dp.revoked_at is null
    order by 7 desc, 2;
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard listing (no clinical body is returned; only index columns)
-- ---------------------------------------------------------------------------
create or replace function public.list_documents(
  p_scope text default 'all', p_query text default '', p_status text default '',
  p_sort text default 'updated_desc', p_limit integer default 25, p_offset integer default 0)
returns table (
  id uuid, patient_name text, hospital_number text, mrd_number text, irn text, diagnosis text,
  status public.doc_status, created_at timestamptz, updated_at timestamptz,
  created_by uuid, created_by_name text, last_edited_by_name text, reviewer_name text,
  my_access text, shared_with jsonb, editing_by text, amends_id uuid, amendment_no integer, superseded_by uuid,
  total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := public._require_active(); q text := lower(btrim(coalesce(p_query, '')));
        lim integer := least(greatest(coalesce(p_limit, 25), 1), 100); off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_scope not in ('all', 'my_drafts', 'shared_with_me', 'shared_by_me', 'pending_review', 'completed') then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"scope"}';
  end if;
  if p_sort not in ('updated_desc', 'updated_asc', 'created_desc', 'patient_asc', 'status') then p_sort := 'updated_desc'; end if;
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
  with acc as (
    select d.*, case when d.created_by = me then 'owner' else dp.permission::text end as acc_level
    from public.discharge_summaries d
    left join public.document_permissions dp on dp.document_id = d.id and dp.user_id = me and dp.revoked_at is null
    where d.deleted_at is null and (d.created_by = me or dp.id is not null)
  ), f as (
    select a.* from acc a
    where (q = '' or a.search_text like '%' || q || '%')
      and (coalesce(p_status, '') = '' or a.status::text = p_status)
      and case p_scope
            when 'my_drafts'      then a.created_by = me and a.status <> 'finalized'
            when 'shared_with_me' then a.created_by <> me
            when 'shared_by_me'   then a.created_by = me and exists (select 1 from public.document_permissions x where x.document_id = a.id and x.revoked_at is null)
            when 'pending_review' then a.status = 'in_review' and a.reviewer_id = me
            when 'completed'      then a.status = 'finalized'
            else true end
  )
  select f.id, f.patient_name, f.hospital_number, f.mrd_number, f.irn, f.diagnosis, f.status, f.created_at, f.updated_at,
         f.created_by, public._name(f.created_by), public._name(f.last_edited_by), public._name(f.reviewer_id),
         f.acc_level,
         coalesce((select jsonb_agg(jsonb_build_object('name', public._name(x.user_id), 'permission', x.permission) order by x.created_at)
                   from public.document_permissions x where x.document_id = f.id and x.revoked_at is null), '[]'::jsonb),
         (select public._name(l.editor_id) from public.editing_leases l where l.document_id = f.id and l.expires_at > now()),
         f.amends_id, f.amendment_no, f.superseded_by,
         count(*) over ()
  from f
  order by
    case when p_sort = 'updated_desc' then f.updated_at end desc,
    case when p_sort = 'updated_asc'  then f.updated_at end asc,
    case when p_sort = 'created_desc' then f.created_at end desc,
    case when p_sort = 'patient_asc'  then lower(f.patient_name) end asc,
    case when p_sort = 'status'       then f.status end asc,
    f.updated_at desc
  limit lim offset off;
end $$;

create or replace function public.dashboard_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := public._require_active(); r jsonb;
begin
  with acc as (
    select d.* from public.discharge_summaries d
    left join public.document_permissions dp on dp.document_id = d.id and dp.user_id = me and dp.revoked_at is null
    where d.deleted_at is null and (d.created_by = me or dp.id is not null)
  )
  select jsonb_build_object(
    'my_drafts',      count(*) filter (where created_by = me and status <> 'finalized'),
    'shared_with_me', count(*) filter (where created_by <> me),
    'shared_by_me',   count(*) filter (where created_by = me and exists (select 1 from public.document_permissions x where x.document_id = acc.id and x.revoked_at is null)),
    'pending_review', count(*) filter (where status = 'in_review' and reviewer_id = me),
    'completed',      count(*) filter (where status = 'finalized'),
    'all',            count(*))
  into r from acc;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------
create or replace function public.list_revisions(p_id uuid) returns table (
  revision_number integer, doc_version integer, reason text, edited_by_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_active();
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  return query select r.revision_number, r.doc_version, r.reason, public._name(r.edited_by), r.created_at
    from public.document_revisions r where r.document_id = p_id order by r.revision_number desc limit 200;
end $$;

create or replace function public.get_revision(p_id uuid, p_revision integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s jsonb;
begin
  perform public._require_active();
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  select snapshot into s from public.document_revisions where document_id = p_id and revision_number = p_revision;
  if s is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  return s;
end $$;

create or replace function public.list_activity(p_id uuid, p_limit integer default 100) returns table (
  action text, actor_name text, created_at timestamptz, metadata jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_active();
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  return query
    select a.action, public._name(a.actor_id), a.created_at,
           -- resolve user ids in metadata to names for display
           a.metadata
             || case when a.metadata ? 'user' then jsonb_build_object('user_name', public._name((a.metadata ->> 'user')::uuid)) else '{}'::jsonb end
             || case when a.metadata ? 'reviewer' then jsonb_build_object('reviewer_name', public._name((a.metadata ->> 'reviewer')::uuid)) else '{}'::jsonb end
             || case when a.metadata ? 'previous_editor' then jsonb_build_object('previous_editor_name', public._name((a.metadata ->> 'previous_editor')::uuid)) else '{}'::jsonb end
    from public.document_activity a
    where a.document_id = p_id
    order by a.created_at desc, a.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- Client-reported events (exports, printing, opening) for the audit trail. Whitelisted.
create or replace function public.log_client_event(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_active();
  if p_action not in ('opened', 'printed', 'exported_docx', 'copied_for_word', 'exported_json') then
    raise exception using errcode = 'P0001', message = 'DSP:invalid', detail = '{"reason":"action"}';
  end if;
  if public.doc_access(p_id) is null then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  perform public._rate_limit('event', 600, interval '1 hour');
  perform public._log(p_id, p_action);
end $$;

-- ---------------------------------------------------------------------------
-- Administration (no clinical data is exposed here)
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users() returns table (
  id uuid, full_name text, email text, designation text, role public.app_role, is_active boolean,
  created_at timestamptz, last_sign_in_at timestamptz, invited_pending boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_active();
  if not public.has_capability('manage_users') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  return query
    select p.id, p.full_name, p.email, p.designation, p.role, p.is_active, p.created_at, u.last_sign_in_at,
           (u.last_sign_in_at is null)
    from public.profiles p join auth.users u on u.id = p.id
    order by p.is_active desc, p.full_name;
end $$;

create or replace function public.admin_update_user(
  p_user uuid, p_role public.app_role, p_is_active boolean, p_full_name text default null, p_designation text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active(); old public.profiles; admins integer;
begin
  if not public.has_capability('manage_users') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  select * into old from public.profiles where id = p_user for update;
  if not found then raise exception using errcode = 'P0001', message = 'DSP:not_found'; end if;
  if p_user = me and (p_is_active is false or p_role is distinct from old.role) then
    raise exception using errcode = 'P0001', message = 'DSP:self_action';
  end if;
  update public.profiles
     set role = coalesce(p_role, role), is_active = coalesce(p_is_active, is_active),
         full_name = coalesce(left(btrim(p_full_name), 120), full_name),
         designation = coalesce(left(btrim(p_designation), 120), designation)
   where id = p_user;
  select count(*) into admins from public.profiles p
   where p.is_active and exists (select 1 from public.role_capabilities rc where rc.role = p.role and rc.capability = 'manage_users');
  if admins < 1 then raise exception using errcode = 'P0001', message = 'DSP:last_admin'; end if;
  if coalesce(p_is_active, true) = false then
    delete from public.editing_leases where editor_id = p_user;
  end if;
  perform public._log(null, 'user_updated', jsonb_build_object('user', p_user,
    'role', jsonb_build_array(old.role, coalesce(p_role, old.role)),
    'active', jsonb_build_array(old.is_active, coalesce(p_is_active, old.is_active))));
end $$;

create or replace function public.admin_set_capability(p_role public.app_role, p_capability text, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._require_active();
begin
  if not public.has_capability('manage_users') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  if p_capability = 'manage_users' and p_role = 'admin' and not p_enabled then
    raise exception using errcode = 'P0001', message = 'DSP:last_admin';
  end if;
  if p_enabled then
    insert into public.role_capabilities (role, capability) values (p_role, p_capability) on conflict do nothing;
  else
    delete from public.role_capabilities where role = p_role and capability = p_capability;
  end if;
  perform public._log(null, 'capability_changed', jsonb_build_object('role', p_role, 'capability', p_capability, 'enabled', p_enabled));
end $$;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public._require_active();
  if not public.has_capability('view_operations') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  select jsonb_build_object(
    'users_active',   (select count(*) from public.profiles where is_active),
    'users_inactive', (select count(*) from public.profiles where not is_active),
    'documents_by_status', coalesce((select jsonb_object_agg(status, n) from
                         (select status, count(*) n from public.discharge_summaries where deleted_at is null group by status) s), '{}'::jsonb),
    'documents_updated_7d', (select count(*) from public.discharge_summaries where deleted_at is null and updated_at > now() - interval '7 days'),
    'active_editing_sessions', (select count(*) from public.editing_leases where expires_at > now()),
    'revisions_stored', (select count(*) from public.document_revisions))
  into r;
  return r;
end $$;

create or replace function public.admin_recent_events(p_limit integer default 50) returns table (
  action text, actor_name text, created_at timestamptz, metadata jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_active();
  if not public.has_capability('manage_users') then raise exception using errcode = 'P0001', message = 'DSP:forbidden'; end if;
  return query select a.action, public._name(a.actor_id), a.created_at,
      a.metadata || case when a.metadata ? 'user' then jsonb_build_object('user_name', public._name((a.metadata ->> 'user')::uuid)) else '{}'::jsonb end
    from public.document_activity a where a.document_id is null
    order by a.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- Housekeeping (schedule with pg_cron if available; see docs/DEPLOYMENT.md)
create or replace function public.cleanup_expired() returns void
language sql security definer set search_path = '' as $$
  delete from public.editing_leases where expires_at < now() - interval '1 day';
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges: nothing for anon; clients get only the public API.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.is_active_user(), public.has_capability(text), public.doc_access(uuid),
  public.my_context(), public.update_my_profile(text, text),
  public.create_document(jsonb), public.get_editor_state(uuid),
  public.acquire_lease(uuid, boolean), public.renew_lease(uuid, uuid), public.release_lease(uuid, uuid),
  public.save_document(uuid, integer, uuid, jsonb, text), public.delete_document(uuid), public.duplicate_document(uuid),
  public.submit_for_review(uuid, uuid, integer), public.recall_from_review(uuid), public.return_for_correction(uuid, text),
  public.approve_document(uuid, integer), public.finalize_document(uuid, integer, jsonb), public.create_amendment(uuid),
  public.search_doctors(text), public.share_document(uuid, uuid, public.doc_permission), public.revoke_share(uuid, uuid),
  public.list_doc_access(uuid), public.list_documents(text, text, text, text, integer, integer), public.dashboard_counts(),
  public.list_revisions(uuid), public.get_revision(uuid, integer), public.list_activity(uuid, integer),
  public.log_client_event(uuid, text),
  public.admin_list_users(), public.admin_update_user(uuid, public.app_role, boolean, text, text),
  public.admin_set_capability(public.app_role, text, boolean), public.admin_stats(), public.admin_recent_events(integer)
to authenticated;

grant execute on function public.cleanup_expired() to service_role;
