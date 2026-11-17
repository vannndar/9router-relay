import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash,randomInt } from 'node:crypto';
import { createPasteGateway } from '../lib/paste.mjs';
import { supabaseConnection } from '../lib/paste-supabase-config.mjs';

const env=parseEnv(readFileSync(new URL('../.env.supabase.local',import.meta.url),'utf8'));
const production=process.argv.includes('--production');
if(production && !process.env.CHECK_BASE_URL) throw new Error('CHECK_BASE_URL is required for --production');
const base=production?process.env.CHECK_BASE_URL:'https://local.example';
const room=String(randomInt(1000000)).padStart(6,'0'),hash=createHash('sha256').update(room).digest('hex');
const gateway=createPasteGateway({env});
const connection=supabaseConnection(env);
const ids=new Set();
async function api(method,suffix='',body,roomValue=room){
  const req=new Request(`${base}/api/paste${suffix}`,{method,headers:{'x-paste-room':roomValue,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const res=production?await fetch(req):await gateway(req);
  const payload=[204,304].includes(res.status)?null:await res.json();return {res,payload};
}
async function admin(path,method='GET',body){
  const headers=new Headers(connection.headers);if(body!==undefined)headers.set('content-type','application/json');
  const res=await fetch(new URL(path,connection.base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  assert(res.ok,`Admin ${method} ${path.split('?')[0]} returned ${res.status}`);return res.status===204?null:res.json();
}
async function begin(size,name='uji-transfer.txt'){
  const result=await api('POST','/files',{fileName:name,fileSize:size,text:'',subject:'Uji lampiran otomatis',ttlSeconds:600});
  assert.equal(result.res.status,201,JSON.stringify(result.payload));ids.add(result.payload.noteId);return result.payload;
}
async function put(upload,bytes){
  return fetch(upload.uploadUrl,{method:'PUT',headers:{'content-type':upload.contentType,'x-upsert':'false','cache-control':'0'},body:bytes,signal:AbortSignal.timeout(120000)});
}
const digest=data=>createHash('sha256').update(data).digest('hex');
try{
  const bucket=await admin('/storage/v1/bucket/paste-files');assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,5000000);
  const tooBig=await api('POST','/files',{fileName:'big.txt',fileSize:5000001});assert.equal(tooBig.res.status,413);
  // Exactly 5 MB goes directly to Storage, bypassing the smaller hosting request limit.
  const bytes=Buffer.alloc(5000000,65);bytes.write('Synthetic transfer verification only.\n');
  const upload=await begin(bytes.length);
  assert(!(await api('GET')).payload.notes.some(n=>n.id===upload.noteId),'pending upload must stay hidden');
  const putResult=await put(upload,bytes);assert(putResult.ok,`Storage upload ${putResult.status}: ${await putResult.text()}`);
  const completed=await api('POST',`/files/${upload.noteId}/complete`);assert.equal(completed.res.status,200,JSON.stringify(completed.payload));
  const listed=(await api('GET')).payload.notes.find(n=>n.id===upload.noteId);assert.equal(listed.file.size,5000000);assert.equal(listed.text,'');
  const download=await api('GET',`/files/${upload.noteId}/download`);assert.equal(download.res.status,200,JSON.stringify(download.payload));
  const downloaded=await fetch(download.payload.url,{signal:AbortSignal.timeout(60000)});assert(downloaded.ok);
  assert.match(downloaded.headers.get('content-disposition'),/attachment/);
  assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())),digest(bytes));
  const other=String((Number(room)+1)%1000000).padStart(6,'0');
  assert.equal((await api('GET',`/files/${upload.noteId}/download`,undefined,other)).res.status,404);
  const publicRead=await fetch(`${env.SUPABASE_URL}/storage/v1/object/public/paste-files/${hash}/${upload.noteId}`);assert(!publicRead.ok);
  assert.equal((await api('DELETE',`/${upload.noteId}`)).res.status,204);
  assert.equal((await api('GET',`/files/${upload.noteId}/download`)).res.status,404);
  const removedInfo=await fetch(`${env.SUPABASE_URL}/storage/v1/object/info/paste-files/${hash}/${upload.noteId}`,{headers:connection.headers});
  assert(!removedInfo.ok,'deleted object must be removed from Storage');
  console.log('Passed: private bucket, exact 5 MB upload/download hash, room isolation, pending hidden, deletion.');

  const oversized=await begin(5000000);
  assert(!(await put(oversized,Buffer.alloc(5000001))).ok,'Storage must enforce its own size limit');
  const mismatch=await begin(12);assert((await put(mismatch,Buffer.from('smaller'))).ok);
  assert.equal((await api('POST',`/files/${mismatch.noteId}/complete`)).res.status,400);
  const expired=await begin(3);assert((await put(expired,Buffer.from('old'))).ok);
  assert.equal((await api('POST',`/files/${expired.noteId}/complete`)).res.status,200);
  const expiredAt=Date.now()-1000;
  await admin(`/rest/v1/paste_notes?id=eq.${expired.noteId}&room_hash=eq.${hash}`,'PATCH',{
    created_at:new Date(expiredAt-600000).toISOString(),expires_at:new Date(expiredAt).toISOString()});
  assert.equal((await api('GET',`/files/${expired.noteId}/download`)).res.status,404);
  const abandoned=await begin(9);assert((await put(abandoned,Buffer.from('temporary'))).ok);
  await admin(`/rest/v1/paste_notes?id=eq.${abandoned.noteId}&room_hash=eq.${hash}`,'PATCH',{upload_deadline:new Date(Date.now()-1000).toISOString()});
  const unauth=await fetch(`${env.SUPABASE_URL}/functions/v1/paste-file-cleanup`,{method:'POST'});assert.equal(unauth.status,401);
  const cleaned=await admin('/functions/v1/paste-file-cleanup','POST',{});assert(Number.isInteger(cleaned.deleted));
  const abandonedInfo=await fetch(`${env.SUPABASE_URL}/storage/v1/object/info/paste-files/${hash}/${abandoned.noteId}`,{headers:connection.headers});
  assert(!abandonedInfo.ok,'abandoned file must be removed');
  assert.equal((await api('GET',`/files/${abandoned.noteId}/download`)).res.status,404);
  console.log('Passed: Storage rejects over-limit bytes, mismatched size rejected, expired downloads blocked, authenticated cleanup, abandoned upload removed.');
}finally{
  for(const id of ids)await api('DELETE',`/${id}`);
  console.log(`Removed ${ids.size} synthetic test reservations (${production?'production':'gateway + live Supabase'}).`);
}
