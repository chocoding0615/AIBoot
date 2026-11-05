/**
 * AIBoot Google Chat adapter (Apps Script)
 *
 * Read-only source: [MS] AD_관리비 내역 / JP매월 지출 (vendor names D14:D36 only).
 * Write target: the isolated append-only hidden tab AIBoot_데일리마감.
 * Incoming webhook: report delivery ONLY; the Google Chat App receives replies.
 *
 * Script Properties (never commit values):
 *   SOURCE_SPREADSHEET_ID, OWNER_EMAIL, CHAT_WEBHOOK_URL (SECRET)
 *   optional HOLIDAYS_EXTRA / WORKDAYS_EXTRA: comma separated YYYY-MM-DD
 * Internal properties written by this script: REPORT_STATE, VACATIONS, HOLIDAY_CACHE.
 *
 * Role (2026-11-05 user decision): two-way Chat record app ONLY. Regular 09:30/16:00 reports
 * are sent by integrations/local-dual-report; installReportTrigger() is locked behind REPORTS_ENABLED.
 */
const CFG = Object.freeze({
  sourceSheet: 'JP매월 지출',
  vendorRange: 'D14:D36',
  logSheet: 'AIBoot_데일리마감',
  timeZone: 'Asia/Seoul',
  columns: ['기록시각', '기록일', '업체', '사용회차', '상태', '다음확인일', '메모', '기록자', '원문'],
  discontinued: '이지화물',
  // Scheduled tick runs every 10 minutes; a report is sent once inside its window.
  tickMinutes: 10,
  windows: {
    morning: { start: '09:30', end: '11:00', label: '오전 브리핑' },
    afternoon: { start: '16:00', end: '17:30', label: '오후 요약' }
  },
  holidayIcs: 'https://calendar.google.com/calendar/ical/ko.south_korea.official%23holiday%40group.v.calendar.google.com/public/basic.ics',
  holidayRefreshDays: 7,
  stateKeepDays: 21
});
const ERROR_HELP = [
  '명령 형식:',
  '완료|업체명|YYYY-MM 또는 YYYY-MM~YYYY-MM|확인 근거',
  '대기|업체명|사용회차|YYYY-MM-DD|업체 발송 대기 등 메모',
  '조회|YYYY-MM (예: 조회|2026-11)',
  '휴가|YYYY-MM-DD 또는 YYYY-MM-DD~YYYY-MM-DD (종일휴가만, 반차는 보고 유지)',
  '휴가취소|YYYY-MM-DD 또는 기간 · 휴가목록 · 상태 · 도움말',
  '※ 단순히 "처리했어"라고 쓰면 업체·회차를 추정하여 저장하지 않습니다.'
].join('\n');

/* ---------- common ---------- */
function props_() { return PropertiesService.getScriptProperties(); }
function requiredProp_(key) {
  const v = props_().getProperty(key);
  if (!v) throw new Error('필수 Script Property 누락: ' + key);
  return v;
}
function fmt_(d, pattern) { return Utilities.formatDate(d, CFG.timeZone, pattern); }
function today_() { return fmt_(new Date(), 'yyyy-MM-dd'); }
function source_() { return SpreadsheetApp.openById(requiredProp_('SOURCE_SPREADSHEET_ID')); }
function emailAllowed_(event) {
  const owner = requiredProp_('OWNER_EMAIL').trim().toLowerCase();
  // On some configurations the sender email is hidden. Reject rather than guess.
  const email = String(event && event.user && event.user.email || '').trim().toLowerCase();
  return !!email && email === owner;
}
function isValidPeriod_(period) {
  const m = /^(20\d{2}-(?:0[1-9]|1[0-2]))(?:~(20\d{2}-(?:0[1-9]|1[0-2])))?$/.exec(period);
  return !!m && (!m[2] || m[1] <= m[2]);
}
function isValidDate_(v) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}
function addDays_(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function dateRange_(spec) {
  const [a, b] = String(spec || '').split('~').map(x => x.trim());
  if (!isValidDate_(a) || (b && !isValidDate_(b)) || (b && b < a)) return null;
  const out = [];
  for (let d = a; d <= (b || a) && out.length <= 31; d = addDays_(d, 1)) out.push(d);
  return out.length > 31 ? null : out;
}
/** Sheets parses '2026-09' or '=…' typed values; a leading apostrophe stores literal text. */
function asText_(v) { return "'" + String(v == null ? '' : v); }
function cellText_(v, pattern) {
  return v instanceof Date ? fmt_(v, pattern) : String(v == null ? '' : v);
}
function normVendor_(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

/* ---------- source / log ---------- */
function canonicalVendors_() {
  const rows = source_().getSheetByName(CFG.sourceSheet).getRange(CFG.vendorRange).getDisplayValues();
  return rows.map(x => x[0].trim()).filter(Boolean).filter(x => x !== CFG.discontinued);
}
function resolveVendor_(input) {
  const key = normVendor_(input);
  return key ? canonicalVendors_().find(v => normVendor_(v) === key) || null : null;
}
function log_() {
  const sheet = source_().getSheetByName(CFG.logSheet);
  if (!sheet) throw new Error('작업 기록 탭이 없습니다. initializeDailyLog() 먼저 실행하세요.');
  const headers = sheet.getRange(1, 1, 1, CFG.columns.length).getDisplayValues()[0];
  if (headers.join('|') !== CFG.columns.join('|')) throw new Error('작업 기록 탭 헤더가 달라 저장을 중지합니다.');
  return sheet;
}
function initializeDailyLog() {
  // Intentional manual step: never create/overwrite a tab during message handling.
  const ss = source_();
  if (ss.getSheetByName(CFG.logSheet)) return '이미 존재합니다. 수정하지 않았습니다.';
  const sh = ss.insertSheet(CFG.logSheet);
  sh.getRange(1, 1, 1, CFG.columns.length).setValues([CFG.columns]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, CFG.columns.length).setFontWeight('bold').setBackground('#EAF1F8');
  sh.hideSheet();
  return '데일리 마감 저장소 생성 완료 (숨김 탭)';
}
/** All log rows as plain objects; dates normalized so Sheets auto-conversion cannot break filters. */
function rows_() {
  const sh = log_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, CFG.columns.length).getValues().map(r => ({
    at: r[0] instanceof Date ? r[0] : new Date(r[0]),
    day: cellText_(r[1], 'yyyy-MM-dd'),
    vendor: String(r[2]),
    period: cellText_(r[3], 'yyyy-MM'),
    status: String(r[4]),
    next: cellText_(r[5], 'yyyy-MM-dd'),
    memo: String(r[6])
  })).filter(x => x.vendor && x.period);
}
function latest_(rows) {
  const map = new Map();
  for (const r of rows || rows_()) map.set(r.vendor + '|' + r.period, r);
  return map;
}
function appendClose_(type, parts, actor) {
  const vendor = resolveVendor_(parts[1] || '');
  const period = String(parts[2] || '').trim();
  if (!vendor) return '업체명을 원본 시트의 항목명과 동일하게 입력하세요.\n' + ERROR_HELP;
  if (!isValidPeriod_(period)) return '사용회차 형식이 잘못됐습니다. (시작월 ≤ 종료월)\n' + ERROR_HELP;
  const isDone = type === '완료';
  const status = isDone ? '완료' : '업체 대기';
  const next = isDone ? '' : String(parts[3] || '').trim();
  const memo = isDone ? parts.slice(3).join('|').trim() : parts.slice(4).join('|').trim();
  if (!isDone && !isValidDate_(next)) return '다음 확인일을 YYYY-MM-DD로 입력하세요.';
  if (!memo) return '업무 근거 또는 업체 대기 사유를 반드시 입력하세요.';
  const lk = LockService.getScriptLock();
  lk.waitLock(10000);
  try {
    const prev = latest_().get(vendor + '|' + period);
    if (prev && prev.status === status && prev.next === next) {
      return vendor + ' / ' + period + ' 은(는) 이미 "' + status + '"로 기록돼 있어 중복 저장하지 않았습니다.';
    }
    const now = new Date();
    const sh = log_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, CFG.columns.length).setValues([[
      now, asText_(fmt_(now, 'yyyy-MM-dd')), asText_(vendor), asText_(period), asText_(status),
      asText_(next), asText_(memo), asText_(actor), asText_([type, ...parts.slice(1)].join('|'))
    ]]);
    SpreadsheetApp.flush();
  } finally { lk.releaseLock(); }
  return vendor + ' / ' + period + ' : ' + status + ' 기록했습니다.\n기존 회차가 아니라 정확히 이 사용회차에만 적용합니다.' +
    (isDone ? '' : '\n다음 확인일: ' + next);
}
function periodContainsMonth_(period, month) {
  // A single 3–4 month bulk invoice must remain discoverable for every included usage month.
  const parts = String(period).split('~');
  return month >= parts[0] && month <= (parts[1] || parts[0]);
}
function statusMessage_(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return '조회 월을 YYYY-MM로 입력하세요.';
  const selected = [...latest_().values()].filter(r => periodContainsMonth_(r.period, month));
  const done = selected.filter(r => r.status === '완료');
  const waiting = selected.filter(r => r.status === '업체 대기');
  return [
    '[AIBoot 데일리 마감 기록] ' + month,
    '완료 기록 ' + done.length + '건 / 업체 자료 대기 ' + waiting.length + '건',
    ...selected.slice(0, 20).map(r => '• ' + r.vendor + ' · ' + r.period + ' — ' +
      (r.status === '완료' ? '완료' : '처리할 일 (업체 자료 대기)') + (r.next ? ' / 다음 확인 ' + r.next : '')),
    '※ 기록된 회차만 표시. 미기록 항목을 미납으로 단정하지 않습니다.'
  ].join('\n');
}

/* ---------- vacations (full-day only) ---------- */
function vacations_() {
  try { return JSON.parse(props_().getProperty('VACATIONS') || '[]'); } catch (e) { return []; }
}
function saveVacations_(list) {
  const floor = addDays_(today_(), -60);
  props_().setProperty('VACATIONS', JSON.stringify([...new Set(list)].filter(d => d >= floor).sort()));
}
function vacationCommand_(action, spec) {
  if (action === '휴가목록') {
    const upcoming = vacations_().filter(d => d >= today_());
    return upcoming.length ? '등록된 종일휴가: ' + upcoming.join(', ') : '등록된 종일휴가가 없습니다.';
  }
  const days = dateRange_(spec);
  if (!days) return '휴가 날짜를 YYYY-MM-DD 또는 YYYY-MM-DD~YYYY-MM-DD(최대 31일)로 입력하세요.';
  const lk = LockService.getScriptLock();
  lk.waitLock(10000);
  try {
    const cur = vacations_();
    if (action === '휴가') saveVacations_(cur.concat(days));
    else saveVacations_(cur.filter(d => days.indexOf(d) < 0));
  } finally { lk.releaseLock(); }
  return action === '휴가'
    ? '종일휴가 등록: ' + days.join(', ') + '\n해당 날짜에는 정기 보고를 보내지 않고, 복귀일 오전 보고에 누적 변경을 요약합니다.'
    : '종일휴가 취소: ' + days.join(', ');
}

/* ---------- workday ---------- */
function listProp_(key) {
  return String(props_().getProperty(key) || '').split(',').map(x => x.trim()).filter(isValidDate_);
}
/** Korean public holidays from Google's official (holidays-only) public feed, cached in properties. */
function holidays_() {
  let cache = null;
  try { cache = JSON.parse(props_().getProperty('HOLIDAY_CACHE') || 'null'); } catch (e) { cache = null; }
  const stale = !cache || !cache.fetched || cache.fetched < addDays_(today_(), -CFG.holidayRefreshDays);
  if (stale) {
    try {
      const res = UrlFetchApp.fetch(CFG.holidayIcs, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
      const days = [];
      for (const ev of res.getContentText().split('BEGIN:VEVENT').slice(1)) {
        const d = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(ev);
        if (d && /DESCRIPTION:공휴일/.test(ev)) days.push(d[1] + '-' + d[2] + '-' + d[3]);
      }
      if (!days.length) throw new Error('공휴일 0건');
      cache = { fetched: today_(), days: [...new Set(days)].sort() };
      props_().setProperty('HOLIDAY_CACHE', JSON.stringify(cache));
    } catch (err) {
      console.warn('공휴일 피드 갱신 실패: ' + err.message + (cache ? ' (마지막 목록 사용)' : ''));
      if (!cache) return null;
    }
  }
  return cache.days;
}
/** @return {{workday:boolean, reason:string, warning:string}} */
function workdayInfo_(ymd) {
  if (listProp_('WORKDAYS_EXTRA').indexOf(ymd) >= 0) return { workday: true, reason: '지정 근무일', warning: '' };
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return { workday: false, reason: '주말', warning: '' };
  if (listProp_('HOLIDAYS_EXTRA').indexOf(ymd) >= 0) return { workday: false, reason: '지정 휴무일', warning: '' };
  if (vacations_().indexOf(ymd) >= 0) return { workday: false, reason: '종일휴가', warning: '' };
  const hol = holidays_();
  if (!hol) return { workday: true, reason: '평일', warning: '⚠ 공휴일 목록을 확인하지 못해 평일로 간주했습니다.' };
  if (hol.indexOf(ymd) >= 0) return { workday: false, reason: '공휴일', warning: '' };
  return { workday: true, reason: '평일', warning: '' };
}
function nextWorkday_(ymd) {
  let d = addDays_(ymd, 1);
  for (let i = 0; i < 14 && !workdayInfo_(d).workday; i++) d = addDays_(d, 1);
  return d;
}

/* ---------- report state (dedupe + recovery) ---------- */
function loadState_() {
  let s;
  try { s = JSON.parse(props_().getProperty('REPORT_STATE') || '{}'); } catch (e) { s = {}; }
  return { sent: s.sent || {}, fail: s.fail || {}, lastSentAt: s.lastSentAt || 0 };
}
function saveState_(s) {
  const floor = addDays_(today_(), -CFG.stateKeepDays);
  for (const bag of [s.sent, s.fail]) for (const k of Object.keys(bag)) if (k.slice(0, 10) < floor) delete bag[k];
  props_().setProperty('REPORT_STATE', JSON.stringify(s));
}
function failureNotices_(state, excludeKey) {
  return Object.keys(state.fail)
    .filter(k => k !== excludeKey && !state.sent[k] && !state.fail[k].notified)
    .sort()
    .map(k => '⚠ ' + k.slice(0, 10) + ' ' + CFG.windows[k.slice(11)].label + ' 발송 실패(' + state.fail[k].n + '회, ' + state.fail[k].err + ')');
}

/* ---------- reports ---------- */
function line_(r) {
  return '• ' + r.vendor + ' · ' + r.period + ' — ' + r.status + (r.next ? ' / 다음 확인 ' + r.next : '') +
    (r.memo ? ' (' + r.memo.slice(0, 60) + ')' : '');
}
function buildReport_(kind, now, state, wd) {
  const date = fmt_(now, 'yyyy-MM-dd');
  const rows = rows_();
  const latest = [...latest_(rows).values()];
  const waiting = latest.filter(r => r.status === '업체 대기');
  const out = ['[AIBoot ' + CFG.windows[kind].label + '] ' + date];
  if (kind === 'morning') {
    const since = state.lastSentAt ? new Date(state.lastSentAt) : null;
    const changed = rows.filter(r => !since || r.at > since);
    const due = waiting.filter(r => r.next && r.next <= date);
    out.push('■ 지난 보고 이후 기록 ' + changed.length + '건' + (since ? ' (' + fmt_(since, 'MM-dd HH:mm') + ' 이후)' : ''));
    out.push(...changed.slice(-15).map(line_));
    out.push('■ 오늘 확인할 업체 대기 ' + due.length + '건');
    out.push(...due.slice(0, 15).map(line_));
    out.push('■ 그 밖의 업체 자료 대기 ' + (waiting.length - due.length) + '건');
  } else {
    const todays = rows.filter(r => r.day === date);
    const nwd = nextWorkday_(date);
    const upcoming = waiting.filter(r => r.next && r.next <= nwd);
    out.push('■ 오늘 기록된 변경 ' + todays.length + '건');
    out.push(...todays.slice(-20).map(line_));
    out.push('■ 다음 근무일(' + nwd + ')까지 확인할 업체 대기 ' + upcoming.length + '건');
    out.push(...upcoming.slice(0, 15).map(line_));
  }
  const notices = failureNotices_(state, date + '|' + kind);
  if (notices.length) out.push(...notices);
  if (wd && wd.warning) out.push(wd.warning);
  out.push('※ 연노랑은 지출결의 제출 표시이며 납부 완료가 아닙니다. 미기록 ≠ 미납.');
  return out.join('\n');
}
function previewMorningReport() { const t = buildReport_('morning', new Date(), loadState_(), workdayInfo_(today_())); console.log(t); return t; }
function previewAfternoonReport() { const t = buildReport_('afternoon', new Date(), loadState_(), workdayInfo_(today_())); console.log(t); return t; }

/** Existing webhook: outbound only. Never print the URL or store it in GitHub. */
function sendWebhook_(text) {
  const url = requiredProp_('CHAT_WEBHOOK_URL');
  let result;
  try {
    result = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({ text }), muteHttpExceptions: true
    });
  } catch (err) {
    // UrlFetchApp network errors can embed the request URL; never rethrow the raw message.
    throw new Error('웹훅 네트워크 오류');
  }
  const code = result.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('웹훅 응답 ' + code);
}

/**
 * @param {'morning'|'afternoon'} kind
 * @param {{scheduled?:boolean, test?:boolean, force?:boolean}} opts
 */
function runReport_(kind, opts) {
  const lk = LockService.getScriptLock();
  if (!lk.tryLock(30000)) return 'skip: 다른 실행 진행 중';
  try {
    const now = new Date();
    const date = fmt_(now, 'yyyy-MM-dd');
    const key = date + '|' + kind;
    const state = loadState_();
    const wd = workdayInfo_(date);
    if (!opts.test) {
      if (state.sent[key]) return 'skip: 이미 발송됨 ' + key;
      if (!wd.workday && !opts.force) return 'skip: ' + wd.reason;
    }
    let text = buildReport_(kind, now, state, wd);
    if (opts.test) text = '[테스트 발송 · 정기 보고 아님]\n' + text;
    try {
      sendWebhook_(text);
    } catch (err) {
      if (!opts.test) {
        const f = state.fail[key] || { n: 0 };
        state.fail[key] = { n: f.n + 1, err: err.message, at: now.getTime() };
        saveState_(state);
      }
      console.error('AIBoot report failed ' + key + ': ' + err.message);
      return 'error: ' + err.message;
    }
    if (!opts.test) {
      for (const k of Object.keys(state.fail)) if (k !== key && !state.sent[k]) state.fail[k].notified = true;
      state.sent[key] = now.getTime();
      state.lastSentAt = now.getTime();
      saveState_(state);
    }
    return 'sent: ' + key + (opts.test ? ' (test)' : '');
  } finally { lk.releaseLock(); }
}

/** Time-driven entry point (every 10 minutes). Retries inside the window until one send succeeds. */
function reportTick() {
  const hm = fmt_(new Date(), 'HH:mm');
  const kind = Object.keys(CFG.windows).find(k => hm >= CFG.windows[k].start && hm < CFG.windows[k].end);
  if (!kind) return 'idle';
  const r = runReport_(kind, { scheduled: true });
  if (!/^skip: (이미|주말)/.test(r)) console.log('reportTick ' + hm + ' ' + r);
  return r;
}

/* ---------- manual operations (run from the editor) ---------- */
function testSendMorningReport() { return runReport_('morning', { test: true }); }
function testSendAfternoonReport() { return runReport_('afternoon', { test: true }); }
/** Recovery: send today's regular report now if it was not delivered (ignores the time window). */
function resendMorningReportNow() { return runReport_('morning', { force: true }); }
function resendAfternoonReportNow() { return runReport_('afternoon', { force: true }); }
function installReportTrigger() {
  // Regular reports are sent by integrations/local-dual-report; enabling this too would triple them.
  if (props_().getProperty('REPORTS_ENABLED') !== 'true') {
    throw new Error('정기 보고는 로컬 이중 보고가 담당합니다. 사용자 승인 후 REPORTS_ENABLED=true 설정 시에만 설치하세요.');
  }
  removeReportTrigger();
  ScriptApp.newTrigger('reportTick').timeBased().everyMinutes(CFG.tickMinutes).create();
  return '정기 보고 트리거 설치: ' + CFG.tickMinutes + '분 간격 확인, 오전 ' + CFG.windows.morning.start + ' / 오후 ' + CFG.windows.afternoon.start;
}
function removeReportTrigger() {
  let n = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'reportTick') { ScriptApp.deleteTrigger(t); n++; }
  }
  return '삭제한 정기 보고 트리거 ' + n + '개';
}
/** Dry run: workday decisions for given dates (no messages sent). */
function checkWorkdays(datesCsv) {
  const dates = String(datesCsv || '').split(',').map(x => x.trim()).filter(isValidDate_);
  const res = (dates.length ? dates : [today_()]).map(d => { const w = workdayInfo_(d); return d + ' ' + (w.workday ? '보고' : '건너뜀') + ' (' + w.reason + ')' + (w.warning ? ' ' + w.warning : ''); });
  console.log(res.join('\n'));
  return res;
}
function reportStatus_() {
  const s = loadState_();
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'reportTick').length;
  const today = today_();
  const wd = workdayInfo_(today);
  return [
    '[AIBoot 상태] ' + today + ' — ' + (wd.workday ? '근무일' : '보고 없음(' + wd.reason + ')'),
    '정기 보고 트리거: ' + (triggers ? '활성' : '비활성'),
    '오늘 오전: ' + (s.sent[today + '|morning'] ? '발송됨' : s.fail[today + '|morning'] ? '실패 ' + s.fail[today + '|morning'].n + '회' : '미발송'),
    '오늘 오후: ' + (s.sent[today + '|afternoon'] ? '발송됨' : s.fail[today + '|afternoon'] ? '실패 ' + s.fail[today + '|afternoon'].n + '회' : '미발송'),
    '마지막 정기 발송: ' + (s.lastSentAt ? fmt_(new Date(s.lastSentAt), 'yyyy-MM-dd HH:mm') : '없음')
  ].join('\n');
}

/* ---------- Chat App events ---------- */
function onMessage(e) {
  try {
    if (!emailAllowed_(e)) return { text: '이 앱은 지정된 회사 계정만 사용할 수 있습니다. 사용자 이메일이 전달되지 않는 경우에도 접근을 차단합니다.' };
    const msg = e.message || {};
    // argumentText strips the @mention in spaces even when the app name contains spaces.
    const raw = String(msg.argumentText != null ? msg.argumentText : msg.text || '').trim().replace(/^@\S+\s*/, '');
    if (!raw || raw === '도움말') return { text: ERROR_HELP };
    const parts = raw.split('|').map(x => x.trim());
    const action = parts[0];
    if (action === '조회') return { text: statusMessage_(parts[1] || fmt_(new Date(), 'yyyy-MM')) };
    if (action === '완료' || action === '대기') return { text: appendClose_(action, parts, e.user.email) };
    if (action === '휴가' || action === '휴가취소' || action === '휴가목록') return { text: vacationCommand_(action, parts[1]) };
    if (action === '상태') return { text: reportStatus_() };
    return { text: ERROR_HELP };
  } catch (err) {
    console.error('AIBoot Chat handler failed: ' + err.message);
    return { text: '처리하지 못했습니다. 설정/기록 저장소를 확인하세요. 원본 시트는 변경하지 않았습니다.' };
  }
}
function onAddToSpace(e) {
  return { text: emailAllowed_(e) ? 'AIBoot 연결됨. "도움말"을 입력하세요.' : 'AIBoot은 지정 계정 전용입니다.' };
}
function onRemoveFromSpace() {}
