import fs from 'node:fs';
import {clients,credentialPaths} from '../chat-assistant/sources.mjs';
import {createOfficialReader} from '../shared/official-sources.mjs';
import {fail} from '../report-scheduler/core.mjs';
import {opaque} from './evidence.mjs';
export const SERVICES=['sheets','chat'];
const fields=['spreadsheetId','contractsSpreadsheetId','opsSpreadsheetId','recurringSpreadsheetId'];
const roles=['fixed','daily','contracts','licenses','welfare','recurring','history','master'];
const item=(service,state,errorCode=null,action='none',configured=true,checkedAt=null,verifiedAccess=null,scopeStatus='unknown')=>({provider:'google',service,configured,state,checkedAt,verifiedAccess,scopeStatus,accountLabel:null,action,errorCode});
export function validateVerify(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'sources')||!Array.isArray(body.sources)||body.sources.length<1||body.sources.length>2||body.sources.some(s=>!SERVICES.includes(s))||new Set(body.sources).size!==body.sources.length)fail('INVALID_REQUEST',400);
 return body.sources;
}
/** Only structured evidence is classified; exception messages are never parsed or returned. */
export function accountFailure(service,error,at){
 const status=error?.response?.status||error?.status;
 const data=error?.response?.data;
 const array=x=>Array.isArray(x)?x:[];
 const reasons=[...array(data?.error?.errors).map(x=>x?.reason),...array(data?.error?.details).map(x=>x?.reason)];
 if(error?.verificationPhase==='oauth_refresh'&&data?.error==='invalid_grant')return item(service,'reauth_required','AUTH_REQUIRED','local_reauth_required',true,at,false);
 if(status===403&&reasons.some(x=>['ACCESS_TOKEN_SCOPE_INSUFFICIENT','insufficientPermissions'].includes(x)))return item(service,'access_denied','PERMISSION_DENIED','contact_admin',true,at,false,'insufficient');
 if(status===403&&(data?.error?.status==='PERMISSION_DENIED'||reasons.some(x=>['forbidden','insufficientFilePermissions','permissionDenied'].includes(x)))&&!reasons.some(x=>['SERVICE_DISABLED','accessNotConfigured'].includes(x)))return item(service,'access_denied','PERMISSION_DENIED','contact_admin',true,at,false);
 if(status===429||status>=500||['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error?.code))return item(service,'unavailable','NETWORK_ERROR','retry_verify',true,at);
 if(error?.name==='AbortError'||['ETIMEDOUT','ECONNABORTED'].includes(error?.code))return item(service,'unavailable','TIMEOUT','retry_verify',true,at);
 return item(service,'error','CHECK_FAILED','contact_admin',true,at);
}
/** Per-client transport bounds include the SDK's existing refresh POST. No shared SDK/global/file mutation. */
export function boundAuth(client,{signal,remaining,guard}){
 if(client.listenerCount('tokens')!==0||!client.transporter?.request)fail('CHECK_UNAVAILABLE',503);
 const request=client.transporter.request.bind(client.transporter),seen=new Set();
 client.transporter.request=async options=>{
  guard();signal.throwIfAborted();const method=String(options.method||'GET').toUpperCase(),url=new URL(String(options.url));
  const refresh=method==='POST'&&url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token';
  const resource=method==='GET'&&(url.origin==='https://sheets.googleapis.com'&&/^\/v4\/spreadsheets\/[^/]+$/.test(url.pathname)||url.origin==='https://chat.googleapis.com'&&/^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname));
  const grant=new URLSearchParams(typeof options.data==='string'?options.data:'');
  if(url.username||url.password||url.hash||!resource&&!refresh||refresh&&(grant.get('grant_type')!=='refresh_token'||grant.has('scope')))throw Object.assign(new Error('검증 전송 범위 차단'),{code:'CHECK_REQUEST_BLOCKED'});
  const key=method+' '+url.origin+url.pathname;
  // Never replay an external resource or refresh automatically, even if SDK retry defaults change.
  if(seen.has(key))throw Object.assign(new Error('검증 재시도 차단'),{code:'CHECK_RETRY_BLOCKED'});
  seen.add(key);
  try{return await request({...options,signal,timeout:Math.max(1,remaining()),retry:false});}
  catch(error){error.verificationPhase=refresh?'oauth_refresh':'resource';throw error;}
 };
}
function configured(report,home,service){
 if(typeof report.googleAuthDir!=='string'||!report.googleAuthDir)return false;
 if(service==='sheets'&&(fields.some(k=>typeof report[k]!=='string'||!report[k])||roles.some(k=>!Number.isInteger(report.sourceSheetIds?.[k])||report.sourceSheetIds[k]<0)))return false;
 if(service==='chat'&&(!Array.isArray(report.chatSpaces)||report.chatSpaces.length!==2))return false;
 const paths=credentialPaths(report,home,service);
 return paths.every(p=>{try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw Error('인증 자료 검증 필요');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}});
}
export class ConnectionVerifier{
 constructor({reader,enabled=false,makeClients=clients,budgetMs=15000,clock=Date.now}={}){Object.assign(this,{reader,enabled,makeClients,budgetMs,clock});}
 async verify(body,{signal:parent}={}){
  const services=validateVerify(body);
  if(!this.enabled)fail('VERIFICATION_DISABLED',503);
  const check=()=>{try{this.reader.check();}catch(e){if(e.code==='REPORT_PROTECTED')throw e;fail('CHECK_UNAVAILABLE',503);}};
  check();
  if(this.reader.busy)fail('RATE_LIMITED',429);
  this.reader.busy=true;
  const started=this.clock(),requestId=opaque('verify',[started,Math.random()]),abort=new AbortController(),items=[],readiness=new Map(),attempted=new Set();
  const remaining=()=>Math.max(1,this.budgetMs-(this.clock()-started));
  const cancel=()=>abort.abort('CANCELLED');parent?.addEventListener('abort',cancel,{once:true});if(parent?.aborted)cancel();
  const timer=setTimeout(()=>abort.abort('TIMEOUT'),this.budgetMs);
  const monitor=setInterval(()=>{try{check();}catch(e){abort.abort(e.code==='REPORT_PROTECTED'?'REPORT_PROTECTED':'CHECK_UNAVAILABLE');}},100);
  const guard=()=>{check();abort.signal.throwIfAborted();};
  try{
   const report=this.reader.config();if(!report||typeof report!=='object'||Array.isArray(report))fail('CHECK_UNAVAILABLE',503);
   for(const service of services){const at=new Date(this.clock()).toISOString();try{readiness.set(service,configured(report,this.reader.home,service)?null:item(service,'not_configured','NOT_CONFIGURED','contact_admin',false,at));}catch(e){readiness.set(service,accountFailure(service,e,at));}}
   for(const service of services){
    guard();if(readiness.get(service)){items.push(readiness.get(service));continue;}attempted.add(service);
    try{
     const io=this.makeClients(report,this.reader.home,{services:[service],onAuth:auth=>boundAuth(auth,{signal:abort.signal,remaining,guard})});
     const call=async(fn,args)=>{guard();const value=await fn(args,{signal:abort.signal,timeout:remaining(),retry:false});guard();return value;};
     if(service==='sheets'){
      const raw=io.sheets(),api={get:args=>call(raw.get.bind(raw),args)};
      await createOfficialReader(api,report).verifyMetadata();
     }else{
      const spaces=report.chatSpaces.map(s=>s.startsWith('spaces/')?s:'spaces/'+s);
      if(new Set(spaces).size!==2||spaces.some(s=>!/^spaces\/[\w-]+$/.test(s)))throw Error('지정 공간 설정 확인 필요');
      for(const space of spaces){const r=await call(io.chat.spaces.messages.list.bind(io.chat.spaces.messages),{parent:space,pageSize:1,fields:'nextPageToken'});if(!r?.data||typeof r.data!=='object'||Array.isArray(r.data))throw Error('검증 응답 확인 필요');}
     }
     items.push(item(service,'connected',null,'none',true,new Date(this.clock()).toISOString(),true,'sufficient'));
    }catch(error){
     if(abort.signal.aborted)throw error;
     items.push(accountFailure(service,error,new Date(this.clock()).toISOString()));
    }
   }
   guard();
  }catch(error){
   if(abort.signal.aborted){
    if(abort.signal.reason==='REPORT_PROTECTED')fail('REPORT_PROTECTED',409);
    if(abort.signal.reason==='CHECK_UNAVAILABLE')fail('CHECK_UNAVAILABLE',503);
    for(const service of services.filter(s=>!items.some(x=>x.service===s)))items.push(readiness.get(service)||item(service,'unavailable','TIMEOUT','retry_verify',readiness.has(service),attempted.has(service)?new Date(this.clock()).toISOString():null));
   }else{if(error.code==='REPORT_PROTECTED')throw error;fail('CHECK_UNAVAILABLE',503);}
  }finally{clearTimeout(timer);clearInterval(monitor);parent?.removeEventListener('abort',cancel);this.reader.busy=false;}
  return {requestId,apiVersion:'v1',status:items.every(x=>x.state==='connected')?'ok':'partial',data:{items},meta:{requestedAt:new Date(started).toISOString(),completedAt:new Date(this.clock()).toISOString()}};
 }
}
