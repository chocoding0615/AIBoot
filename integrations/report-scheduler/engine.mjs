import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {openStore,alive} from './store.mjs';import {fail,kst,nextOccurrence,occurrenceKey,regularProtected,conflicts} from './core.mjs';import {fingerprint,WindowsBackend,nativePlan} from './windows.mjs';
const terminal=new Set(['sent','unknown','failed_not_sent','held','missed','skipped_nonworkday']);
export function transitionScheduled(home,key,patch){
 return openStore(home).transaction((s,save)=>{const r=s.runs[key];if(!r)fail('RUN_NOT_FOUND',404);
  if(terminal.has(r.status))fail('RUN_TERMINAL');
  if(r.pid&&r.pid!==process.pid)fail('RUN_OWNER_MISMATCH');
  if(patch.status==='sent'&&r.status!=='sending')fail('INVALID_RUN_TRANSITION');
  if(r.status==='sending'&&patch.status==='failed_not_sent'&&patch.confirmedNoDelivery!==true)fail('DELIVERY_UNCERTAIN');
  const safe={...patch};delete safe.confirmedNoDelivery;Object.assign(r,safe);save();return r;});
}
export function beginScheduled(home,key,now=undefined,nativeRead=()=>new WindowsBackend().read(),dispatchAllowed=()=>{try{return JSON.parse(fs.readFileSync(path.join(home,'extra-reports','access.json'),'utf8')).allowDispatch===true;}catch{return false;}}){
 if(!dispatchAllowed())fail('DISPATCH_DISABLED',403);
 return openStore(home).transaction((s,save)=>{if(s.pending)fail('RECONCILIATION_REQUIRED',503);if(fingerprint(nativePlan(s,home))!==fingerprint(s.native)||fingerprint(nativeRead())!==fingerprint(s.native))fail('TRIGGER_MISMATCH',503);const r=s.runs[key];if(!r||r.status!=='reserved')fail('RUN_NOT_RESERVED');
  now=now??Date.now();
  const at=Date.parse(r.scheduledAt);if(!Number.isFinite(at)||now<at||now>=at+60000){Object.assign(r,{status:'missed',reason:'OCCURRENCE_EXPIRED',completedAt:new Date(now).toISOString()});save();fail('OCCURRENCE_EXPIRED');}
  const reasons=conflicts(r.configSnapshot,Object.values(s.schedules));
  if(reasons.length){Object.assign(r,{status:'held',reason:'SCHEDULE_CONFLICT',completedAt:new Date(now).toISOString()});save();return null;}
  if(regularProtected(now)){Object.assign(r,{status:'held',reason:'REGULAR_PRIORITY',completedAt:new Date(now).toISOString()});save();return null;}
  Object.assign(r,{pid:process.pid,status:'generating',startedAt:new Date(now).toISOString(),actualDate:kst(now).date});save();return structuredClone(r);});
}
/** One-shot Windows-triggered dispatcher, never an in-process timer or catch-up sender. */
export async function dispatch({store,windows,version,clock=Date.now,launch,isAlive=alive}){
 const keys=store.transaction((s,save)=>{
  if(s.pending)fail('RECONCILIATION_REQUIRED',503);
  if(s.configVersion!==version||fingerprint(nativePlan(s,store.home))!==fingerprint(s.native)||fingerprint(windows.read())!==fingerprint(s.native))fail('TRIGGER_MISMATCH',503);
  const now=clock(),minute=Math.floor(now/60000)*60000;
  reconcileRuns(s,now,isAlive);
  if(Object.keys(s.runs).length>=10000)fail('RUN_HISTORY_FULL',503);
  const keys=[];
  for(const schedule of Object.values(s.schedules).filter(x=>x.enabled&&!x.deleted)){
   // At most one week of metadata-only missed markers; never launch historic occurrences.
   let at=nextOccurrence(schedule.rule,Math.max(schedule.firstRunAt,s.lastScanAt??now-7*86400000));
   for(let n=0;n<9&&at<=minute;n++,at=nextOccurrence(schedule.rule,at+1)){
    const key=occurrenceKey(schedule.id,at);if(s.runs[key])continue;
    const due=at===minute;
    const r={key,scheduleId:schedule.id,scheduledAt:new Date(at).toISOString(),scheduledDate:kst(at).date,scheduleVersion:schedule.version,configSnapshot:structuredClone(schedule),status:due?'reserved':'missed',reason:due?null:'PC_UNAVAILABLE_OR_TRIGGER_MISSED',dispatcherPid:process.pid,createdAt:new Date(now).toISOString()};
    if(due&&regularProtected(now)){r.status='held';r.reason='REGULAR_PRIORITY';}
    s.runs[key]=r;if(r.status==='reserved')keys.push(key);
   }
  }
  if(Object.keys(s.runs).length>10000)fail('RUN_HISTORY_FULL',503);
  s.lastScanAt=minute;save();return keys;
 });
 for(const key of keys){
  try{await launch(key);}
  catch{
   store.transaction((s,save)=>{const r=s.runs[key];if(r&&!terminal.has(r.status)){r.status=r.status==='sending'?'unknown':'failed_not_sent';r.reason='WORKER_EXITED';r.completedAt=new Date(clock()).toISOString();save();}});
  }
 }
 return {selected:keys.length};
}
export const artifactId=key=>crypto.createHash('sha256').update(key).digest('hex');

export function failScheduled(home,key,reason){return openStore(home).transaction((s,save)=>{const r=s.runs[key];if(!r||terminal.has(r.status))return;r.status=r.status==='sending'?'unknown':'failed_not_sent';r.reason=reason;r.completedAt=new Date().toISOString();save();});}

export function reconcileRuns(state,now,isAlive=alive){for(const r of Object.values(state.runs)){if(['reserved','generating','sending'].includes(r.status)&&isAlive(r.pid||r.dispatcherPid)===false){r.status=r.status==='sending'?'unknown':'failed_not_sent';r.reason='OWNER_EXITED';r.completedAt=new Date(now).toISOString();}}}
