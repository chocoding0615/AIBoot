#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {execFileSync,spawn} from 'node:child_process';
import {openStore,atomic} from './store.mjs';import {ScheduleService} from './service.mjs';import {WindowsBackend,fingerprint} from './windows.mjs';import {createApi} from './api.mjs';import {dispatch,transitionScheduled} from './engine.mjs';import {fail} from './core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),mode=args[0],arg=name=>args[args.indexOf(name)+1],home=args.includes('--home')?path.resolve(arg('--home')):path.join(os.homedir(),'.aiboot');
function secureAccess(file){
 if(process.platform!=='win32')return false;
 try{
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'windows-task.ps1'),'-Mode','AccessCheck','-DefinitionFile',file],{encoding:'utf8',windowsHide:true,timeout:10000}).trim()) === true;
 }catch{return false;}
}
async function main(){
 const accessFile=path.join(home,'extra-reports','access.json');
 if(mode==='init-access'){
  if(process.platform!=='win32')fail('WINDOWS_REQUIRED',503);
  if(fs.existsSync(accessFile))fail('ACCESS_ALREADY_EXISTS');
  fs.mkdirSync(path.dirname(accessFile),{recursive:true});
  execFileSync('icacls.exe',[path.dirname(accessFile),'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{windowsHide:true,stdio:'ignore'});
  fs.writeFileSync(accessFile,JSON.stringify({version:1,allowDispatch:false,token:crypto.randomBytes(32).toString('hex')}),{flag:'wx'});
  if(!secureAccess(accessFile))fail('ACCESS_ACL_UNVERIFIED',403);
  console.log(JSON.stringify({created:true,path:accessFile}));return;
 }
 const store=openStore(home),windows=new WindowsBackend();
 if(mode==='status'){const s=store.read();console.log(JSON.stringify({configVersion:s.configVersion,scheduleCount:Object.keys(s.schedules).length,reconciliationRequired:!!s.pending,writeEnabled:false}));return;}
 if(mode==='dispatch'){
  if(!secureAccess(accessFile))fail('ACCESS_ACL_UNVERIFIED',403);
  const access=JSON.parse(fs.readFileSync(accessFile,'utf8'));
  const version=Number(arg('--plan-version'));if(!Number.isSafeInteger(version))fail('INVALID_VERSION',400);
  const result=await dispatch({store,windows,version,launch:key=>access.allowDispatch!==true ? Promise.resolve(transitionScheduled(home,key,{status:'held',reason:'DISPATCH_DISABLED',completedAt:new Date().toISOString()})) : new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(root,'../local-dual-report/runner.mjs'),'--scheduled-run',key],{windowsHide:true,stdio:'ignore'});
   child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('WORKER_EXITED')));
  })});console.log(JSON.stringify(result));return;
 }
 if(mode==='activate-dispatch'||mode==='deactivate-dispatch'){
  if(!args.includes('--confirm-dispatch')||!secureAccess(accessFile))fail('ACTIVATION_CONFIRMATION_REQUIRED',403);
  const state=store.read();if(state.pending||fingerprint(windows.read())!==fingerprint(state.native))fail('TRIGGER_MISMATCH',503);
  const access=JSON.parse(fs.readFileSync(accessFile,'utf8'));access.allowDispatch=mode==='activate-dispatch';atomic(accessFile,access);console.log(JSON.stringify({dispatchEnabled:access.allowDispatch}));return;
 }
 if(mode==='serve'||mode==='recover'){
  const access=JSON.parse(fs.readFileSync(accessFile,'utf8')),verified=secureAccess(accessFile);
  if(!verified)fail('ACCESS_ACL_UNVERIFIED',403);
  const service=new ScheduleService({store,windows,home,writesEnabled:verified&&args.includes('--enable-writes'),dispatchEnabled:()=>JSON.parse(fs.readFileSync(accessFile,'utf8')).allowDispatch===true});
  if(mode==='recover'){console.log(JSON.stringify(service.recoverPending()));return;}
  const port=args.includes('--port')?Number(arg('--port')):17841;if(!Number.isInteger(port)||port<1024||port>65535)fail('INVALID_PORT',400);
  const api=createApi({service,token:access.token,port});await api.listen();console.log(JSON.stringify({listening:'127.0.0.1',port,writeEnabled:service.writesEnabled}));
  process.on('SIGINT',()=>api.close());return;
 }
 fail('COMMAND_REQUIRED',400);
}
main().catch(e=>{console.error(JSON.stringify({error:e.code||'LOCAL_SETUP_REQUIRED'}));process.exitCode=1;});
