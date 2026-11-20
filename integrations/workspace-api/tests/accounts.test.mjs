import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createRequire}from'node:module';
import {ConnectionVerifier,accountFailure,boundAuth}from'../accounts.mjs';import {clients}from'../../chat-assistant/sources.mjs';import {createApi}from'../../report-scheduler/api.mjs';import {createSessionBackend}from'../session.mjs';
function fixture(t,{error,hang=false,budgetMs=15000}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-accounts-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const write=(p,v)=>{const f=path.join(home,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};
 write('sdk/dist/gcp-oauth.keys.json',{installed:{client_id:'synthetic',client_secret:'synthetic'}});write('sdk/dist/.gsheets-server-credentials.json',{access_token:'synthetic'});write('chat-token.json',{access_token:'synthetic'});
 const report={googleAuthDir:home+'/sdk',spreadsheetId:'fixed',contractsSpreadsheetId:'contracts',opsSpreadsheetId:'welfare',recurringSpreadsheetId:'recurring',sourceSheetIds:{fixed:1,daily:2,contracts:3,licenses:4,welfare:5,recurring:6,history:7,master:8},chatSpaces:['spaces/synthetic1','spaces/synthetic2']};
 let blocked=false,calls=[],cancelled=0;
 const reader={home,busy:false,config:()=>report,check:()=>{if(blocked)throw Object.assign(Error('비공개 보호 상태'),{code:'REPORT_PROTECTED',status:409});}};
 const response=async(service,a,o)=>{
  calls.push({service,args:a});assert.ok(o.signal);assert.equal(o.retry,false);
  if(hang)return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{cancelled++;reject(Object.assign(Error('비공개 토큰·경로'),{name:'AbortError'}));},{once:true}));
  const e=typeof error==='function'?error(service,a):error;if(e)throw e;
  if(service==='chat')return {data:{}};
  const titles={fixed:['[MS] AD_관리비 내역',[[1,'JP매월 지출'],[2,'AIBoot_데일리마감']]],contracts:['[MS] AD_계약서 관리',[[3,'계약서(DB)'],[4,'프로그램(2026)']]],welfare:['[MS] AD_운영 관리',[[5,'복지포인트 관리(2026)']]],recurring:['[MS] 김현호',[[6,'업무'],[7,'반복업무_처리이력'],[8,'Master_Sheet']]]},def=titles[a.spreadsheetId];
  return {data:{properties:{title:def[0]},sheets:def[1].map(([sheetId,title])=>({properties:{sheetId,title,hidden:true}}))}};
 };
 const makeClients=(c,h,options)=>{assert.equal(h,home);const [service]=options.services;return {sheets:()=>({get:(a,o)=>response('sheets',a,o)}),chat:{spaces:{messages:{list:(a,o)=>response('chat',a,o)}}}};};
 const verifier=new ConnectionVerifier({reader,enabled:true,makeClients,budgetMs});
 return {home,report,reader,verifier,calls,write,block:()=>blocked=true,cancelled:()=>cancelled};
}
test('두 서비스 전체 최소 검사 성공: 메타데이터4회·Chat2회만',async t=>{const f=fixture(t),r=await f.verifier.verify({sources:['sheets','chat']});assert.equal(r.status,'ok');assert.equal(r.apiVersion,'v1');assert.deepEqual(r.data.items.map(x=>x.state),['connected','connected']);assert.ok(r.data.items.every(x=>x.verifiedAccess===true&&x.scopeStatus==='sufficient'&&x.accountLabel===null));assert.equal(f.calls.length,6);for(const x of f.calls){if(x.service==='sheets'){assert.equal(x.args.ranges,undefined);assert.equal(x.args.fields,'properties(title),sheets(properties(sheetId,title))');}else{assert.equal(x.args.fields,'nextPageToken');assert.equal(x.args.pageSize,1);assert.ok(['spaces/synthetic1','spaces/synthetic2'].includes(x.args.parent));}}});
for(const service of ['sheets','chat'])test('요청 서비스만 확인: '+service,async t=>{const f=fixture(t);await f.verifier.verify({sources:[service]});assert.ok(f.calls.every(x=>x.service===service));});
for(const body of [null,[],{}, {sources:[]},{sources:['gmail']},{sources:['sheets','sheets']},{sources:['Sheets']},{sources:'sheets'},{sources:['chat'],path:'비공개'},{sources:['chat',1]}])test('잘못된 sources/추가 필드 차단 '+JSON.stringify(body),async t=>{const f=fixture(t);await assert.rejects(f.verifier.verify(body),{code:'INVALID_REQUEST'});assert.equal(f.calls.length,0);});
test('미설정은 정상·재인증 필요가 아님',async t=>{const f=fixture(t);delete f.report.spreadsheetId;const r=await f.verifier.verify({sources:['sheets','chat']});assert.equal(r.status,'partial');assert.equal(r.data.items[0].state,'not_configured');assert.equal(r.data.items[0].verifiedAccess,null);assert.equal(r.data.items[1].state,'connected');assert.ok(f.calls.every(c=>c.service==='chat'));});
test('기능 기본 비활성은 외부 호출 없이503',async t=>{const f=fixture(t);f.verifier.enabled=false;await assert.rejects(f.verifier.verify({sources:['chat']}),{code:'VERIFICATION_DISABLED',status:503});assert.equal(f.calls.length,0);});
test('공식 gid 불일치이면 Sheets 서비스 전체 검증 실패',async t=>{const f=fixture(t);f.report.sourceSheetIds.history=99;const r=await f.verifier.verify({sources:['sheets']});assert.equal(r.data.items[0].state,'error');assert.equal(r.data.items[0].verifiedAccess,null);assert.equal(r.data.items[0].scopeStatus,'unknown');});
test('Chat 한 공간만 성공해도 서비스 connected 금지',async t=>{const f=fixture(t,{error:(s,a)=>a.parent==='spaces/synthetic2'?Object.assign(Error('비공개'),{response:{status:403,data:{error:{status:'PERMISSION_DENIED'}}}}):null});const r=await f.verifier.verify({sources:['chat']});assert.equal(r.data.items[0].state,'access_denied');assert.equal(r.status,'partial');});
const cases=[
 ['구조화된 invalid_grant','oauth_refresh',400,{error:'invalid_grant'},'reauth_required','AUTH_REQUIRED','unknown'],
 ['자원401 미확정','resource',401,{error:{status:'UNAUTHENTICATED'}},'error','CHECK_FAILED','unknown'],
 ['원인 불명403','resource',403,{},'error','CHECK_FAILED','unknown'],
 ['권한거부','resource',403,{error:{status:'PERMISSION_DENIED'}},'access_denied','PERMISSION_DENIED','unknown'],
 ['scope 부족','resource',403,{error:{errors:[{reason:'insufficientPermissions'}]}},'access_denied','PERMISSION_DENIED','insufficient'],
 ['API 미활성','resource',403,{error:{status:'PERMISSION_DENIED',details:[{reason:'SERVICE_DISABLED'}]}},'error','CHECK_FAILED','unknown'],
 ['요청제한','resource',429,{},'unavailable','NETWORK_ERROR','unknown'],
 ['서버장애','resource',503,{},'unavailable','NETWORK_ERROR','unknown'],
 ['파손응답','resource',403,{error:{errors:'malformed'}},'error','CHECK_FAILED','unknown']
];
for(const [name,phase,status,data,state,code,scope]of cases)test('계정 오류 근거 분류: '+name,()=>{const x=accountFailure('chat',{message:'토큰·회사 식별자·경로 원문',verificationPhase:phase,response:{status,data}},'2026-11-20T00:00:00Z');assert.equal(x.state,state);assert.equal(x.errorCode,code);assert.equal(x.scopeStatus,scope);assert.ok(!JSON.stringify(x).includes('원문'));});
test('만료 시각이나 refresh token 존재만으로 재인증 판정하지 않음',()=>{const x=accountFailure('sheets',{expiry_date:1,refresh_token:'synthetic'},null);assert.equal(x.state,'error');});
test('보고 실행·결과 불명·보호 시간 gate 재사용',async t=>{const f=fixture(t);f.block();await assert.rejects(f.verifier.verify({sources:['chat']}),{code:'REPORT_PROTECTED'});assert.equal(f.calls.length,0);});
test('tasks 진행 중 검사 거절',async t=>{const f=fixture(t);f.reader.busy=true;await assert.rejects(f.verifier.verify({sources:['chat']}),{code:'RATE_LIMITED'});assert.equal(f.calls.length,0);});
test('동시 검사 거절·클라이언트 취소·busy 해제',async t=>{const f=fixture(t,{hang:true}),c=new AbortController(),pending=f.verifier.verify({sources:['chat']},{signal:c.signal});await assert.rejects(f.verifier.verify({sources:['sheets']}),{code:'RATE_LIMITED'});c.abort();await pending;assert.equal(f.cancelled(),1);assert.equal(f.reader.busy,false);});
test('전체 시간 초과는200 partial 및 서비스별 TIMEOUT으로 취소',async t=>{const f=fixture(t,{hang:true,budgetMs:25}),r=await f.verifier.verify({sources:['sheets','chat']});assert.equal(r.status,'partial');assert.ok(r.data.items.every(x=>x.state==='unavailable'&&x.errorCode==='TIMEOUT'&&x.verifiedAccess===null));assert.equal(f.cancelled(),1);assert.equal(r.data.items[1].checkedAt,null);});
test('조회 중 보호 상태로 전환되면409·전송 취소',async t=>{const f=fixture(t,{hang:true});const p=f.verifier.verify({sources:['chat']});setTimeout(f.block,5);await assert.rejects(p,{code:'REPORT_PROTECTED'});assert.equal(f.cancelled(),1);assert.equal(f.reader.busy,false);});
test('검사 전후 인증 파일·업무 원장 쓰기 없음',async t=>{const f=fixture(t);f.write('ledger.json',{synthetic:{status:'sent',chatUntil:'keep'}});const files=['sdk/dist/gcp-oauth.keys.json','sdk/dist/.gsheets-server-credentials.json','chat-token.json','ledger.json'],before=files.map(p=>fs.readFileSync(path.join(f.home,p),'utf8'));await f.verifier.verify({sources:['sheets','chat']});assert.deepEqual(files.map(p=>fs.readFileSync(path.join(f.home,p),'utf8')),before);assert.equal(fs.existsSync(f.home+'/extra-reports'),false);});
test('SDK refresh와 자원 자동 재시도는 전송 전 차단',async()=>{const calls=[],client={listenerCount:()=>0,transporter:{request:async o=>{calls.push(o);return {data:{}};}}},a=new AbortController();boundAuth(client,{signal:a.signal,remaining:()=>1234,guard:()=>{}});await client.transporter.request({url:'https://oauth2.googleapis.com/token',method:'POST',data:'grant_type=refresh_token',retry:true});await assert.rejects(client.transporter.request({url:'https://oauth2.googleapis.com/token',method:'POST',data:'grant_type=refresh_token'}),{code:'CHECK_RETRY_BLOCKED'});assert.equal(calls.length,1);assert.equal(calls[0].retry,false);assert.equal(calls[0].signal,a.signal);assert.equal(calls[0].timeout,1234);});
test('tokens 저장 listener가 있으면 검증 준비 거절',()=>{assert.throws(()=>boundAuth({listenerCount:()=>1},{signal:new AbortController().signal,remaining:()=>1,guard:()=>{}}),{code:'CHECK_UNAVAILABLE'});});
const token='d'.repeat(64),code='e'.repeat(64),origin='http://127.0.0.1:5173';
test('실제 세션→제어 API: POST만 추가, 무인증·CSRF·Origin·Host 차단',async t=>{
 const f=fixture(t),api=createApi({verifier:f.verifier,token,service:{}}),a=await api.listen();t.after(()=>api.close());const b=createSessionBackend({controlUrl:'http://127.0.0.1:'+a.port,controlToken:token,pairingCode:code,pairingExpiresAt:Date.now()+60000,uiOrigin:origin}),address=await b.listen();t.after(()=>b.close());const base='http://127.0.0.1:'+address.port;
 const post=(headers={},body={sources:['chat']},suffix='')=>fetch(base+'/api/connections/verify'+suffix,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)});
 assert.equal((await post()).status,401);let r=await fetch(base+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({code})});const cookie=r.headers.get('set-cookie').split(';')[0],csrf=(await r.json()).data.csrfToken,headers={cookie,'x-csrf-token':csrf};
 assert.equal((await post({cookie})).status,403);assert.equal((await post({...headers,origin:'http://evil.example'})).status,403);r=await post(headers);assert.equal(r.status,200);assert.equal((await r.json()).data.items[0].state,'connected');
 const bad=await post(headers,{sources:['gmail']});assert.equal(bad.status,400);assert.equal((await bad.json()).apiVersion,'v1');assert.equal((await post(headers,{sources:['chat']},'?probe=true')).status,400);
 assert.equal((await fetch(base+'/api/connections/verify',{headers:{origin,...headers}})).status,405);
 const hostStatus=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/connections/verify',{method:'POST',headers:{host:'evil.example',origin,...headers,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({sources:['chat']}));});assert.equal(hostStatus,403);
 assert.equal((await fetch('http://127.0.0.1:'+a.port+'/api/connections/verify',{method:'POST',headers:{authorization:'Bearer '+token,origin,'content-type':'application/json'},body:'{}'})).status,403);
});
const sdkDir=process.env.AIBOOT_GOOGLE_SDK_DIR;
test('설치된 실제 SDK: 기존 로더·refresh 메모리 갱신·파일 불변',{skip:!sdkDir},async t=>{
 const f=fixture(t),require=createRequire(path.join(sdkDir,'package.json')),real=require.resolve('googleapis'),proxy=path.join(f.report.googleAuthDir,'node_modules/googleapis');fs.mkdirSync(proxy,{recursive:true});fs.writeFileSync(proxy+'/package.json',JSON.stringify({main:'index.cjs'}));fs.writeFileSync(proxy+'/index.cjs','module.exports=require('+JSON.stringify(real)+');');
 const tokenFile=path.join(f.report.googleAuthDir,'dist/.gsheets-server-credentials.json');fs.writeFileSync(tokenFile,JSON.stringify({access_token:'synthetic-old',refresh_token:'synthetic-refresh',expiry_date:1}));const before=fs.readFileSync(tokenFile,'utf8');let refresh=0,resource=0;
 f.verifier.makeClients=(report,home,options)=>clients(report,home,{...options,onAuth:auth=>{
  auth.transporter.request=async o=>{if(String(o.url).endsWith('/token')){refresh++;assert.equal(o.retry,false);assert.ok(o.signal);return {data:{access_token:'synthetic-new',expires_in:3600}};}
   resource++;const id=decodeURIComponent(new URL(String(o.url)).pathname.split('/').pop());const defs={fixed:['[MS] AD_관리비 내역',[[1,'JP매월 지출'],[2,'AIBoot_데일리마감']]],contracts:['[MS] AD_계약서 관리',[[3,'계약서(DB)'],[4,'프로그램(2026)']]],welfare:['[MS] AD_운영 관리',[[5,'복지포인트 관리(2026)']]],recurring:['[MS] 김현호',[[6,'업무'],[7,'반복업무_처리이력'],[8,'Master_Sheet']]]},d=defs[id];return {data:{properties:{title:d[0]},sheets:d[1].map(([sheetId,title])=>({properties:{sheetId,title}}))},status:200};};
  options.onAuth(auth);
 }});
 const r=await f.verifier.verify({sources:['sheets']});assert.equal(r.data.items[0].state,'connected');assert.equal(refresh,1);assert.equal(resource,4);assert.equal(fs.readFileSync(tokenFile,'utf8'),before);
});
test('설치 SDK 실제 HTTP 전송은 AbortSignal로 종료',{skip:!sdkDir},async t=>{
 const require=createRequire(path.join(sdkDir,'package.json')),{google}=require('googleapis'),server=http.createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const auth=new google.auth.OAuth2('synthetic');auth.setCredentials({access_token:'synthetic',expiry_date:Date.now()+3600000});const controller=new AbortController();const p=auth.request({url:'http://127.0.0.1:'+server.address().port,method:'GET',signal:controller.signal,timeout:1000,retry:false});setTimeout(()=>controller.abort(),25);await assert.rejects(p);assert.equal(controller.signal.aborted,true);
});

test('원장·설정 확인 불가 시 서버 준비 오류로 안전 차단',async t=>{for(const kind of ['ledger','config']){const f=fixture(t);if(kind==='ledger')f.reader.check=()=>{throw Object.assign(Error('비공개 파일 경로'),{code:'MALFORMED_SOURCE',status:502});};else f.reader.config=()=>{throw Object.assign(Error('비공개 파일 경로'),{code:'ENOENT'});};await assert.rejects(f.verifier.verify({sources:['chat']}),{code:'CHECK_UNAVAILABLE',status:503});assert.equal(f.calls.length,0);assert.equal(f.reader.busy,false);}});
test('상속된 sources 필드는 승인 입력이 아님',async t=>{const f=fixture(t);const body=Object.assign(Object.create({sources:['chat']}),{other:1});await assert.rejects(f.verifier.verify(body),{code:'INVALID_REQUEST'});assert.equal(f.calls.length,0);});

test('전송 경계는 쓰기·새 OAuth grant·scope 확대·다른 호스트를 차단',async()=>{for(const options of [{url:'https://sheets.googleapis.com/v4/spreadsheets/fake',method:'POST'},{url:'https://oauth2.googleapis.com/token',method:'POST',data:'grant_type=authorization_code'},{url:'https://oauth2.googleapis.com/token',method:'POST',data:'grant_type=refresh_token&scope=new_scope'},{url:'https://evil.example/metadata',method:'GET'}]){let count=0;const client={listenerCount:()=>0,transporter:{request:async()=>{count++;}}};boundAuth(client,{signal:new AbortController().signal,remaining:()=>1000,guard:()=>{}});await assert.rejects(client.transporter.request(options),{code:'CHECK_REQUEST_BLOCKED'});assert.equal(count,0);}});

for(const rejected of [false,true])test('설치 SDK Chat 기존 인증 경로·invalid_grant 분류 '+rejected,{skip:!sdkDir},async t=>{
 const f=fixture(t),require=createRequire(path.join(sdkDir,'package.json')),real=require.resolve('googleapis'),proxy=path.join(f.report.googleAuthDir,'node_modules/googleapis');fs.mkdirSync(proxy,{recursive:true});fs.writeFileSync(proxy+'/package.json',JSON.stringify({main:'index.cjs'}));fs.writeFileSync(proxy+'/index.cjs','module.exports=require('+JSON.stringify(real)+');');
 const file=f.home+'/chat-token.json';fs.writeFileSync(file,JSON.stringify({access_token:'synthetic-old',refresh_token:'synthetic-refresh',expiry_date:1}));const before=fs.readFileSync(file,'utf8');let refresh=0,reads=0;
 f.verifier.makeClients=(report,home,options)=>clients(report,home,{...options,onAuth:auth=>{auth.transporter.request=async o=>{if(String(o.url).endsWith('/token')){refresh++;if(rejected)throw Object.assign(Error('비공개 인증 오류 원문'),{response:{status:400,data:{error:'invalid_grant'},config:{data:null}}});return {data:{access_token:'synthetic-new',expires_in:3600}};}reads++;assert.equal(new URL(String(o.url)).hostname,'chat.googleapis.com');return {data:{},status:200};};options.onAuth(auth);}});
 const r=await f.verifier.verify({sources:['chat']});assert.equal(r.data.items[0].state,rejected?'reauth_required':'connected');assert.equal(r.data.items[0].errorCode,rejected?'AUTH_REQUIRED':null);assert.equal(refresh,1);assert.equal(reads,rejected?0:2);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(!JSON.stringify(r).includes('비공개'));
});

test('시간 초과 뒤에도 다른 서비스의 확인된 미설정 사실 보존',async t=>{const f=fixture(t,{hang:true,budgetMs:25});fs.unlinkSync(f.home+'/chat-token.json');const r=await f.verifier.verify({sources:['sheets','chat']});assert.equal(r.data.items[0].state,'unavailable');assert.equal(r.data.items[1].state,'not_configured');assert.equal(r.data.items[1].configured,false);assert.equal(f.calls.length,1);});
