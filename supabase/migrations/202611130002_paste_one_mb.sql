begin;

alter table public.paste_notes drop constraint paste_notes_text_check;
alter table public.paste_notes add constraint paste_notes_text_check
  check (text ~ '[^[:space:]]' and octet_length(text) <= 1000000);

create or replace function public.paste_note_add(
  p_room_hash text, p_text text, p_ttl_seconds integer, p_subject text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_note public.paste_notes%rowtype;
  v_subject text;
begin
  if p_room_hash is null or p_room_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Tautan ruang tidak valid.'));
  end if;
  if p_text is null or p_text !~ '[^[:space:]]' then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Masukkan teks terlebih dahulu.'));
  end if;
  if octet_length(p_text) > 1000000 then
    return jsonb_build_object('status', 413, 'error', jsonb_build_object('message', 'Teks terlalu panjang. Maksimal 1 MB.'));
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not in (600, 3600, 86400) then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Masa berlaku tidak valid.'));
  end if;

  if p_subject is null or char_length(btrim(p_subject)) > 120 then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Subject maksimal 120 karakter.'));
  end if;

  -- A transaction lock makes the room and total limits atomic.
  perform pg_advisory_xact_lock(75192034618);
  delete from public.paste_notes where expires_at <= v_now;
  delete from paste_private.rate_limits where window_started_at <= v_now - interval '1 minute';
  if exists (select 1 from paste_private.rate_limits where room_hash = p_room_hash and write_count >= 20) then
    return jsonb_build_object('status', 429, 'error', jsonb_build_object('message', 'Terlalu banyak kiriman. Tunggu sebentar.'));
  end if;
  if (select count(*) from public.paste_notes where room_hash = p_room_hash) >= 25 then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('message', 'Ruang penuh. Hapus salah satu teks terlebih dahulu.'));
  end if;
  if (select count(*) from public.paste_notes) >= 1000 then
    return jsonb_build_object('status', 503, 'error', jsonb_build_object('message', 'Papan teks sedang penuh. Coba lagi nanti.'));
  end if;

  v_subject := btrim(p_subject);
  if v_subject = '' then
    select 'Memo ' || (coalesce(max(substring(subject from '^Memo ([0-9]+)$')::numeric), 0) + 1)::text
      into v_subject from public.paste_notes where room_hash = p_room_hash;
  end if;
  insert into public.paste_notes (room_hash, subject, text, created_at, expires_at)
    values (p_room_hash, v_subject, p_text, v_now, v_now + make_interval(secs => p_ttl_seconds))
    returning * into v_note;
  insert into paste_private.rate_limits (room_hash, window_started_at, write_count)
    values (p_room_hash, v_now, 1)
    on conflict (room_hash) do update set write_count = rate_limits.write_count + 1;
  return jsonb_build_object('note', jsonb_build_object(
    'id', v_note.id, 'subject', v_note.subject, 'text', v_note.text,
    'createdAt', floor(extract(epoch from v_note.created_at) * 1000)::bigint,
    'expiresAt', floor(extract(epoch from v_note.expires_at) * 1000)::bigint
  ));
end;
$$;
revoke all on function public.paste_note_add(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.paste_note_add(text, text, integer, text) to service_role;

notify pgrst, 'reload schema';
commit;
