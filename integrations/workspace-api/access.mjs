import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fail} from '../report-scheduler/core.mjs';
export function verifyPrivate(file){
 if(process.platform!=='win32')return false;
 try{if(fs.lstatSync(path.dirname(file)).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).nlink!==1)return false;
 const script="$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $items=@($env:AIBOOT_PRIVATE_CHECK,(Split-Path -LiteralPath $env:AIBOOT_PRIVATE_CHECK -Parent)); $valid=$true; foreach($item in $items){$acl=Get-Acl -LiteralPath $item; $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value; $bad=@($acl.Access | Where-Object {$s=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; $_.AccessControlType -eq 'Allow' -and $s -ne $sid.Value -and $s -ne 'S-1-5-18'}); $valid=$valid -and ($owner -eq $sid.Value -and $bad.Count -eq 0)}; $valid | ConvertTo-Json -Compress";
 return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,AIBOOT_PRIVATE_CHECK:path.resolve(file)},stdio:['ignore','pipe','pipe']}).trim())===true;
 }catch{return false;}
}
export function initializeAccess(directory){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED',503);
 if(fs.existsSync(directory))fail('ACCESS_ALREADY_EXISTS',409);
 fs.mkdirSync(directory,{recursive:true});
 execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{windowsHide:true,stdio:'ignore'});
 const file=path.join(directory,'access.json');fs.writeFileSync(file,JSON.stringify({version:1,token:crypto.randomBytes(32).toString('hex'),allowWrites:false,allowDispatch:false}),{flag:'wx'});
 if(!verifyPrivate(file))fail('ACCESS_ACL_UNVERIFIED',403);return file;
}
