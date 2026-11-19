/** Explicit, offline guard recovery. Never deletes a lock by age or resets delivery ledgers. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fail} from './core.mjs';import {processProof,identityStatus,selfIdentity,maintenanceProof} from './process-proof.mjs';
function location(home,scope){if(scope==='execution')return path.join(home,'report-execution.guard');if(scope==='schedule')return path.join(home,'extra-reports','mutation.guard');fail('INVALID_RECOVERY_SCOPE',400);}
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
function ownerAt(dir){
 try {
 if(!fs.existsSync(dir))return null;
 const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())fail('RECOVERY_LAYOUT_INVALID',503);
 const file=path.join(dir,'owner.json');if(fs.lstatSync(file).isSymbolicLink())fail('RECOVERY_LAYOUT_INVALID',503);
 const raw=fs.readFileSync(file,'utf8'),owner=JSON.parse(raw);
 if(!Number.isInteger(owner.pid)||owner.pid<1||owner.phase!=='commit')fail('GUARD_REVIEW_REQUIRED',503);
 return {owner,fingerprint:digest(raw)};
 } catch(e){if(e.status)throw e;fail('GUARD_REVIEW_REQUIRED',503);}
}
function leaseAt(home){
 try {
 const file=path.join(home,'report-execution.json');if(!fs.existsSync(file))return null;
 const l=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!Number.isInteger(l.pid)||l.pid<1||!['reading','generating','sending'].includes(l.phase))fail('LEASE_REVIEW_REQUIRED',503);
 return l;
 } catch(e){if(e.status)throw e;fail('LEASE_REVIEW_REQUIRED',503);}
}
function evidence(record,probe){if(!record)return null;const parent=probe(record.pid),status=identityStatus(record,parent);
 const children=(record.children|| (record.childPid?[{pid:record.childPid,birth:record.childBirth}]:[])).map(c=>({pid:c.pid,status:identityStatus(c,probe(c.pid))}));
 const child=children[0]?.status||null,unregisteredChildren=record.unregisteredChildren||0;
 return {pid:record.pid,birth:record.birth??null,phase:record.phase,parentStatus:status,descendants:parent.descendants,childStatus:child,children,unregisteredChildren,safeDead:status==='dead'&&unregisteredChildren===0&&children.every(c=>c.status==='dead')};}
export function inspectGuards(home,{probe=processProof}={}){
 return {scopes:['execution','schedule'].map(scope=>{
  const dir=location(home,scope);try{const o=ownerAt(dir);return {scope,guardPresent:!!o,recoveryInProgress:fs.existsSync(dir+'.recovery'),fingerprint:o?.fingerprint??null,owner:o?evidence(o.owner,probe):null};}
  catch(e){return {scope,guardPresent:true,blocked:true,error:e.code||'GUARD_REVIEW_REQUIRED'};}
 }),lease:(()=>{try{return evidence(leaseAt(home),probe);}catch(e){return {blocked:true,error:e.code||'LEASE_REVIEW_REQUIRED'};}})()};
}
export function recoverGuard(home,{scope,expectedFingerprint,confirmed=false,maintenance=maintenanceProof,probe=processProof}={}){
 if(!confirmed)fail('RECOVERY_CONFIRMATION_REQUIRED',403);
 const m=maintenance();if(m.verified!==true||m.tasksDisabled!==true)fail('MAINTENANCE_REQUIRED',409);
 const dir=location(home,scope);if(!fs.existsSync(dir))return {recovered:false,scope};
 if(typeof expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(expectedFingerprint))fail('RECOVERY_FINGERPRINT_REQUIRED',400);
 const marker=dir+'.recovery',identity={...selfIdentity(),token:crypto.randomUUID(),phase:'commit'};
 try{fs.mkdirSync(marker,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('RECOVERY_IN_PROGRESS');throw e;}
 try{
  fs.writeFileSync(path.join(marker,'owner.json'),JSON.stringify(identity),{mode:0o600});
  const observed=ownerAt(dir);if(observed.fingerprint!==expectedFingerprint)fail('RECOVERY_SNAPSHOT_CHANGED');
  if(!evidence(observed.owner,probe).safeDead)fail('OWNER_OR_CHILD_UNVERIFIED');
  const lease=leaseAt(home);if(lease&&!evidence(lease,probe).safeDead)fail('OWNER_OR_CHILD_UNVERIFIED');
  // Recheck fresh evidence while all protocol participants observe the recovery marker.
  const latest=ownerAt(dir);if(latest.fingerprint!==expectedFingerprint)fail('RECOVERY_SNAPSHOT_CHANGED');
  if(!evidence(latest.owner,probe).safeDead||(lease&&!evidence(leaseAt(home),probe).safeDead))fail('OWNER_OR_CHILD_UNVERIFIED');
  const archive=dir+'.recovered-'+crypto.randomUUID();fs.renameSync(dir,archive);
  return {recovered:true,scope,archive,deliveryDisposition:lease?.phase==='sending'?'unknown_preserved':'unchanged',leaseUnchanged:true,legacyLedgerUnchanged:true};
 }finally{
  try{const owner=JSON.parse(fs.readFileSync(path.join(marker,'owner.json'),'utf8'));if(owner.token===identity.token)fs.rmSync(marker,{recursive:true,force:true});}catch{}
 }
}
