/**
 * AIBoot Google Chat adapter (Apps Script)
 *
 * Read-only source: [MS] AD_관리비 내역 / JP매월 지출
 * Write target: an isolated append-only AIBoot_데일리마감 tab.
 * Incoming webhook: delivery ONLY; a Google Chat App receives replies.
 *
 * Before deployment set Script Properties:
 * SOURCE_SPREADSHEET_ID, OWNER_EMAIL, CHAT_WEBHOOK_URL (keep SECRET).
 * Run initializeDailyLog() manually once from the company account.
 * Do not enable reporting triggers until the two-way test passes.
 */
const CFG = Object.freeze({
  sourceSheet: 'JP매월 지출',
  logSheet: 'AIBoot_데일리마감',
  timeZone: 'Asia/Seoul',
  columns: ['기록시각', '기록일', '업체', '사용회차', '상태', '다음확인일', '메모', '기록자', '원문'],
  discontinued: '이지화물'
});
const ERROR_HELP = [
  '명령 형식:',
  '완료|업체명|YYYY-MM 또는 YYYY-MM~YYYY-MM|확인 근거',
  '대기|업체명|사용회차|YYYY-MM-DD|업체 발송 대기 등 메모',
  '조회|YYYY-MM (예: 조회|2026-11)',
  '도움말',
  '※ 단순히 "처리했어"라고 쓰면 업체·회차를 추정하여 저장하지 않습니다.'
].join('\n');

function requiredProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('필수 Script Property 누락: ' + key);
  return v;
}
function source_() { return SpreadsheetApp.openById(requiredProp_('SOURCE_SPREADSHEET_ID')); }
function emailAllowed_(event) {
  const owner = requiredProp_('OWNER_EMAIL').trim().toLowerCase();
  // On some configurations the sender email is hidden. Reject rather than guess.
  const email = String(event && event.user && event.user.email || '').trim().toLowerCase();
  return email && email === owner;
}
function isValidPeriod_(period) {
  return /^20\d{2}-(0[1-9]|1[0-2])(?:~20\d{2}-(0[1-9]|1[0-2]))?$/.test(period);
}
function isValidDate_(v) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(v)) return false;
  const [y,m,d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()+1===m && dt.getUTCDate()===d;
}
function canonicalVendors_() {
  const rows = source_().getSheetByName(CFG.sourceSheet).getRange('D14:D36').getDisplayValues();
  return rows.map(x=>x[0].trim()).filter(Boolean).filter(x=>x !== CFG.discontinued);
}
function resolveVendor_(input) {
  return canonicalVendors_().find(v=>v.toLowerCase()===input.toLowerCase()) || null;
}
function log_() {
  const sheet = source_().getSheetByName(CFG.logSheet);
  if (!sheet) throw new Error('작업 기록 탭이 없습니다. initializeDailyLog() 먼저 실행하세요.');
  const headers = sheet.getRange(1,1,1,CFG.columns.length).getDisplayValues()[0];
  if (headers.join('|') !== CFG.columns.join('|')) throw new Error('작업 기록 탭 헤더가 달라 저장을 중지합니다.');
  return sheet;
}
function initializeDailyLog() {
  // Intentional manual step: never create/overwrite a tab during message handling.
  const ss = source_();
  if (ss.getSheetByName(CFG.logSheet)) return '이미 존재합니다. 수정하지 않았습니다.';
  const sh = ss.insertSheet(CFG.logSheet);
  sh.getRange(1,1,1,CFG.columns.length).setValues([CFG.columns]);
  sh.setFrozenRows(1);
  sh.getRange(1,1,1,CFG.columns.length).setFontWeight('bold').setBackground('#EAF1F8');
  sh.setColumnWidths(1,2,140);
  sh.setColumnWidths(3,5,160);
  sh.setColumnWidth(7,360);
  sh.setColumnWidth(9,360);
  // Hidden from ordinary sheet navigation; owner can unhide for audit.
  sh.hideSheet();
  return '데일리 마감 저장소 생성 완료 (숨김 탭)';
}
function latest_() {
  const sh=log_(),last=sh.getLastRow();
  if(last<2) return new Map();
  const vals=sh.getRange(2,1,last-1,CFG.columns.length).getValues();
  const map=new Map();
  for(const row of vals) {
    const vendor=String(row[2]),period=String(row[3]);
    if(vendor && period) map.set(vendor+'|'+period,{status:String(row[4]),next:String(row[5]),memo:String(row[6]),recorded:row[0]});
  }
  return map;
}
function appendClose_(type, parts, actor) {
  const vendor=resolveVendor_(parts[1]||'');
  const period=String(parts[2]||'').trim();
  if(!vendor) return '업체명을 원본 시트의 항목명과 동일하게 입력하세요.\n'+ERROR_HELP;
  if(!isValidPeriod_(period)) return '사용회차 형식이 잘못됐습니다.\n'+ERROR_HELP;
  const isDone=type==='완료';
  const next=isDone?'':String(parts[3]||'').trim();
  const memo=isDone?parts.slice(3).join('|').trim():parts.slice(4).join('|').trim();
  if(!isDone && !isValidDate_(next)) return '다음 확인일을 YYYY-MM-DD로 입력하세요.';
  if(!memo) return '업무 근거 또는 업체 대기 사유를 반드시 입력하세요.';
  const lk=LockService.getScriptLock();
  lk.waitLock(10000);
  try {
    const now=new Date(),local=Utilities.formatDate(now,CFG.timeZone,'yyyy-MM-dd');
    log_().appendRow([now,local,vendor,period,isDone?'완료':'업체 대기',next,memo,actor,[type,...parts.slice(1)].join('|')]);
  } finally { lk.releaseLock(); }
  return vendor+' / '+period+' : '+(isDone?'완료':'업체 대기')+' 기록했습니다.\n기존 회차가 아니라 정확히 이 사용회차에만 적용합니다.';
}
function statusMessage_(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return '조회 월을 YYYY-MM로 입력하세요.';
  const entries=latest_();
  const selected=[...entries.entries()].filter(([key])=>key.split('|')[1].includes(month));
  const done=selected.filter(([,v])=>v.status==='완료');
  const waiting=selected.filter(([,v])=>v.status==='업체 대기');
  return [
    '[AIBoot 데일리 마감 기록] '+month,
    '완료 기록 '+done.length+'건 / 업체 자료 대기 '+waiting.length+'건',
    ...selected.slice(0,20).map(([key,v])=>'• '+key.replace('|',' · ')+' — '+(v.status==='완료'?'완료':'처리할 일 (업체 자료 대기)')+(v.next?' / 다음 확인 '+v.next:'')),
    '※ 기록된 회차만 표시. 미기록 항목을 미납으로 단정하지 않습니다.'
  ].join('\n');
}
function onMessage(e) {
  try {
    if(!emailAllowed_(e)) return {text:'이 앱은 지정된 회사 계정만 사용할 수 있습니다. 사용자 이메일이 전달되지 않는 경우에도 접근을 차단합니다.'};
    const raw=String(e.message && e.message.text || '').trim().replace(/^@[^\s]+\s*/,'');
    if (!raw || raw==='도움말') return {text:ERROR_HELP};
    const parts=raw.split('|').map(x=>x.trim());
    const action=parts[0];
    if(action==='조회') return {text:statusMessage_(parts[1]||Utilities.formatDate(new Date(),CFG.timeZone,'yyyy-MM'))};
    if(action==='완료' || action==='대기') return {text:appendClose_(action,parts,e.user.email)};
    return {text:ERROR_HELP};
  } catch(err) {
    console.error('AIBoot Chat handler failed: '+err.message);
    return {text:'처리하지 못했습니다. 설정/기록 저장소를 확인하세요. 원본 시트는 변경하지 않았습니다.'};
  }
}
function onAddToSpace(e) {
  return {text:emailAllowed_(e)?'AIBoot 연결됨. "도움말"을 입력하세요.':'AIBoot은 지정 계정 전용입니다.'};
}
/** Existing webhook: outbound only. Never print the URL or store it in GitHub. */
function sendWebhook_(text) {
  const url=requiredProp_('CHAT_WEBHOOK_URL');
  const result=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json; charset=utf-8',payload:JSON.stringify({text}),muteHttpExceptions:true});
  if(result.getResponseCode()<200||result.getResponseCode()>=300) throw new Error('Google Chat webhook response '+result.getResponseCode());
}
function previewMorningReport() {
  const now=Utilities.formatDate(new Date(),CFG.timeZone,'yyyy-MM-dd');
  return '[AIBoot 오전 보고 초안] '+now+'\n'+statusMessage_(now.slice(0,7))+'\n※ 원본의 연노랑은 지출결의 제출 표시이지 납부 완료가 아닙니다.';
}
function previewAfternoonReport() {
  const now=Utilities.formatDate(new Date(),CFG.timeZone,'yyyy-MM-dd');
  const sh=log_(),last=sh.getLastRow();
  const today=last<2?[]:sh.getRange(2,1,last-1,CFG.columns.length).getValues().filter(r=>String(r[1])===now);
  return '[AIBoot 오후 마감 초안] '+now+'\n당일 상태 변경 '+today.length+'건'+(today.length?'\n'+today.slice(-20).map(r=>'• '+r[2]+' / '+r[3]+' — '+r[4]).join('\n'):'')+'\n※ 단순 미기록은 미납 확정이 아닙니다.';
}
/**
 * Do not install triggers until the user checks the draft and authorizes
 * activation. Apps Script nearMinute() is NOT exact to the minute.
 */
function sendMorningReport() { sendWebhook_(previewMorningReport()); }
function sendAfternoonReport() { sendWebhook_(previewAfternoonReport()); }
