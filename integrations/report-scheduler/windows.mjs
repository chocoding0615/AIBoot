import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {fail} from './core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export const TASK_NAME='AIBoot-ExtraReports';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const fingerprint=p=>crypto.createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');
export function nativePlan(state,home){
 const enabled=Object.values(state.schedules).filter(s=>s.enabled&&!s.deleted).sort((a,b)=>a.id.localeCompare(b.id));
 if(!enabled.length)return null;
 return {task:TASK_NAME,version:state.configVersion,executable:process.execPath,arguments:'"'+path.join(root,'cli.mjs')+'" dispatch --plan-version '+state.configVersion+' --home "'+home+'"',
  triggers:enabled.map(s=>({days:s.rule.weekdays,time:s.rule.time,startBoundary:new Date(s.firstRunAt).toISOString()})).sort((a,b)=>a.time.localeCompare(b.time)),executionTimeLimit:'PT20M',multipleInstances:'IgnoreNew',enabled:true,wakeToRun:false,startWhenAvailable:false,interactive:true,limited:true};
}
export class WindowsBackend{
 constructor({invoke=execFileSync}={}){this.invoke=invoke;}
 call(mode,plan){
  if(process.platform!=='win32')fail('WINDOWS_REQUIRED',503);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-task-'));
  try{const file=path.join(dir,'plan.json');fs.writeFileSync(file,JSON.stringify(plan??null),{mode:0o600});
   const raw=this.invoke('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'windows-task.ps1'),'-Mode',mode,'-DefinitionFile',file],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']});
   return JSON.parse(raw.replace(/^\uFEFF/,'').trim()||'null');
  }catch{fail('WINDOWS_TASK_FAILED',503);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
 read(){return this.call('Probe');}
 apply(plan){return this.call('Apply',plan);}
}
