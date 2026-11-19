import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {execFileSync as ex} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {WorkspaceReader} from './reader.mjs';import {clients} from '../chat-assistant/sources.mjs';import {createSessionBackend} from './session.mjs';import {initializeAccess,verifyPrivate} from './access.mjs';import {createApi} from '../report-scheduler/api.mjs';import {WindowsBackend,fingerprint} from '../report-scheduler/windows.mjs';import {ScheduleService} from '../report-scheduler/service.mjs';import {openStore} from '../report-scheduler/store.mjs';
const args=process.argv.slice(2);if(!args.includes('--confirm-synthetic-task'))throw Error('Explicit synthetic Windows task approval required');
const home=path.join(os.homedir(),'.aiboot'),op=args[args.indexOf('--operating-repo')+1];if(!op||!fs.existsSync(path.join(op,'CURRENT.md')))throw Error('Operating repo required');
const ps=s=>ex('powershell.exe',['-NoProfile','-NonInteractive','-Command',s],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
const hash=p=>{try{return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}catch{return null;}};
const tasks=()=>ps("Get-ScheduledTask -TaskName 'AIBoot-DualReport-*' | Sort-Object TaskName | ForEach-Object { Export-ScheduledTask -TaskName $_.TaskName }");
const taskStates=()=>JSON.parse(ps("@(Get-ScheduledTask -TaskName 'AIBoot-DualReport-*' | Select-Object TaskName,@{n='State';e={[string]$_.State}}) | ConvertTo-Json -Compress"));
const windows=new WindowsBackend();if(windows.read()!==null)throw Error('Existing extra task must be preserved: stop');
const xml=tasks(),config=JSON.parse(fs.readFileSync(path.join(home,'config.json'))),backup=path.join(home,'backups','stage23-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(backup,{recursive:true});ex('icacls.exe',[backup,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{stdio:'ignore',windowsHide:true});
const protectedFiles=[home+'/config.json',home+'/ledger.json',home+'/assistant/state.json',home+'/assistant.json',home+'/chat-token.json',home+'/holidays.json',path.join(config.googleAuthDir,'dist/.gsheets-server-credentials.json'),path.join(config.googleAuthDir,'dist/gcp-oauth.keys.json'),...(config.chatOAuthKeys?[path.resolve(home,config.chatOAuthKeys)]:[])];
const before=protectedFiles.map(p=>({path:p,hash:hash(p)}));for(const [i,p]of protectedFiles.entries())if(fs.existsSync(p))fs.copyFileSync(p,path.join(backup,'protected-'+i+'.before'));
fs.writeFileSync(backup+'/scheduler.before.xml',xml);
const head=()=>ex('git',['rev-parse','HEAD'],{cwd:op,encoding:'utf8'}).trim();const oldHead=head();
const report={operatingHead:oldHead,backup,startedAt:new Date().toISOString(),beforeTaskStates:taskStates(),acl:{},api:{},windows:{},external:{googleReadCalls:0,modelCalls:0,webhookCalls:0},unverified:['actual reboot','actual sleep','actual logout','real trigger timing','actual model/send','UI integration']};
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-stage23-validation-'));
let control,browser;const write=()=>fs.writeFileSync(backup+'/verification.json',JSON.stringify(report,null,2));
try{
 const af=initializeAccess(path.join(isolated,'workspace-api')),access=JSON.parse(fs.readFileSync(af));report.acl.privateFileAccepted=verifyPrivate(af);report.acl.dispatchDisabled=access.allowDispatch===false;report.acl.writesDisabled=access.allowWrites===false;
 const bad=path.join(isolated,'unprotected.json');fs.writeFileSync(bad,'{}');report.acl.inheritedAccessRejected=!verifyPrivate(bad);
 initializeAccess(path.join(isolated,'extra-reports'));
 const originalApply=windows.apply.bind(windows);windows.apply=p=>{const r=originalApply(p);if(fingerprint(p)!==fingerprint(r))report.windows.applyDifference=p&&r?Object.keys(p).filter(k=>fingerprint(p[k])!==fingerprint(r[k])).map(k=>({key:k,expected:['arguments','executable'].includes(k)?p[k].length:p[k],actual:['arguments','executable'].includes(k)?r[k].length:r[k]})):['null_mismatch'];return r;};
 const store=openStore(isolated),service=new ScheduleService({store,windows,home:isolated,writesEnabled:false,dispatchEnabled:()=>false});
 const reader=new WorkspaceReader({home,buildVersion:oldHead,makeClients:(c,h)=>{
  const io=clients(c,h),raw=io.sheets(),count=(fn)=>async(...a)=>{report.external.googleReadCalls++;return fn(...a);};
  return {sheets:()=>({get:count(raw.get.bind(raw)),values:{get:count(raw.values.get.bind(raw.values)),batchGet:count(raw.values.batchGet.bind(raw.values))}}),chat:{spaces:{messages:{list:count(io.chat.spaces.messages.list.bind(io.chat.spaces.messages))}}}};
 }});
 control=createApi({service,reader,token:access.token});const ca=await control.listen(),code=crypto.randomBytes(32).toString('hex'),origin='http://127.0.0.1:5173';
 browser=createSessionBackend({controlUrl:'http://127.0.0.1:'+ca.port,controlToken:access.token,pairingCode:code,pairingExpiresAt:Date.now()+600000,uiOrigin:origin});const ba=await browser.listen(),base='http://127.0.0.1:'+ba.port;
 let r=await fetch(base+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({code})});if(r.status!==200)throw Error('PAIRING_FAILED');const cookie=r.headers.get('set-cookie').split(';')[0],csrf=(await r.json()).data.csrfToken,headers={origin,cookie,'x-csrf-token':csrf};
 report.api.sessionAuthenticated=true;report.api.unauthenticatedRejected=(await fetch(base+'/api/health')).status===401;
 report.api.csrfRejected=(await fetch(base+'/api/health',{headers:{cookie}})).status===403;
 for(const endpoint of (args.includes('--skip-live-tasks')?['health','reports','connections']:['health','reports','connections','tasks?sources=fixed,contracts,licenses,welfare,recurring,chat'])){
  const started=Date.now();r=await fetch(base+'/api/'+endpoint,{headers});const value=await r.json();report.api[endpoint.split('?')[0]]={http:r.status,status:value.status||null,ms:Date.now()-started,...(value.error?{error:value.error.code}:{}),...(endpoint.startsWith('tasks')?{sources:value.meta?.sources?.map(s=>({id:s.sourceId,status:s.readStatus,error:s.errorCode})),truncated:value.data?.truncated}:{}),...(endpoint==='reports'?{itemCount:value.data?.items?.length,userReceiptAllUnverified:value.data?.items?.every(x=>x.userReceiptVerified===null)}:{})};write();
 }
 console.log(JSON.stringify({phase:'read_api',results:report.api,googleReadCalls:report.external.googleReadCalls}));
 await browser.close();browser=null;
 // Only isolated synthetic state is writable. No control token, config or regular ledger is changed.
 service.writesEnabled=true;let version=0,ids=[];const apiBase='http://127.0.0.1:'+ca.port;
 const call=async(method,suffix,body,key)=>{const r=await fetch(apiBase+'/api/report-schedules'+suffix,{method,headers:{authorization:'Bearer '+access.token,...(body?{'content-type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();return {status:r.status,value};};
 const mutate=async(method,suffix,body)=>{const result=await call(method,suffix,{...body,expectedVersion:version,confirmed:true},crypto.randomUUID());if(![200,201].includes(result.status))throw Error(result.value.error?.code||'MUTATION_FAILED');version=result.value.data.configVersion;return result.value.data;};
 // All test triggers are on Saturday in future weeks; dispatch is additionally blocked by private allowDispatch=false.
 for(let i=0;i<16;i++){const time=String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00'),v=await mutate('POST','',{rule:{weekdays:[6],time}});ids.push(v.schedule.id);report.windows.createdCount=ids.length;console.log(JSON.stringify({phase:'synthetic_created',count:ids.length}));}
 const plan=windows.read();
 if(args.includes('--exercise-disabled-dispatch')){
  const gate=JSON.parse(fs.readFileSync(path.join(isolated,'extra-reports/access.json')));if(gate.allowDispatch!==false||Object.values(store.read().schedules).some(s=>s.firstRunAt<Date.now()+20*60000))throw Error('DISPATCH_PROBE_UNSAFE');
  ps("Start-ScheduledTask -TaskName 'AIBoot-ExtraReports'");let info;for(let i=0;i<30;i++){await new Promise(resolve=>setTimeout(resolve,1000));info=JSON.parse(ps("$t=Get-ScheduledTask -TaskName 'AIBoot-ExtraReports'; $i=Get-ScheduledTaskInfo -TaskName 'AIBoot-ExtraReports'; @{state=[string]$t.State;result=[long]$i.LastTaskResult} | ConvertTo-Json -Compress"));if(info.state==='Ready'&&info.result===0)break;}
  report.windows.limitedDispatcher={...info,storeTouched:Number.isFinite(store.read().lastScanAt),runsCreated:Object.keys(store.read().runs).length,allowDispatch:gate.allowDispatch};if(info?.result!==0||!report.windows.limitedDispatcher.storeTouched||Object.keys(store.read().runs).length)throw Error('DISPATCH_PROBE_FAILED');
 }
 report.windows.registered=true;report.windows.maxTriggers=plan.triggers.length;report.windows.exactPlan=fingerprint(plan)===fingerprint(store.read().native);
 report.windows.interactiveLimited=plan.interactive&&plan.limited;report.windows.noCatchup=plan.startWhenAvailable===false&&plan.wakeToRun===false;report.windows.ignoreNew=plan.multipleInstances==='IgnoreNew';
 report.windows.limitRejected=(await call('POST','',{rule:{weekdays:[7],time:'13:00'},expectedVersion:version,confirmed:true},crypto.randomUUID())).value.error?.code==='SCHEDULE_LIMIT';
 await mutate('PATCH','/'+ids[0],{rule:{weekdays:[6],time:'08:00'}});
 await mutate('POST','/'+ids[0]+'/pause',{});report.windows.pauseRemovedTrigger=windows.read().triggers.length===15;
 await mutate('POST','/'+ids[0]+'/resume',{});report.windows.resumeRestoredTrigger=windows.read().triggers.length===16;
 await mutate('DELETE','/'+ids[0],{});report.windows.deleteRemovedTrigger=windows.read().triggers.length===15;
 const mismatch=store.read();mismatch.native.version++;fs.writeFileSync(store.file,JSON.stringify(mismatch));
 const conflict=await call('POST','/validate',{operation:'create',rule:{weekdays:[6],time:'08:30'},expectedVersion:version});report.windows.mismatchRejected=conflict.value.error?.code==='TRIGGER_MISMATCH';mismatch.native.version--;fs.writeFileSync(store.file,JSON.stringify(mismatch));
 for(const id of ids.slice(1))await mutate('DELETE','/'+id,{});
 report.windows.deleted=windows.read()===null;report.windows.finalConfigMatched=service.list().triggerStatus==='matched';
 console.log(JSON.stringify({phase:'windows',results:report.windows}));write();
}catch(e){report.failure=/^[A-Z_]+$/.test(e.message)?e.message:'VERIFICATION_FAILED';process.exitCode=1;}
finally{
 if(browser)await browser.close();if(control)await control.close();
 try{if(windows.read()!==null)windows.apply(null);report.windows.cleanedUp=windows.read()===null;}catch{report.windows.cleanedUp=false;process.exitCode=1;}
 report.protectedChanged=before.filter(x=>hash(x.path)!==x.hash).length;report.schedulerUnchanged=tasks()===xml;report.operatingHeadUnchanged=head()===oldHead;report.afterTaskStates=taskStates();report.completedAt=new Date().toISOString();write();
 // Exact generated temporary target only; operating backup is preserved.
 const resolved=path.resolve(isolated);if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('aiboot-stage23-validation-'))fs.rmSync(resolved,{recursive:true,force:true});
 console.log(JSON.stringify({phase:'complete',backup,results:report}));
}
