import crypto from 'node:crypto';
const ref=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
export const opaque=(kind,value)=>kind+':'+ref(value);
export function evidenceSource({readStatus='not_checked',records=[],verified=true,queriedAt=null,errorCode=null}={}){
 const ok=readStatus==='ok';
 return {readStatus,recordPresence:ok&&verified?(records.length?'present':'absent'):'unknown',verificationStatus:ok?(verified?'verified':'invalid'):'not_checked',sourceBusinessStatus:!ok?'unavailable':records.length>1?'ambiguous':!verified?'unverified':!records.length?'no_record':records[0].businessStatus==='unknown'?'recorded_unprocessed':records[0].businessStatus,records,errorCode,queriedAt,sourceUpdatedAt:null};
}
export function compareEvidence(comparisonKey,sheet,local,{identityVerified=true}={}){
 const reasons=[],both=[sheet,local],a=sheet.records[0],b=local.records[0];
 if(!identityVerified)reasons.push('IDENTITY_AMBIGUOUS');
 for(const s of both){if(s.readStatus!=='ok')reasons.push(s.readStatus==='partial'?'SOURCE_PARTIAL':s.readStatus==='not_checked'?'SOURCE_NOT_CHECKED':'SOURCE_READ_FAILED');else if(s.verificationStatus!=='verified'||s.records.length>1)reasons.push('EVIDENCE_UNVERIFIED');}
 let businessStatus='confirmation_required';
 if(!reasons.length){
  if(!a&&!b){businessStatus='unknown';reasons.push('NO_MATCHING_RECORD');}
  else if(!a||!b)reasons.push('ONE_SIDED_EVIDENCE');
  else if(a.businessStatus!==b.businessStatus||a.processedDate!==b.processedDate)reasons.push('EVIDENCE_CONFLICT');
  else if(!a.processedDate)reasons.push('EVIDENCE_UNVERIFIED');
  else if(['confirmed_completed','confirmed_deferred'].includes(a.businessStatus))businessStatus=a.businessStatus;
  else reasons.push('COMPLETION_UNCONFIRMED');
 }
 return {comparisonKey,businessStatus,needsConfirmation:!['confirmed_completed','confirmed_deferred'].includes(businessStatus),confirmationReasons:[...new Set(reasons)],evidenceBySource:{sheet_history:sheet,local_confirmed_history:local},evidence:[...sheet.records,...local.records]};
}
