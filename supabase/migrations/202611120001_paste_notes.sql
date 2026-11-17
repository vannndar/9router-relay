begin;

create table if not exists public.paste_notes (
  id uuid primary key default gen_random_uuid(),
  room_hash text not null check (room_hash ~ '^[a-f0-9]{64}$'),
  text text not null check (text ~ '[^[:space:]]' and octet_length(text) <= 20000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at - created_at in (interval '10 minutes', interval '1 hour', interval '24 hours'))
);
create index if not exists paste_notes_room on public.paste_notes (room_hash, created_at desc, id desc);
create index if not exists paste_notes_expiry on public.paste_notes (expires_at);

-- Keep the existing write limit consistent across Vercel instances.
create schema if not exists paste_private;
create table if not exists paste_private.rate_limits (
  room_hash text primary key check (room_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  write_count integer not null check (write_count between 1 and 20)
);
create index if not exists paste_rate_limits_expiry on paste_private.rate_limits (window_started_at);

alter table public.paste_notes enable row level security;
alter table paste_private.rate_limits enable row level security;
revoke all on public.paste_notes from public, anon, authenticated;
revoke all on schema paste_private from public, anon, authenticated;
revoke all on paste_private.rate_limits from public, anon, authenticated;
grant select, insert, delete on public.paste_notes to service_role;
grant usage on schema paste_private to service_role;
grant select, insert, update, delete on paste_private.rate_limits to service_role;

create or replace function public.paste_note_add(
  p_room_hash text, p_text text, p_ttl_seconds integer default 3600
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_note public.paste_notes%rowtype;
begin
  if p_room_hash is null or p_room_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Tautan ruang tidak valid.'));
  end if;
  if p_text is null or p_text !~ '[^[:space:]]' then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Masukkan teks terlebih dahulu.'));
  end if;
  if octet_length(p_text) > 20000 then
    return jsonb_build_object('status', 413, 'error', jsonb_build_object('message', 'Teks terlalu panjang. Maksimal 20 KB.'));
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not in (600, 3600, 86400) then
    return jsonb_build_object('status', 400, 'error', jsonb_build_object('message', 'Masa berlaku tidak valid.'));
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

  insert into public.paste_notes (room_hash, text, created_at, expires_at)
    values (p_room_hash, p_text, v_now, v_now + make_interval(secs => p_ttl_seconds))
    returning * into v_note;
  insert into paste_private.rate_limits (room_hash, window_started_at, write_count)
    values (p_room_hash, v_now, 1)
    on conflict (room_hash) do update set write_count = rate_limits.write_count + 1;
  return jsonb_build_object('note', jsonb_build_object(
    'id', v_note.id, 'text', v_note.text,
    'createdAt', floor(extract(epoch from v_note.created_at) * 1000)::bigint,
    'expiresAt', floor(extract(epoch from v_note.expires_at) * 1000)::bigint
  ));
end;
$$;
revoke all on function public.paste_note_add(text, text, integer) from public, anon, authenticated;
grant execute on function public.paste_note_add(text, text, integer) to service_role;

commit;
