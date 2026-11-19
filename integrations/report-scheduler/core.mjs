/** Pure weekly scheduling rules. No timers, credentials, network or file writes. */
export const TZ='Asia/Seoul', LEAD_MS=20*60000, RUN_MS=20*60000, MAX_SCHEDULES=16;
export class ScheduleError extends Error { constructor(code,status=409,details={}){super(code);this.code=code;this.status=status;this.details=details;} }
export const fail=(code,status=409,details={})=>{throw new ScheduleError(code,status,details);};
export function kst(ms){const d=new Date(ms+9*3600000);return {date:d.toISOString().slice(0,10),day:d.getUTCDay()||7,minute:d.getUTCHours()*60+d.getUTCMinutes()};}
export function validateRule(rule){
 if(!rule||Object.keys(rule).some(k=>!['weekdays','time','effectiveFrom'].includes(k)))fail('INVALID_RULE',400);
 if(!Array.isArray(rule.weekdays)||!rule.weekdays.length||rule.weekdays.length>7||new Set(rule.weekdays).size!==rule.weekdays.length||rule.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7))fail('INVALID_WEEKDAYS',400);
 if(typeof rule.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))fail('INVALID_TIME',400);
 if(rule.effectiveFrom!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveFrom)||!Number.isFinite(Date.parse(rule.effectiveFrom))||new Date(rule.effectiveFrom).toISOString().slice(0,10)!==rule.effectiveFrom))fail('INVALID_DATE',400);
 return {weekdays:[...rule.weekdays].sort((a,b)=>a-b),time:rule.time,...(rule.effectiveFrom?{effectiveFrom:rule.effectiveFrom}:{})};
}
export function nextOccurrence(rule,after){
 const r=validateRule(rule),date=kst(after).date;
 for(let i=0;i<=14;i++){const day=new Date(Date.parse(date+'T00:00:00Z')+i*86400000).toISOString().slice(0,10),at=Date.parse(day+'T'+r.time+':00+09:00');
  if(at>=after&&(!r.effectiveFrom||day>=r.effectiveFrom)&&r.weekdays.includes(kst(at).day))return at;}
 // effectiveFrom can be in the more distant future.
 if(r.effectiveFrom&&r.effectiveFrom>date)return nextOccurrence({...r,effectiveFrom:undefined},Date.parse(r.effectiveFrom+'T00:00:00+09:00'));
 fail('NO_OCCURRENCE',400);
}
const overlap=(a,b)=>a[0]<b[1]&&b[0]<a[1];
const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export function conflicts(schedule,others=[]){
 const result=[];
 for(const day of schedule.rule.weekdays){const start=(day-1)*1440+minute(schedule.rule.time),interval=[start,start+20];
  for(let d=1;d<=5;d++)for(const [a,b]of [[540,675],[930,1065]])for(const shift of [-10080,0,10080])if(overlap(interval,[(d-1)*1440+a+shift,(d-1)*1440+b+shift]))result.push({kind:'regular_protected',weekday:day});
  for(const other of others.filter(s=>!s.deleted&&s.enabled&&s.id!==schedule.id))for(const d of other.rule.weekdays)for(const shift of [-10080,0,10080]){const t=(d-1)*1440+minute(other.rule.time)+shift;if(overlap(interval,[t,t+20]))result.push({kind:'extra_overlap',scheduleId:other.id,weekday:day});}
 }
 return result;
}
export function regularProtected(at,duration=RUN_MS){
 const p=kst(at),week=(p.day-1)*1440+p.minute,fraction=(at%60000)/60000;
 return [0,1,2,3,4].some(d=>[[540,675],[930,1065]].some(([a,b])=>overlap([week+fraction,week+fraction+duration/60000],[d*1440+a,d*1440+b])));
}
export function firstRun(rule,now){const at=nextOccurrence(rule,now+1);if(at<now+LEAD_MS)fail('LEAD_TIME',409,{earliestAllowedAt:new Date(now+LEAD_MS).toISOString()});return at;}
export const occurrenceKey=(id,at)=>'extra|'+id+'|'+new Date(at).toISOString()+'|antigravity';
export function publicSchedule(s,now){return {id:s.id,version:s.version,enabled:s.enabled,deleted:!!s.deleted,timezone:TZ,rule:s.rule,firstRunAt:new Date(s.firstRunAt).toISOString(),nextRunAt:!s.enabled||s.deleted?null:new Date(nextOccurrence(s.rule,Math.max(now+1,s.firstRunAt))).toISOString()};}
