begin;

alter table public.paste_notes
  add column file_name text,
  add column file_size bigint,
  add column file_type text,
  add column storage_path text unique,
  add column file_status text,
  add column file_ttl_seconds integer,
  add column upload_deadline timestamptz,
  add column upload_token_expires_at timestamptz;
alter table public.paste_notes drop constraint paste_notes_text_check;
alter table public.paste_notes add constraint paste_notes_text_check
  check (octet_length(text) <= 1000000 and (text ~ '[^[:space:]]' or file_status is not null));
alter table public.paste_notes add constraint paste_attachment_check check (
  (file_status is null and storage_path is null and file_name is null and file_size is null and file_type is null
    and file_ttl_seconds is null and upload_deadline is null and upload_token_expires_at is null)
  or
  (file_status is not null and file_status in ('pending','ready') and file_name is not null and char_length(file_name) between 1 and 180
    and file_size is not null and file_size between 1 and 5000000 and file_type is not null
    and storage_path is not null and storage_path = room_hash || '/' || id::text
    and file_ttl_seconds is not null and file_ttl_seconds in (600,3600,86400)
    and upload_deadline is not null and upload_token_expires_at is not null)
);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values (
  'paste-files','paste-files',false,5000000,array[
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/pdf','text/plain','text/csv','image/png','image/jpeg','image/webp','image/gif'
  ]
);

create table paste_private.file_cleanup (
  storage_path text primary key,
  due_at timestamptz not null default now(),
  retry_until timestamptz not null
);
alter table paste_private.file_cleanup enable row level security;
revoke all on paste_private.file_cleanup from public,anon,authenticated;
grant select,insert,update,delete on paste_private.file_cleanup to service_role;
create index paste_file_cleanup_due on paste_private.file_cleanup(due_at);

create function paste_private.queue_file_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.storage_path is not null then
    insert into paste_private.file_cleanup(storage_path,retry_until)
    values(old.storage_path,old.upload_token_expires_at + interval '5 minutes')
    on conflict(storage_path) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function paste_private.queue_file_delete() from public,anon,authenticated;
create trigger paste_file_delete after delete on public.paste_notes
for each row execute function paste_private.queue_file_delete();

create function public.paste_file_begin(p_room_hash text,p_name text,p_size bigint,p_type text,
  p_text text,p_subject text,p_ttl_seconds integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  result jsonb;
  note_id uuid;
  object_path text;
begin
  if p_name is null or char_length(p_name) not between 1 and 180 or p_name ~ '[[:cntrl:]/\\]' then
    return jsonb_build_object('status',400,'error',jsonb_build_object('message','Nama file tidak valid.'));
  end if;
  if p_size is null or p_size not between 1 and 5000000 then
    return jsonb_build_object('status',413,'error',jsonb_build_object('message','Maksimal 5 MB per file.'));
  end if;
  if p_text is null or octet_length(p_text)>1000000 then
    return jsonb_build_object('status',413,'error',jsonb_build_object('message','Maksimal 1 MB per teks.'));
  end if;
  if p_type is null or not exists(select 1 from storage.buckets where id='paste-files' and p_type=any(allowed_mime_types)) then
    return jsonb_build_object('status',400,'error',jsonb_build_object('message','Jenis file belum didukung.'));
  end if;
  perform pg_advisory_xact_lock(75192034618);
  delete from public.paste_notes where expires_at<=statement_timestamp();
  -- Reserve the full upload allowance until finalization, even if a smaller size was declared.
  if (select coalesce(sum(case when file_status='pending' then 5000000 else file_size end),0)
      from public.paste_notes where storage_path is not null)+5000000>250000000 then
    return jsonb_build_object('status',503,'error',jsonb_build_object('message','Penyimpanan file sedang penuh.'));
  end if;
  result:=public.paste_note_add(p_room_hash,case when p_text ~ '[^[:space:]]' then p_text else 'Lampiran' end,p_ttl_seconds,p_subject);
  if result ? 'error' then return result; end if;
  note_id:=(result#>>'{note,id}')::uuid;
  object_path:=p_room_hash||'/'||note_id::text;
  update public.paste_notes set text=p_text,file_name=p_name,file_size=p_size,file_type=p_type,
    storage_path=object_path,file_status='pending',file_ttl_seconds=p_ttl_seconds,
    upload_deadline=statement_timestamp()+interval '10 minutes',
    upload_token_expires_at=statement_timestamp()+interval '2 hours'
    where id=note_id;
  return jsonb_build_object('id',note_id,'storage_path',object_path);
end;
$$;

create function public.paste_file_complete(p_room_hash text,p_note_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare n public.paste_notes%rowtype; t timestamptz:=statement_timestamp();
begin
  update public.paste_notes set file_status='ready',created_at=t,expires_at=t+make_interval(secs=>file_ttl_seconds)
  where id=p_note_id and room_hash=p_room_hash and file_status='pending' and upload_deadline>t and expires_at>t
  returning * into n;
  if not found then return jsonb_build_object('status',409,'error',jsonb_build_object('message','Unggahan sudah berakhir.')); end if;
  return jsonb_build_object('note',jsonb_build_object('id',n.id,'subject',n.subject,'file',jsonb_build_object('name',n.file_name,'size',n.file_size,'type',n.file_type)));
end;
$$;

create function public.paste_file_cleanup_candidates() returns table(storage_path text)
language plpgsql security invoker set search_path='' as $$
begin
  delete from public.paste_notes where expires_at<=statement_timestamp()
    or (file_status='pending' and upload_deadline<=statement_timestamp());
  return query select q.storage_path from paste_private.file_cleanup q where q.due_at<=statement_timestamp() order by q.due_at limit 100;
end;
$$;

create function public.paste_file_cleanup_done(p_paths text[]) returns void
language plpgsql security invoker set search_path='' as $$
begin
  -- Signed uploads last two hours. Delete once now, then again after their tokens expire to remove late replays.
  delete from paste_private.file_cleanup where storage_path=any(p_paths) and retry_until<=statement_timestamp();
  update paste_private.file_cleanup set due_at=retry_until where storage_path=any(p_paths);
end;
$$;

revoke all on function public.paste_file_begin(text,text,bigint,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.paste_file_complete(text,uuid) from public,anon,authenticated;
revoke all on function public.paste_file_cleanup_candidates() from public,anon,authenticated;
revoke all on function public.paste_file_cleanup_done(text[]) from public,anon,authenticated;
grant execute on function public.paste_file_begin(text,text,bigint,text,text,text,integer) to service_role;
grant execute on function public.paste_file_complete(text,uuid) to service_role;
grant execute on function public.paste_file_cleanup_candidates() to service_role;
grant execute on function public.paste_file_cleanup_done(text[]) to service_role;
grant update on public.paste_notes to service_role;
grant select on storage.buckets to service_role;
grant usage on schema storage to service_role;

notify pgrst,'reload schema';
commit;
