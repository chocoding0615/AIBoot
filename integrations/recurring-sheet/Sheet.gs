/**
 * `[MS] 김현호` 시트에 붙이는(컨테이너 바인딩) Apps Script — 정기 업무 ID·회차 처리를 시트 안에서 한다.
 * 계산은 dist/Recurring.gs(정기 보고와 같은 원문)가 하고, 이 파일은 시트를 읽고 쓰는 일만 한다.
 *
 * 쓰는 곳은 두 군데뿐이다.
 *   - `업무` 탭 행의 개발자 메타데이터 `aiboot.recurring.taskId` (셀 값은 절대 쓰지 않는다)
 *   - 숨김 탭 `반복업무_처리이력`의 A:F
 * 다른 탭, 다른 파일, 웹훅, 정기 보고 실행기는 건드리지 않는다. 트리거를 설치하는 코드는 없다.
 */

var AIBOOT_TZ = 'Asia/Seoul';
var AIBOOT_LAST_ROW = 200; // recurring.mjs TASK_RANGE A2:D200과 같다

/* ---------- 메뉴와 자동 ID ---------- */

/** 단순 트리거: 파일을 열 때 메뉴를 만들고, ID 없는 새 업무에 ID를 붙인다. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AIBoot 정기 업무')
    .addItem('선택한 업무 회차 처리…', 'showMarkDialog')
    .addItem('새 업무에 ID 지정', 'assignIdsFromMenu')
    .addSeparator()
    .addItem('처음 설정(처리이력 탭 만들기)', 'setupFromMenu')
    .addToUi();
  try { assignNewIds_(); } catch (e) { console.warn('onOpen ID 지정 건너뜀: ' + e.message); }
}

/** 단순 트리거: `업무` 탭 A~D열을 고치면 ID 없는 행에 ID를 붙인다. 다른 탭 편집은 무시한다. */
function onEdit(e) {
  var range = e && e.range;
  if (!range || range.getSheet().getName() !== Recurring.TASK_TAB) return;
  if (range.getColumn() > 4 || range.getLastRow() < 2 || range.getRow() > AIBOOT_LAST_ROW) return;
  try { assignNewIds_(); } catch (err) { console.warn('onEdit ID 지정 건너뜀: ' + err.message); }
}

function assignIdsFromMenu() {
  var r = assignNewIds_();
  SpreadsheetApp.getUi().alert(r.assigned.length ? 'ID 지정: ' + r.assigned.map(function (a) { return a.row + '행'; }).join(', ') : '새로 ID를 붙일 업무가 없습니다.');
}

function setupFromMenu() {
  var r = setupHistoryTab_();
  SpreadsheetApp.getUi().alert(r.created ? '처리이력 탭을 만들었습니다(숨김).' : '처리이력 탭이 이미 있습니다.');
}

/* ---------- 읽기: Node readRecurringSource와 같은 모양으로 만든다 ---------- */

function spreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getName() !== Recurring.FILE_TITLE) throw new Error('정기 업무 원본 파일이 아님: ' + Recurring.FILE_TITLE + '에서만 동작');
  return ss;
}

/** 날짜 셀은 표시값(11-16)이 아니라 실제 날짜로 읽는다 — recurring.mjs cellText와 같은 규칙. */
function cellText_(value, display) {
  if (Object.prototype.toString.call(value) === '[object Date]') return Utilities.formatDate(value, AIBOOT_TZ, 'yyyy-MM-dd');
  return display == null ? '' : String(display);
}

function readSource_(ss) {
  var sheet = ss.getSheetByName(Recurring.TASK_TAB);
  if (!sheet) throw new Error('업무 탭 없음');
  var range = sheet.getRange(2, 1, AIBOOT_LAST_ROW - 1, 4);
  var values = range.getValues(), display = range.getDisplayValues();
  var last = values.length;
  while (last > 0 && display[last - 1].every(function (c) { return String(c).trim() === ''; })) last--;
  var rows = [];
  for (var i = 0; i < last; i++) rows.push([0, 1, 2, 3].map(function (c) { return cellText_(values[i][c], display[i][c]); }));
  var rowIds = [];
  sheet.createDeveloperMetadataFinder().withKey(Recurring.ID_KEY).find().forEach(function (md) {
    var loc = md.getLocation();
    if (String(loc.getLocationType()) !== 'ROW') return;
    var row = loc.getRow().getRow();
    if (row >= 2 && row <= AIBOOT_LAST_ROW && rowIds[row - 2] == null) rowIds[row - 2] = md.getValue();
  });
  for (var j = 0; j < last; j++) if (rowIds[j] === undefined) rowIds[j] = null;
  var source = { tasks: Recurring.parseTasks(rows, rowIds.slice(0, last)), history: new Map(), historyState: '미생성', historyHeader: null, taskSheetId: sheet.getSheetId(), sheet: sheet, historySheet: null };
  var hist = ss.getSheetByName(Recurring.HISTORY_TAB);
  if (hist) {
    source.historySheet = hist;
    var n = Math.max(hist.getLastRow(), 1);
    var hv = hist.getRange(1, 1, n, Recurring.HISTORY_HEADER.length).getDisplayValues();
    source.historyHeader = hv[0];
    var headerOk = Recurring.HISTORY_HEADER.every(function (h, k) { return String(hv[0][k] || '').trim() === h; });
    if (headerOk) { source.history = Recurring.parseHistory(hv); source.historyState = '연결'; }
    else source.historyState = '조회 실패'; // 열이 바뀐 표에 쓰면 다른 열을 덮어쓴다
  }
  return source;
}

/** 공휴일 피드(정기 보고와 같은 주소)를 6시간 캐시한다. 못 받으면 날짜를 만들지 않는 달력이 된다. */
function calendar_() {
  var cache = CacheService.getScriptCache(), holidays = null;
  var hit = cache.get('aiboot.holidays');
  if (hit) holidays = JSON.parse(hit);
  else {
    try {
      var res = UrlFetchApp.fetch(Recurring.HOLIDAY_ICS, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
      holidays = Recurring.parseHolidayFeed(res.getContentText());
      if (!holidays.days.length) throw new Error('0 holidays');
      cache.put('aiboot.holidays', JSON.stringify(holidays), 21600);
    } catch (e) { console.warn('공휴일 피드 실패: ' + e.message); holidays = null; }
  }
  var props = PropertiesService.getScriptProperties();
  var list = function (k) { return String(props.getProperty(k) || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
  return Recurring.makeCalendar(holidays, { holidaysExtra: list('HOLIDAYS_EXTRA'), workdaysExtra: list('WORKDAYS_EXTRA') });
}

function today_() { return Utilities.formatDate(new Date(), AIBOOT_TZ, 'yyyy-MM-dd'); }
function stamp_() { return Utilities.formatDate(new Date(), AIBOOT_TZ, 'yyyy-MM-dd HH:mm:ss'); }
function newId_() { return 'T' + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }

/** 문서 잠금: 두 사람이 동시에 처리하거나 onEdit가 겹쳐도 같은 회차 행·같은 ID가 두 번 생기지 않게 한다. */
function withLock_(fn) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('다른 처리가 진행 중 — 잠시 후 다시 시도');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- 쓰기 ---------- */

/** ID 없는 업무 행에 ID를 붙인다. 이미 있는 ID는 바꾸지 않고, 이력 탭은 만들지 않는다(setup에서만). */
function assignNewIds_() {
  return withLock_(function () {
    var ss = spreadsheet_(), source = readSource_(ss);
    if (source.historyState === '조회 실패') throw new Error('처리이력 탭 머리글이 고정 열과 다름 — ID 지정 중단');
    var plan = RecurringStatus.planInit(source.historyState === '미생성' ? Object.assign({}, source, { historyState: '연결', historyHeader: Recurring.HISTORY_HEADER }) : source, newId_, 0);
    plan.assign.forEach(function (a) {
      source.sheet.getRange(a.row + ':' + a.row).addDeveloperMetadata(Recurring.ID_KEY, a.id, SpreadsheetApp.DeveloperMetadataVisibility.DOCUMENT);
    });
    if (plan.assign.length) SpreadsheetApp.flush();
    return { assigned: plan.assign };
  });
}

function setupHistoryTab_() {
  return withLock_(function () {
    var ss = spreadsheet_();
    if (ss.getSheetByName(Recurring.HISTORY_TAB)) return { created: false };
    var hist = ss.insertSheet(Recurring.HISTORY_TAB);
    var head = hist.getRange(1, 1, 1, Recurring.HISTORY_HEADER.length);
    head.setNumberFormat('@').setValues([Recurring.HISTORY_HEADER]);
    hist.hideSheet();
    return { created: true };
  });
}

/* ---------- 회차 처리 대화상자 ---------- */

function showMarkDialog() {
  var cell = SpreadsheetApp.getActiveRange();
  if (!cell || cell.getSheet().getName() !== Recurring.TASK_TAB || cell.getRow() < 2) {
    SpreadsheetApp.getUi().alert('`업무` 탭에서 처리할 업무 행을 먼저 선택하세요.');
    return;
  }
  try { assignNewIds_(); } catch (e) { console.warn(e.message); }
  var t = HtmlService.createTemplateFromFile('Dialog');
  t.row = cell.getRow();
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(460).setHeight(420), '정기 업무 회차 처리');
}

/** 대화상자용: 선택한 행 업무의 계산 가능한 회차와 현재 상태. 기록하지 않는다. */
function listOccurrences(row) {
  var source = readSource_(spreadsheet_());
  var task = source.tasks.filter(function (t) { return t.row === row; })[0];
  if (!task) return { error: row + '행에 업무가 없음' };
  if (!task.id) return { error: '업무ID가 아직 없음 — 메뉴의 "새 업무에 ID 지정"을 먼저 실행' };
  if (task.rule.error) return { error: '규칙 확인 필요: ' + task.rule.error };
  if (source.historyState !== '연결') return { error: '처리이력 탭 상태가 ' + source.historyState + ' — "처음 설정"을 먼저 실행' };
  var occ = Recurring.occurrences(task.rule, calendar_(), today_(), { before: 400 }).filter(function (o) { return o.due; });
  return {
    row: row, id: task.id, title: task.title,
    occurrences: occ.map(function (o) { var s = Recurring.occurrenceState(task, o, source.history); return { key: o.key, due: o.due, d: o.d, state: s.state, why: s.why }; })
  };
}

/**
 * 대화상자용: 회차 하나를 완료·보류·미처리(다시 열기)로 기록한다.
 * 잠근 뒤 시트를 다시 읽고, 그 사이 행이 바뀌었으면(행 이동·삭제·ID 변경) 쓰지 않는다.
 * 검사·같은 회차 갱신 규칙은 recurring-status.mjs planMark 원문 그대로다.
 */
function markOccurrence(req) {
  return withLock_(function () {
    var source = readSource_(spreadsheet_());
    var task = source.tasks.filter(function (t) { return t.row === req.row; })[0];
    if (!task || task.id !== req.id) throw new Error('선택한 행의 업무가 바뀌었음 — 대화상자를 다시 열기');
    var plan = RecurringStatus.planMark(source, { id: req.id, key: req.key, status: req.status, note: req.note }, calendar_(), today_(), stamp_());
    if (plan.op === 'none') return { op: 'none', message: '변경 없음: ' + plan.reason };
    var hist = source.historySheet, row = plan.row;
    if (plan.op === 'append') {
      row = Math.max(hist.getLastRow(), 1) + 1;
      if (row > hist.getMaxRows()) hist.insertRowsAfter(hist.getMaxRows(), 1);
    }
    // 글자 형식으로 먼저 바꿔야 2026-11 같은 회차키가 날짜로 바뀌지 않는다(Node 도구의 RAW 쓰기와 같게).
    hist.getRange(row, 1, 1, plan.values.length).setNumberFormat('@').setValues([plan.values]);
    SpreadsheetApp.flush();
    return { op: plan.op, row: row, message: task.title + ' ' + req.key + ' → ' + req.status };
  });
}
