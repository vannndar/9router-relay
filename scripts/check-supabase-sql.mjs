import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const container = `paste-db-test-${Date.now()}`;
const image = 'postgres:17-alpine@sha256:e5d2edd28b1f8d40a0a6c0c9cdc545b19b56a0d5d88f94bc11a97d970d4700d0';
const psqlArgs = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'];
const quote = text => `'${text.replaceAll("'", "''")}'`;
const query = sql => execFileSync('docker', psqlArgs, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const room = 'a'.repeat(64);
const addSql = (hash = room) => `set role service_role; select public.paste_note_add('${hash}', 'temporary test', 600);`;
const add = (hash = room) => JSON.parse(query(addSql(hash)));

execFileSync('docker', ['run', '--rm', '-d', '--name', container, '--network', 'none', '--memory', '256m',
  '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image], { stdio: 'pipe' });
try {
  for (let i = 0; ; i++) {
    try { execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'pipe' }); break; }
    catch { assert(i < 60, 'PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  query('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  const migration = readFileSync(new URL('../supabase/migrations/202611120001_paste_notes.sql', import.meta.url), 'utf8');
  query(migration);
  query(migration); // Setup is safe to retry before deployment.
  query(readFileSync(new URL('../supabase/migrations/202611130001_paste_subjects.sql', import.meta.url), 'utf8'));
  query(readFileSync(new URL('../supabase/migrations/202611130002_paste_one_mb.sql', import.meta.url), 'utf8'));
  query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  query(readFileSync(new URL('../supabase/migrations/202611130003_paste_files.sql', import.meta.url), 'utf8'));
  assert.equal(query("select relrowsecurity from pg_class where oid = 'public.paste_notes'::regclass"), 't');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(query(`select has_table_privilege('${role}', 'public.paste_notes', 'select')`), 'f');
    assert.equal(query(`select has_function_privilege('${role}', 'public.paste_note_add(text,text,integer)', 'execute')`), 'f');
    assert.equal(query(`select has_function_privilege('${role}', 'public.paste_note_add(text,text,integer,text)', 'execute')`), 'f');
  }
  const first = add().note;
  assert.equal(first.subject, 'Memo 1');
  const titled = JSON.parse(query(`set role service_role; select public.paste_note_add('${room}', 'test', 600, '  Laporan Januari  ');`));
  assert.equal(titled.note.subject, 'Laporan Januari');
  assert.equal(add().note.subject, 'Memo 2');
  const longTitle = JSON.parse(query(`set role service_role; select public.paste_note_add('${room}', 'test', 600, repeat('a',121));`));
  assert.equal(longTitle.status, 400);
  assert.equal(first.expiresAt - first.createdAt, 600_000);
  query(`set role service_role; delete from public.paste_notes where room_hash = '${'b'.repeat(64)}' and id = '${first.id}';`);
  assert.equal(query(`select count(*) from public.paste_notes where id = '${first.id}'`), '1');
  query("update public.paste_notes set created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes';");
  assert.equal(query('select count(*) from public.paste_notes where expires_at > now()'), '0');
  add();
  assert.equal(query('select count(*) from public.paste_notes'), '1', 'new writes purge expired notes');

  query('truncate public.paste_notes, paste_private.rate_limits;');
  for (let i = 0; i < 20; i++) {
    const note = add().note;
    query(`set role service_role; delete from public.paste_notes where id = '${note.id}';`);
  }
  assert.equal(add().status, 429, 'deleting notes must not bypass the write limit');

  query('truncate public.paste_notes, paste_private.rate_limits;');
  query(`insert into public.paste_notes (room_hash,text,created_at,expires_at)
    select '${room}','seed',now(),now()+interval '1 hour' from generate_series(1,24);`);
  const run = promisify(execFile);
  const parallel = await Promise.all([1, 2].map(() => run('docker', [...psqlArgs, '-c', addSql()])));
  const results = parallel.map(result => JSON.parse(result.stdout.trim()));
  assert.equal(results.filter(result => result.note).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  assert.equal(query('select count(*) from public.paste_notes'), '25');

  query('truncate public.paste_notes, paste_private.rate_limits;');
  query("insert into public.paste_notes (room_hash,text,created_at,expires_at) select lpad(n::text,64,'0'),'seed',now(),now()+interval '1 hour' from generate_series(1,1000) n;");
  assert.equal(add().status, 503);
  assert.equal(query('select count(*) from public.paste_notes'), '1000');
  const invalid = JSON.parse(query(`set role service_role; select public.paste_note_add('${room}', repeat('😀',250001),600);`));
  assert.equal(invalid.status, 413);
  query('truncate public.paste_notes, paste_private.rate_limits;');
  for (const value of ["repeat('x',1000000)", "repeat('😀',250000)"]) {
    const id = query(`set role service_role; select public.paste_note_add('${room}',${value},600)#>>'{note,id}';`);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(query(`select octet_length(text) from public.paste_notes where id='${id}'`), '1000000');
  }
  query('truncate public.paste_notes,paste_private.rate_limits,paste_private.file_cleanup;');
  const beginFile = (size=12) => JSON.parse(query(`set role service_role; select public.paste_file_begin('${room}','laporan.xlsx',${size},'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','','',600);`));
  assert.equal(beginFile(5000001).status,413);
  const file = beginFile();
  assert.equal(file.storage_path, `${room}/${file.id}`);
  assert.equal(query(`select file_status||':'||octet_length(text) from public.paste_notes where id='${file.id}'`),'pending:0');
  assert.equal(JSON.parse(query(`set role service_role; select public.paste_file_complete('${'b'.repeat(64)}','${file.id}');`)).status,409);
  const completed = JSON.parse(query(`set role service_role; select public.paste_file_complete('${room}','${file.id}');`));
  assert.equal(completed.note.file.name,'laporan.xlsx');
  assert.equal(query(`select file_status from public.paste_notes where id='${file.id}'`),'ready');
  for(const role of ['anon','authenticated']) {
    assert.equal(query(`select has_function_privilege('${role}','public.paste_file_begin(text,text,bigint,text,text,text,integer)','execute')`),'f');
    assert.equal(query(`select has_table_privilege('${role}','paste_private.file_cleanup','select')`),'f');
  }
  query(`set role service_role; delete from public.paste_notes where id='${file.id}';`);
  assert.equal(query('select count(*) from paste_private.file_cleanup'),'1');
  query(`set role service_role; select public.paste_file_cleanup_done(array['${file.storage_path}']);`);
  assert.equal(query('select count(*) from paste_private.file_cleanup where due_at>now()'),'1');
  query(`update paste_private.file_cleanup set retry_until=now()-interval '1 minute'; set role service_role; select public.paste_file_cleanup_done(array['${file.storage_path}']);`);
  assert.equal(query('select count(*) from paste_private.file_cleanup'),'0');
  const abandoned=beginFile();
  query(`update public.paste_notes set upload_deadline=now()-interval '1 second' where id='${abandoned.id}';`);
  assert.equal(query('set role service_role; select count(*) from public.paste_file_cleanup_candidates();'),'1');
  assert.equal(query('select count(*) from public.paste_notes'),'0');
  console.log(JSON.stringify({ postgres: '17', schema: 'passed', rlsAndGrants: 'passed', expiry: 'passed', files: 'pending, finalize, room isolation, size limit, deletion queue and abandoned cleanup passed',
    rateLimitAfterDelete: 'passed', concurrentRoomLimit: 'passed', totalLimit: 'passed',
    cron: 'requires hosted Supabase pg_cron; not run in this PostgreSQL test' }));
} finally {
  execFileSync('docker', ['stop', '--time', '2', container], { stdio: 'pipe' });
}
