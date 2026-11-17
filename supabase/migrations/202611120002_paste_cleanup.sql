begin;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('paste-notes-expiry', '* * * * *', $job$
  delete from public.paste_notes where expires_at <= now();
  delete from paste_private.rate_limits where window_started_at <= now() - interval '1 minute';
$job$);

commit;
