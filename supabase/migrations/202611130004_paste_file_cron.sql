begin;
create extension if not exists pg_net with schema extensions;
select cron.schedule('paste-files-cleanup','* * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='paste-files-project-url') || '/functions/v1/paste-file-cleanup',
    headers := jsonb_build_object('Content-Type','application/json','apikey',
      (select decrypted_secret from vault.decrypted_secrets where name='paste-files-secret-key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$job$);
commit;
