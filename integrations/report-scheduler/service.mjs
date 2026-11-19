import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fail,validateRule,firstRun,conflicts,publicSchedule,MAX_SCHEDULES} from './core.mjs';
import {fingerprint,nativePlan} from './windows.mjs';import {alive} from './store.mjs';import {reconcileRuns} from './engine.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validId=id=>typeof id==='string'&&uuid.test(id);
const copy=x=>structuredClone(x);
function change(state,operation,input,now,id){
 if(!input||Object.keys(input).some(k=>!['rule','id'].includes(k)))fail('INVALID_REQUEST',400);
 let s;
 if(operation==='create'){
  if(Object.values(state.schedules).filter(s=>!s.deleted).length>=MAX_SCHEDULES)fail('SCHEDULE_LIMIT',409);
  s={id,version:1,enabled:true,deleted:false,rule:validateRule(input.rule),createdAt:new Date(now).toISOString()};
 }else{
  if(!validId(input.id)||(s=state.schedules[input.id])===undefined||s.deleted)fail('NOT_FOUND',404);
  s=copy(s);s.version++;
  if(operation==='update')s.rule=validateRule(input.rule);
  else if(operation==='pause')s.enabled=false;
  else if(operation==='resume')s.enabled=true;
  else if(operation==='delete'){s.deleted=true;s.enabled=false;}
  else fail('INVALID_OPERATION',400);
 }
 if(s.enabled){s.firstRunAt=firstRun(s.rule,now);const reasons=conflicts(s,Object.values(state.schedules));if(reasons.length)fail('SCHEDULE_CONFLICT',409,{reasons});}
 if(!s.firstRunAt)s.firstRunAt=now;
 s.updatedAt=new Date(now).toISOString();state.schedules[s.id]=s;state.configVersion++;
 return s;
}
export class ScheduleService{
 constructor({store,windows,home,clock=Date.now,writesEnabled=false,dispatchEnabled=()=>false,id=()=>crypto.randomUUID()}){Object.assign(this,{store,windows,home,clock,writesEnabled,dispatchEnabled,id});}
 assertNative(state){if(state.pending)fail('RECONCILIATION_REQUIRED',503);if(fingerprint(this.windows.read())!==fingerprint(state.native))fail('TRIGGER_MISMATCH',503);}
 list(){const s=this.store.read();reconcileRuns(s,this.clock());let triggerStatus='matched',triggerError=null;try{if(fingerprint(this.windows.read())!==fingerprint(s.native))triggerStatus='mismatch';}catch{triggerStatus='unavailable';triggerError='WINDOWS_TASK_FAILED';}return {configVersion:s.configVersion,timezone:'Asia/Seoul',serverNow:new Date(this.clock()).toISOString(),writeEnabled:this.writesEnabled&&triggerStatus==='matched'&&!s.pending,triggerStatus,triggerError,dispatchEnabled:this.dispatchEnabled(),reconciliationRequired:!!s.pending,items:Object.values(s.schedules).filter(x=>!x.deleted).map(x=>({...publicSchedule(x,this.clock()),lastRun:Object.values(s.runs).filter(r=>r.scheduleId===x.id).sort((a,b)=>b.scheduledAt.localeCompare(a.scheduledAt)).map(publicRun)[0]||null}))};}
 detail(id){const state=this.store.read();reconcileRuns(state,this.clock());const s=state.schedules[id];if(!validId(id)||!s)fail('NOT_FOUND',404);return {...publicSchedule(s,this.clock()),runs:Object.values(state.runs).filter(r=>r.scheduleId===id).sort((a,b)=>b.scheduledAt.localeCompare(a.scheduledAt)).slice(0,100).map(publicRun)};}
 prepare(operation,input,expectedVersion){const old=this.store.read();if(expectedVersion!==old.configVersion)fail('VERSION_CONFLICT');this.assertNative(old);const next=copy(old),s=change(next,operation,input,this.clock(),this.id());return {configVersion:old.configVersion,before:operation==='create'?null:publicSchedule(old.schedules[input.id],this.clock()),after:publicSchedule(s,this.clock()),requiresConfirmation:true};}
 mutate(operation,input,{expectedVersion,idempotencyKey,confirmed}={}){
  if(!this.writesEnabled)fail('WRITES_DISABLED',403);
  if(confirmed!==true)fail('CONFIRMATION_REQUIRED',400);
  if(typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey))fail('INVALID_IDEMPOTENCY_KEY',400);
  return this.store.transaction((state,save)=>{
   const digest=fingerprint({operation,input,expectedVersion}),prior=state.requests[idempotencyKey];
   if(prior){if(prior.digest!==digest)fail('IDEMPOTENCY_CONFLICT');return prior.result;}
   if(expectedVersion!==state.configVersion)fail('VERSION_CONFLICT');
   this.assertNative(state);
   reconcileRuns(state,this.clock());
   // Mutating the task definition while its report is in flight is rejected; no cancellation or snapshot edits.
   if(Object.values(state.runs).some(r=>['reserved','generating','sending'].includes(r.status)))fail('RUN_ACTIVE');
   try{const lease=JSON.parse(fs.readFileSync(path.join(this.home,'report-execution.json'),'utf8'));if(alive(lease.pid)!==false||(lease.childPid&&alive(lease.childPid)!==false))fail('RUN_ACTIVE');}catch(e){if(e.code!=='ENOENT')throw e;}
   if(Object.keys(state.requests).length>=4096)fail('REQUEST_HISTORY_FULL',503);
   const before=copy(state),next=copy(state),s=change(next,operation,input,this.clock(),this.id()),plan=nativePlan(next,this.home);
   state.pending={before:{configVersion:before.configVersion,schedules:before.schedules,native:before.native},desired:plan};save();
   let restoreFailed=false;
   try{
    this.windows.apply(plan);if(fingerprint(this.windows.read())!==fingerprint(plan))fail('TRIGGER_MISMATCH',503);
    // Revalidate against the server clock immediately before final durable save.
    if(s.enabled&&s.firstRunAt<this.clock()+20*60000)fail('LEAD_TIME');
    const result={configVersion:next.configVersion,schedule:publicSchedule(s,this.clock())};
    Object.assign(state,next,{native:plan,pending:null});state.requests[idempotencyKey]={digest,result};save();return result;
   }catch(e){
    try{this.windows.apply(before.native);if(fingerprint(this.windows.read())!==fingerprint(before.native))throw Error();Object.assign(state,before);save();}catch{restoreFailed=true;}
    if(restoreFailed)fail('RECONCILIATION_REQUIRED',503);
    throw e;
   }
  });
 }
 recoverPending(){
  if(!this.writesEnabled)fail('WRITES_DISABLED',403);
  return this.store.transaction((state,save)=>{if(!state.pending)return {recovered:false};const before=state.pending.before;
   this.windows.apply(before.native);if(fingerprint(this.windows.read())!==fingerprint(before.native))fail('RECONCILIATION_REQUIRED',503);
   Object.assign(state,before,{pending:null});save();return {recovered:true,configVersion:state.configVersion};});
 }
}
export function publicRun(r){return {key:r.key,scheduleId:r.scheduleId,scheduledAt:r.scheduledAt,scheduledDate:r.scheduledDate,startedAt:r.startedAt??null,completedAt:r.completedAt??null,webhookAcceptedAt:r.webhookAcceptedAt??null,status:r.status,reason:r.reason??null,receiptEvidencePresent:r.receiptEvidencePresent??false,userReceiptVerified:null};}
