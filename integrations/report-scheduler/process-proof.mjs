import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const script=fileURLToPath(new URL('./process-proof.ps1',import.meta.url));
export function processProof(pid){
 if(!Number.isInteger(pid)||pid<1)return {state:'unknown',birth:null,descendants:[]};
 try{
  if(process.platform==='win32'){
   const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Mode','Process','-PidValue',String(pid)],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});
   const p=JSON.parse(raw.replace(/^\uFEFF/,'').trim());
   if(!['alive','dead','unknown'].includes(p.state)||!Array.isArray(p.descendants))throw Error();
   return p;
  }
  const parse=id=>{const text=fs.readFileSync('/proc/'+id+'/stat','utf8'),v=text.slice(text.lastIndexOf(')')+2).split(' ');return {pid:Number(id),parent:Number(v[1]),birth:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+v[19]};};
  let owner=null;try{owner=parse(pid);}catch(e){if(e.code!=='ENOENT')throw e;}
  const all=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).flatMap(id=>{try{return [parse(id)]}catch{return []}}),known=new Set([pid]);let changed;
  do{changed=false;for(const p of all)if(known.has(p.parent)&&!known.has(p.pid)){known.add(p.pid);changed=true;}}while(changed);
  return {state:owner?'alive':'dead',birth:owner?.birth??null,descendants:[...known].filter(x=>x!==pid)};
 }catch{return {state:'unknown',birth:null,descendants:[]};}
}
let self;
export function selfIdentity(){if(!self){const p=processProof(process.pid);self={pid:process.pid,birth:p.state==='alive'?p.birth:null};}return {...self};}
export function identityStatus(record,proof){
 if(proof.state==='unknown')return 'unknown';
 if(proof.state==='dead')return proof.descendants.length?'child_alive':'dead';
 if(!record.birth||!proof.birth)return 'unknown';
 return record.birth===proof.birth?'alive':'pid_reused';
}
export function maintenanceProof(){
 if(process.platform!=='win32')return {verified:false,tasksDisabled:false};
 try{return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Mode','Maintenance'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim());}
 catch{return {verified:false,tasksDisabled:false};}
}
