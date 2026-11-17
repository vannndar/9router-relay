import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';

const config = parseEnv(readFileSync(new URL('../.env.supabase.local',import.meta.url),'utf8'));
if(!config.SUPABASE_PROJECT_REF || !config.SUPABASE_URL.includes(config.SUPABASE_PROJECT_REF)) throw new Error('SUPABASE_PROJECT_REF must match SUPABASE_URL');
const cli=process.env.SUPABASE_CLI || 'supabase';
const run=args=>{
  try { return execFileSync(cli,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:4_000_000,
    env:{...process.env,SUPABASE_DB_PASSWORD:config.SUPABASE_DB_PASSWORD}}); }
  catch(e){throw new Error(`${e.stdout||''}\n${e.stderr||''}`.replaceAll(config.SUPABASE_SECRET_KEY,'[redacted]').replaceAll(config.SUPABASE_DB_PASSWORD,'[redacted]').replace(/sb_secret_[A-Za-z0-9_-]+/g,'[redacted]'));}
};
const quote=value=>`'${value.replaceAll("'","''")}'`;
// Vault keeps the scheduler credential encrypted; it is never written to migration source or stdout.
for(const [name,value] of [['paste-files-project-url',config.SUPABASE_URL],['paste-files-secret-key',config.SUPABASE_SECRET_KEY]]){
  run(['db','query','--remote','--yes',`do $vault$ declare key_id uuid; begin
    select id into key_id from vault.secrets where name=${quote(name)};
    if key_id is null then perform vault.create_secret(${quote(value)},${quote(name)});
    else perform vault.update_secret(key_id,${quote(value)}); end if;
  end; $vault$;`]);
}
console.log('Configured encrypted cleanup credentials.');
run(['functions','deploy','paste-file-cleanup','--use-api','--no-verify-jwt','--yes']);
console.log('Deployed authenticated file cleanup function.');
run(['db','push','--remote','--skip-vault','--yes']);
console.log('Applied private file bucket, metadata, and cleanup schedule.');
const statusFile=new URL('../supabase/setup-status.json',import.meta.url);
const status=JSON.parse(readFileSync(statusFile,'utf8'));
for(const name of ['202611130003_paste_files.sql','202611130004_paste_file_cron.sql']){
  const path=`supabase/migrations/${name}`; if(!status.migrations.includes(path))status.migrations.push(path);
}
Object.assign(status,{fileStorageBucket:'paste-files',fileStoragePrivate:true,maxFileBytes:5_000_000,fileCleanupFunction:'paste-file-cleanup'});
writeFileSync(statusFile,JSON.stringify(status,null,2)+'\n');
