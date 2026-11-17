import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createPasteGateway } from '../lib/paste.mjs';

const env={PASTE_STORAGE:'supabase',SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_test_only'};
const room='012345',hash=createHash('sha256').update(room).digest('hex');
const id='12345678-1234-1234-1234-123456789abc',path=`${hash}/${id}`;
const req=(method,suffix='',body,headers={})=>new Request(`https://relay.example/api/paste/files${suffix}`,{
  method,headers:{'x-paste-room':room,...headers},body:body===undefined?undefined:JSON.stringify(body)});
const metadata={fileName:'Laporan.xlsx',fileSize:5000000,text:'',subject:'',ttlSeconds:600};
const note={id,file_name:'Laporan.xlsx',file_size:5000000,file_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  storage_path:path,file_status:'pending',expires_at:new Date(Date.now()+600000).toISOString(),upload_deadline:new Date(Date.now()+600000).toISOString()};

test('file reservation validates metadata before upstream, pins signed upload URLs and keeps credentials server-side',async()=>{
  let calls=0;
  const gateway=createPasteGateway({env,fetchImpl:async(url,init)=>{
    calls++; assert.equal(url.origin,env.SUPABASE_URL); assert.equal(init.headers.get('apikey'),env.SUPABASE_SECRET_KEY);
    assert.equal(init.redirect,'manual');
    if(url.pathname.endsWith('/paste_file_begin')){
      assert.equal(JSON.parse(init.body).p_room_hash,hash); return Response.json({id,storage_path:path});
    }
    assert.equal(url.pathname,`/storage/v1/object/upload/sign/paste-files/${path}`);
    return Response.json({url:`/object/upload/sign/paste-files/${path}?token=upload-only`});
  }});
  for(const [body,status] of [[{...metadata,fileSize:5000001},413],[{...metadata,fileSize:0},413],[{...metadata,fileName:'../x.xlsx'},400],
    [{...metadata,fileName:'script.html'},400],[{...metadata,text:'😀'.repeat(250001)},413],[{...metadata,subject:'x'.repeat(121)},400],
    [{...metadata,ttlSeconds:1},400],[null,400]])assert.equal((await gateway(req('POST','',body))).status,status);
  assert.equal(calls,0);
  const response=await gateway(req('POST','',metadata)); assert.equal(response.status,201);
  const body=await response.text(); assert.doesNotMatch(body,/sb_secret/);assert.match(body,/upload-only/);assert.equal(calls,2);
});

test('file finalization verifies actual storage size; downloads require matching room and ready metadata',async()=>{
  let actualSize=5000000,found=true,completed=0;
  const gateway=createPasteGateway({env,fetchImpl:async(url,init)=>{
    if(url.pathname==='/rest/v1/paste_notes'){
      assert.equal(url.searchParams.get('room_hash'),`eq.${hash}`);assert.equal(url.searchParams.get('id'),`eq.${id}`);
      assert.match(url.searchParams.get('expires_at'),/^gt\./); return Response.json(found?[note]:[]);
    }
    if(url.pathname.includes('/object/info/'))return Response.json({metadata:{size:actualSize}});
    if(url.pathname.endsWith('/paste_file_complete')){completed++;return Response.json({note:{id}});}
    assert.equal(url.pathname,`/storage/v1/object/sign/paste-files/${path}`);
    assert(JSON.parse(init.body).expiresIn<=60);return Response.json({signedURL:`/object/sign/paste-files/${path}?token=read-only`});
  }});
  assert.equal((await gateway(req('GET',`/${id}/download`))).status,404);
  actualSize=1;assert.equal((await gateway(req('POST',`/${id}/complete`))).status,400);assert.equal(completed,0);
  actualSize=5000000;assert.equal((await gateway(req('POST',`/${id}/complete`))).status,200);assert.equal(completed,1);
  note.file_status='ready';
  const download=await gateway(req('GET',`/${id}/download`));assert.equal(download.status,200);
  assert.equal(new URL((await download.json()).url).searchParams.get('download'),'Laporan.xlsx');
  found=false;assert.equal((await gateway(req('GET',`/${id}/download`))).status,404);
});

test('file routes reject cross-origin requests, absent rooms, wrong methods and redirected storage URLs',async()=>{
  const gateway=createPasteGateway({env,fetchImpl:()=>assert.fail('must not fetch')});
  assert.equal((await gateway(req('POST','',metadata,{origin:'https://other.example'}))).status,403);
  assert.equal((await gateway(req('POST','',metadata,{'x-paste-room':''}))).status,400);
  assert.equal((await gateway(req('GET'))).status,405);
  let deleted=false;
  const malicious=createPasteGateway({env,fetchImpl:async(url,init)=>{
    if(init.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
    return Response.json(url.pathname.endsWith('/paste_file_begin')?{id,storage_path:path}:{url:'https://evil.example/upload'});
  }});
  assert.equal((await malicious(req('POST','',metadata))).status,502);assert(deleted,'failed signing must remove its pending reservation');
});

const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(setImmediate);}assert.fail('UI did not settle');};
test('file UI waits for Send, supports file-only memos and filename search, and preserves attachments after failure',async()=>{
  const dom=new JSDOM(readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),{url:`https://relay.example/paste#r=${room}`,runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,get=id=>w.document.getElementById(id);let posted=0,uploaded=0,fail=true,ready=false;
  w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;
  w.fetch=async(url,init)=>{
    if(init.method==='PUT'){uploaded++;return new Response(null,{status:fail?500:200});}
    if(init.method==='DELETE')return new Response(null,{status:204});
    if(init.method==='POST'&&url.endsWith('/files')){posted++;return Response.json({noteId:id,uploadUrl:`${env.SUPABASE_URL}/upload`,contentType:'text/plain'});}
    if(url.endsWith('/complete')){ready=true;return Response.json({note:{id}});}
    return Response.json({notes:ready?[{id,subject:'Memo 1',text:'',file:{name:'contoh.txt',size:5,type:'text/plain'},expiresAt:Date.now()+600000}]:[]});
  };
  try{
    w.eval(readFileSync(new URL('../web/paste.mjs',import.meta.url),'utf8'));
    const choose=file=>{Object.defineProperty(get('pasteFile'),'files',{value:[file],configurable:true});get('pasteFile').dispatchEvent(new w.Event('change'));};
    choose(new w.File(['x'],'invalid.exe'));assert.match(get('pasteNotice').textContent,/Gunakan Word/);
    choose({name:'big.txt',size:5000001});assert.match(get('pasteNotice').textContent,/5 MB/);
    choose(new w.File(['hello'],'contoh.txt'));assert.equal(posted,0);assert.equal(get('pasteInput').required,false);
    get('pasteForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await until(()=>get('pasteNotice').textContent.includes('Unggahan belum berhasil'));
    assert.equal(get('selectedFile').hidden,false);assert.equal(uploaded,1);
    await until(()=>!get('publishPasteButton').disabled);fail=false;
    get('pasteForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await until(()=>get('pasteList').querySelector('.memo-file'));
    assert.equal(get('selectedFile').hidden,true);assert.equal(get('pasteInput').required,true);
    assert.equal(get('pasteList').querySelector('.memo-download').textContent,'Unduh');
    assert.equal(get('pasteList').querySelector('.paste-text'),null);
    get('pasteSearch').value='CONTOH.TXT';get('pasteSearch').dispatchEvent(new w.Event('input'));
    assert.equal(get('pasteList').querySelectorAll('.paste-card').length,1);
  }finally{dom.window.close();}
});
