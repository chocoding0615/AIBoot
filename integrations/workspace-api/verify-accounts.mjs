import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync as ex}from'node:child_process';
import {WorkspaceReader}from'./reader.mjs';import {ConnectionVerifier}from'./accounts.mjs';import {clients,credentialPaths}from'../chat-assistant/sources.mjs';import {createApi}from'../report-scheduler/api.mjs';import {createSessionBackend}from'./session.mjs';import {verifyPrivate}from'./access.mjs';
async function main(){
if(!process.argv.includes('--confirm-existing-auth-read-only'))throw Error('명시적 읽기 검증 승인이 필요합니다');
const home=path.join(os.homedir(),'.aiboot'),cfg=JSON.parse(fs.readFileSync(home+'/config.json','utf8')),hash=p=>{try{return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const ps=s=>ex('powershell.exe',['-NoProfile','-NonInteractive','-Command',s],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
const schedule=()=>ps("Get-ScheduledTask -TaskName 'AIBoot-DualReport-*' | Sort-Object TaskName | ForEach-Object { Export-ScheduledTask -TaskName $_.TaskName }");
const files=[...new Set(['config.json','ledger.json','assistant/state.json','assistant.json','chat-token.json','holidays.json','workspace-api/access.json','extra-reports/access.json','extra-reports/state.json'].map(p=>path.join(home,p)).concat(credentialPaths(cfg,home,'sheets'),credentialPaths(cfg,home,'chat')))];
const before=files.map(p=>({path:p,hash:hash(p)})),xml=schedule(),audit=path.join(home,'backups','account-v1-audit-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(audit,{recursive:true});ex('icacls.exe',[audit,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(audit+'/before.json',JSON.stringify(before,null,2));fs.writeFileSync(audit+'/scheduler.before.xml',xml);
const result={startedAt:new Date().toISOString(),external:{resourceReads:0,refreshRequests:0,unexpectedRequests:0,modelCalls:0,webhookCalls:0},productionAccessAclVerified:verifyPrivate(home+'/workspace-api/access.json')};let control,browser;
try{
 if(!result.productionAccessAclVerified)throw Object.assign(Error(),{code:'ACCESS_ACL_UNVERIFIED'});
 const reader=new WorkspaceReader({home}),verifier=new ConnectionVerifier({reader,enabled:true,makeClients:(c,h,options)=>clients(c,h,{...options,onAuth:auth=>{
  const request=auth.transporter.request.bind(auth.transporter);auth.transporter.request=options=>{if(String(options.method||'GET').toUpperCase()==='GET')result.external.resourceReads++;else if(String(options.url).endsWith('/token'))result.external.refreshRequests++;else result.external.unexpectedRequests++;return request(options);};options.onAuth(auth);
 }})});
 const token=crypto.randomBytes(32).toString('hex'),code=crypto.randomBytes(32).toString('hex'),origin='http://127.0.0.1:5173';
 control=createApi({reader,verifier,service:{},token});const a=await control.listen();
 browser=createSessionBackend({controlUrl:'http://127.0.0.1:'+a.port,controlToken:token,pairingCode:code,pairingExpiresAt:Date.now()+60000,uiOrigin:origin});const b=await browser.listen(),base='http://127.0.0.1:'+b.port;
 let r=await fetch(base+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({code})});if(r.status!==200)throw Object.assign(Error(),{code:'SESSION_CHECK_FAILED'});const cookie=r.headers.get('set-cookie').split(';')[0],csrf=(await r.json()).data.csrfToken;
 const headers={origin,cookie,'x-csrf-token':csrf,'content-type':'application/json'};
 const old=await fetch(base+'/api/connections',{headers});const oldValue=await old.json();
 const start=Date.now();r=await fetch(base+'/api/connections/verify',{method:'POST',headers,body:JSON.stringify({sources:['sheets','chat']})});const value=await r.json();
 result.verify={http:r.status,durationMs:Date.now()-start,status:value.status||null,error:value.error?.code||null,items:value.data?.items||null};
 const after=await (await fetch(base+'/api/connections',{headers})).json();result.getConnectionsCompatible=oldValue.apiVersion===after.apiVersion&&JSON.stringify(oldValue.data)===JSON.stringify(after.data);
 if(r.status===409&&value.error?.code==='REPORT_PROTECTED')result.liveAccess='blocked_by_existing_protection';
 else if(r.status===200)result.liveAccess='classified';
 else result.liveAccess='unverified';
}catch(e){result.failure=e.code||'CHECK_UNAVAILABLE';}
finally{
 if(browser)await browser.close();if(control)await control.close();
 result.protectedChanged=before.filter(x=>hash(x.path)!==x.hash).length;result.schedulerUnchanged=schedule()===xml;
 result.productionApiListeners=Number(ps("@(Get-NetTCPConnection -LocalPort 17841,17842 -State Listen -ErrorAction SilentlyContinue).Count").trim());
 result.completedAt=new Date().toISOString();fs.writeFileSync(audit+'/result.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({audit,...result}));if(result.protectedChanged||!result.schedulerUnchanged||result.external.unexpectedRequests)process.exitCode=1;
}

}
main().catch(()=>{console.error(JSON.stringify({error:'CHECK_UNAVAILABLE'}));process.exitCode=1;});
