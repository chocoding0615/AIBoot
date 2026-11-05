#!/usr/bin/env node
/**
 * AIBoot local dual report — Codex and Antigravity each write an INDEPENDENT report
 * from the same read-only sheet snapshot and post it to the existing Google Chat webhook.
 *
 * - Source sheet: read-only (spreadsheets.get only). Nothing is written to Sheets, Gmail or Chat apps.
 * - Secrets live in %USERPROFILE%/.aiboot/config.json (never in this repo). The webhook URL is never logged.
 * - Ledger (%USERPROFILE%/.aiboot/ledger.json) keys `date|slot|agent`: at most one message each.
 * - Runs only on this PC (local CLIs use subscription logins). If the PC is off, no report is sent.
 *
 * Usage: node runner.mjs --slot morning|afternoon [--agent codex|antigravity|both] [--test] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const HOME = path.join(os.homedir(), '.aiboot');
const CONFIG = path.join(HOME, 'config.json');
const LEDGER = path.join(HOME, 'ledger.json');
const LOCK = path.join(HOME, 'ledger.lock');
const LOG_DIR = path.join(HOME, 'logs');
const TZ = 'Asia/Seoul';
const SLOTS = {
  morning: { start: '09:30', end: '11:00', label: '오전 업무보고' },
  afternoon: { start: '16:00', end: '17:30', label: '오후 업무보고' }
};
const AGENTS = { codex: '[Codex]', antigravity: '[Antigravity]' };
const TEST_TAGS = { latest: () => '최신 기준 테스트', space: date => `${date.slice(5).replace('-', '/')} 스페이스 연동 테스트` };
// Chat spaces are reference material only: read-only scopes, separate token, nothing is posted there.
const CHAT_TOKEN = path.join(HOME, 'chat-token.json');
const CHAT_SCOPES = ['https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];
const CHAT_LOOKBACK_DAYS = 7;
const CHAT_TEXT_MAX = 16000;
const HOLIDAY_ICS = 'https://calendar.google.com/calendar/ical/ko.south_korea.official%23holiday%40group.v.calendar.google.com/public/basic.ics';
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_MAX = 2000; // Chat body limit; a report over this is not sent
const REPORT_DIR = path.join(HOME, 'reports');

/* ---------- small utils ---------- */
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const kst = (d = new Date(), opt) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, ...opt }).format(d);
const today = () => kst(new Date(), { year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = () => kst(new Date(), { hour: '2-digit', minute: '2-digit', hour12: false });
const cfg = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const redact = s => String(s).replace(/https:\/\/chat\.googleapis\.com\S*/g, '<webhook>').replace(/(key|token)=[\w-]+/g, '$1=<redacted>');
function log(msg) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = `${new Date().toISOString()} ${redact(msg)}`;
  fs.appendFileSync(path.join(LOG_DIR, today() + '.log'), line + '\n');
  console.log(line);
}

/* ---------- ledger with exclusive lock ---------- */
function withLock(fn) {
  for (let i = 0; i < 50; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(LOCK, { force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) fs.rmSync(LOCK, { force: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  throw new Error('ledger lock timeout');
}
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; } };
function updateLedger(key, patch) {
  return withLock(() => {
    const l = readLedger();
    l[key] = { ...(l[key] || {}), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(l, null, 1));
    fs.renameSync(LEDGER + '.tmp', LEDGER);
    return l[key];
  });
}
/** Claim a slot; returns false if already sent or an earlier attempt's outcome is unknown. */
function claim(key) {
  return withLock(() => {
    const l = readLedger();
    const cur = l[key];
    // 'sending' = outcome unknown (may already be delivered): never resend automatically.
    // 'generating' older than 15 min = crashed before sending: safe to retry.
    const staleGen = cur?.status === 'generating' && Date.now() - Date.parse(cur.updatedAt) > 15 * 60 * 1000;
    if (cur && !staleGen && (cur.status === 'sent' || cur.status === 'sending' || cur.status === 'generating')) return cur.status;
    if (cur && (cur.attempts || 0) >= 3) return 'max-attempts';
    l[key] = { status: 'generating', attempts: (cur?.attempts || 0) + 1, updatedAt: new Date().toISOString() };
    fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(l, null, 1));
    fs.renameSync(LEDGER + '.tmp', LEDGER);
    return true;
  });
}

/* ---------- workday rules (weekend · public holiday · vacation) ---------- */
async function holidays() {
  const cache = path.join(HOME, 'holidays.json');
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  if (c && c.fetched === today()) return c.days;
  try {
    const res = await fetch(HOLIDAY_ICS);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const days = [...(await res.text()).split('BEGIN:VEVENT').slice(1)]
      .filter(ev => /DESCRIPTION:공휴일/.test(ev))
      .map(ev => /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(ev)).filter(Boolean)
      .map(m => `${m[1]}-${m[2]}-${m[3]}`);
    if (!days.length) throw new Error('0 holidays');
    fs.writeFileSync(cache, JSON.stringify({ fetched: today(), days }));
    return days;
  } catch (e) {
    log('holiday feed refresh failed: ' + e.message + (c ? ' (using cache)' : ' (no cache)'));
    return c ? c.days : null;
  }
}
async function workday(ymd, c) {
  if ((c.workdaysExtra || []).includes(ymd)) return { ok: true, reason: '지정 근무일' };
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return { ok: false, reason: '주말' };
  if ((c.holidaysExtra || []).includes(ymd)) return { ok: false, reason: '지정 휴무일' };
  if ((c.vacations || []).includes(ymd)) return { ok: false, reason: '종일휴가' };
  const h = await holidays();
  if (h && h.includes(ymd)) return { ok: false, reason: '공휴일' };
  return { ok: true, reason: '평일', warning: h ? '' : '공휴일 목록 확인 실패' };
}

/* ---------- operating rules (single source: CURRENT.md + docs/FIXED-EXPENSES-V1.md) ---------- */
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const RULE_FILES = ['CURRENT.md', 'docs/FIXED-EXPENSES-V1.md'];
const rules = () => RULE_FILES.map(f => `### ${f}\n` + fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n\n');
const FIELDS = ['[고정비]', '[계약서]', '[라이센스]', '[복지]', '[기타 업무]'];
const REMAINING_FIELDS = FIELDS.slice(0, 4); // always shown under 오늘 남은 일
const IMMINENT_DAYS = 7;
const SEP = '--------------------';
const D_BUCKETS = [['D-7', 0, 7], ['D-30', 8, 30], ['D-60', 31, 60]];
const bucketOf = d => (D_BUCKETS.find(([, lo, hi]) => d >= lo && d <= hi) || [null])[0];
const norm = s => String(s).replace(/[\s()·]/g, '').toLowerCase();
const addDay = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** This month's rule-based due day per active vendor, parsed from the FIXED-EXPENSES-V1 table. */
function fixedSchedule(date) {
  const md = fs.readFileSync(path.join(REPO, 'docs/FIXED-EXPENSES-V1.md'), 'utf8');
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (const line of md.split('\n')) {
    const c = line.split('|').map(x => x.replace(/\*\*/g, '').trim());
    if (c.length < 7 || !/^\d+$/.test(c[1])) continue;
    const [, row, vendor, , basis, , note] = c;
    if (/비활성|종료/.test(note) && /이지화물/.test(vendor)) continue;
    let day = null;
    if (/고지서/.test(basis)) day = null;
    else if (/말일/.test(basis)) day = last;
    else { const d = /(\d{1,2})일/.exec(basis); day = d ? Number(d[1]) : null; }
    out.push({ row: Number(row), vendor, basis, day });
  }
  return out;
}

/* ---------- read-only snapshot ---------- */
function oauth(c, creds) {
  const require = createRequire(path.join(c.googleAuthDir, 'package.json'));
  const { google } = require('googleapis');
  const keys = JSON.parse(fs.readFileSync(path.join(c.googleAuthDir, 'dist/gcp-oauth.keys.json'), 'utf8'));
  const k = keys.installed || keys.web;
  const auth = new google.auth.OAuth2(k.client_id, k.client_secret, (k.redirect_uris || [])[0]);
  if (creds) auth.setCredentials(creds);
  return { google, auth };
}
function sheetsClient(c) {
  const { google, auth } = oauth(c, JSON.parse(fs.readFileSync(path.join(c.googleAuthDir, 'dist/.gsheets-server-credentials.json'), 'utf8')));
  return google.sheets({ version: 'v4', auth });
}

/** One-time consent for the read-only Chat token (loopback redirect, user approves in the browser). */
async function authChat(c) {
  const http = await import('node:http');
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const { auth } = oauth(c);
  const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: CHAT_SCOPES, redirect_uri: redirect,
    ...(typeof args.account === 'string' ? { login_hint: args.account } : {}) });
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  console.log('브라우저에서 회사 계정으로 읽기 전용 권한을 승인하세요. 열리지 않으면 이 주소를 여세요:\n' + url);
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('승인 대기 시간 초과(10분)')), 10 * 60 * 1000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(q.get('code') ? 'AIBoot: 승인 완료. 이 창을 닫아도 됩니다.' : 'AIBoot: 승인되지 않았습니다.');
      if (q.get('code') || q.get('error')) { clearTimeout(t); q.get('code') ? resolve(q.get('code')) : reject(new Error('승인 거부: ' + q.get('error'))); }
    });
  });
  server.close();
  const { tokens } = await auth.getToken({ code, redirect_uri: redirect });
  const granted = String(tokens.scope || '').split(' ');
  const missing = CHAT_SCOPES.filter(s => !granted.includes(s));
  if (missing.length) throw new Error('일부 권한 미승인: ' + missing.join(', '));
  fs.writeFileSync(CHAT_TOKEN, JSON.stringify(tokens), { mode: 0o600 });
  log('chat read-only token saved (scopes: ' + granted.filter(s => /chat/.test(s)).join(' ') + ')');
}

/** Recent messages from the configured spaces (read-only). Never claims a read that failed. */
async function chatSnapshot(c, date) {
  const ids = c.chatSpaces || [];
  if (!ids.length) return { status: '미설정', text: '' };
  if (!fs.existsSync(CHAT_TOKEN)) return { status: '미연결(읽기 권한 미승인)', text: '' };
  const { google, auth } = oauth(c, JSON.parse(fs.readFileSync(CHAT_TOKEN, 'utf8')));
  const chat = google.chat({ version: 'v1', auth });
  const since = new Date(Date.parse(addDay(date, -CHAT_LOOKBACK_DAYS) + 'T00:00:00+09:00')).toISOString();
  const out = [], failed = [];
  for (const id of ids) {
    try {
      let name = id;
      try { name = (await chat.spaces.get({ name: 'spaces/' + id })).data.displayName || id; } catch {}
      const msgs = [];
      let pageToken;
      do {
        const r = await chat.spaces.messages.list({ parent: 'spaces/' + id, filter: `createTime > "${since}"`, orderBy: 'createTime asc', pageSize: 200, pageToken });
        msgs.push(...(r.data.messages || []));
        pageToken = r.data.nextPageToken;
      } while (pageToken && msgs.length < 600);
      out.push(`## ${name} (최근 ${CHAT_LOOKBACK_DAYS}일 ${msgs.length}건, 시각은 KST)`);
      for (const m of msgs) {
        const t = stripPersonal(String(m.text || '').replace(/\s+/g, ' ').trim());
        if (t.length < 4) continue;
        const when = kst(new Date(m.createTime), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const who = m.sender?.displayName || '작성자' + String(m.sender?.name || '').slice(-4);
        const reply = m.threadReply ? ' (답글)' : '';
        out.push(`- [${when}] ${who}${reply}: ${t.slice(0, 400)}`);
      }
    } catch (e) {
      failed.push(id);
      log(`chat read failed ${id}: ${e.response?.data?.error?.status || ''} ${e.response?.data?.error?.message || e.message}`.slice(0, 300));
    }
  }
  let text = out.join('\n');
  if (text.length > CHAT_TEXT_MAX) text = '(앞부분 생략)\n' + text.slice(-CHAT_TEXT_MAX);
  const status = !failed.length ? '연결' : failed.length === ids.length ? '조회 실패' : `일부 조회 실패(${failed.length}/${ids.length})`;
  return { status, text };
}
const stripPersonal = s => String(s).replace(/01[016789]-?\d{3,4}-?\d{4}/g, '<전화번호 생략>');
/** @return {{text:string, sources:object, contracts:object[], licenses:object[]}} */
async function snapshot(c) {
  const sheets = sheetsClient(c);
  const sources = {};
  const r = await sheets.spreadsheets.get({
    spreadsheetId: c.spreadsheetId,
    // '고정비 대시보드' is retired; '시트내용' holds credentials and is never read.
    ranges: ["'JP매월 지출'!B1:V37", "'AIBoot_데일리마감'!A1:I300"],
    includeGridData: true,
    fields: 'sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))'
  });
  sources['고정비(JP매월 지출)'] = '연결';
  sources['사용자 확인(AIBoot_데일리마감)'] = '연결';
  const isYellow = bg => bg && Math.round((bg.red || 0) * 255) === 255 && Math.round((bg.green || 0) * 255) === 242 && Math.round((bg.blue || 0) * 255) === 204;
  const out = [];
  for (const s of r.data.sheets) {
    out.push(`## ${s.properties.title}`);
    for (const row of s.data[0].rowData || []) {
      const cells = (row.values || []).map(v => {
        const t = (v.formattedValue || '').replace(/\s+/g, ' ').trim();
        return t && s.properties.title === 'JP매월 지출' && isYellow(v.effectiveFormat?.backgroundColor) ? t + '(연노랑)' : t;
      });
      if (cells.some(Boolean)) out.push(cells.join(' | '));
    }
  }
  // Contracts and licenses: only items inside D-60, minimum fields (no amounts, no contact data).
  const contracts = [], licenses = [];
  if (c.contractsSpreadsheetId) {
    try {
      const v = await sheets.spreadsheets.values.batchGet({ spreadsheetId: c.contractsSpreadsheetId, ranges: ["'계약서 검색'!A6:N200", "'프로그램(2026)'!A5:D60"] });
      // A blank end date renders D-DAY as 0 — only rows with a real end date and numeric D count.
      const dval = (end, dd) => /^\d{4}-\d{2}-\d{2}$/.test(String(end || '').trim()) && /^-?[\d,]+$/.test(String(dd || '').trim())
        ? Number(String(dd).replace(/,/g, '')) : NaN;
      for (const row of v.data.valueRanges[0].values || []) {
        const d = dval(row[7], row[8]);
        if (!row[2] || !Number.isFinite(d) || row[13] === 'TRUE' || !bucketOf(d)) continue;
        contracts.push({ name: stripPersonal(row[2]), what: stripPersonal(row[3] || row[1] || ''), end: row[7], d, bucket: bucketOf(d), autoRenew: row[12] === 'TRUE' });
      }
      for (const row of v.data.valueRanges[1].values || []) {
        if (/사용 만료/.test(row[0] || '')) break; // rows below this header are already expired
        const d = dval(row[2], row[3]);
        if (!row[0] || !Number.isFinite(d) || !bucketOf(d)) continue;
        licenses.push({ name: stripPersonal(row[0]), end: row[2], d, bucket: bucketOf(d) });
      }
      sources['계약서(AD_계약서 관리)'] = '연결';
      sources['라이센스(프로그램(2026))'] = '연결';
    } catch (e) {
      log('contracts/licenses read failed: ' + e.message);
      sources['계약서'] = sources['라이센스'] = '조회 실패';
    }
  } else sources['계약서'] = sources['라이센스'] = '미설정';
  sources['복지 원본'] = '미사용(직원 개인정보 포함 — 입력 제외)';
  sources['회사 Gmail'] = '미연결';
  sources['회사 자체 캘린더'] = '미연결';
  const ch = await chatSnapshot(c, today());
  sources['지정 Chat 스페이스 2개'] = ch.status;
  return { text: out.join('\n'), sources, contracts, licenses, chatText: ch.status === '연결' || /^일부/.test(ch.status) ? ch.text : '' };
}

/** Facts computed in code so both agents receive identical dates (no date arithmetic left to the model). */
async function facts(date, c, snap) {
  const wd = await workday(date, c);
  let next = date;
  for (let i = 0; i < 14; i++) { next = addDay(next, 1); if ((await workday(next, c)).ok) break; }
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const mmdd = next.slice(5).replace('-', '/');
  const nextHeading = next === addDay(date, 1) ? `내일 업무 (${mmdd})`
    : dow === 5 && next === addDay(date, 3) ? `다음주 월요일 업무 (${mmdd})`
    : `다음 근무일 업무 (${mmdd})`;
  const sched = fixedSchedule(date);
  // Imminent window (today..today+7): only these dated fixed-cost items may appear under 오늘 남은 일.
  const windowDates = Array.from({ length: IMMINENT_DAYS + 1 }, (_, i) => addDay(date, i));
  const imminent = [];
  for (const d of windowDates) {
    const [y, m, dd] = d.split('-').map(Number);
    for (const s of fixedSchedule(d)) {
      if (s.day === dd && !imminent.some(x => x.vendor === s.vendor)) imminent.push({ ...s, date: d });
    }
  }
  const imminentDays = windowDates.map(d => Number(d.slice(8)));
  const undated = sched.filter(s => !s.day).map(s => s.vendor);
  const byBucket = list => D_BUCKETS.map(([b]) => `${b}: ` + (list.filter(x => x.bucket === b).map(x => `${x.name}${x.what ? '(' + x.what + ')' : ''} 종료 ${x.end} D-${x.d}${x.autoRenew ? ' 자동연장' : ''}`).join(' / ') || '없음')).join('\n');
  const text = [
    `오늘 ${date}(${['일', '월', '화', '수', '목', '금', '토'][dow]}): ${wd.ok ? '근무일' : '휴무(' + wd.reason + ')'}${wd.warning ? ' / ' + wd.warning : ''}`,
    `다음 근무일: ${next} → 마지막 대분류 제목은 정확히 "${nextHeading}"`,
    `휴일 결제일 이동 규칙: 미확정 — 예정일을 옮기지 말 것`,
    '',
    `[고정비 임박 예정 — ${date.slice(5)}~${windowDates[IMMINENT_DAYS].slice(5)}] 오늘 남은 일 [고정비]에는 이 목록 중 실제 미처리 항목만 넣는다`,
    ...(imminent.length ? imminent.map(s => `- ${s.vendor}: ${s.date.slice(5).replace('-', '/')} (${s.basis})`) : ['- 없음']),
    '',
    `[고정비 이번 달 규칙상 예정일 — 참고용, 임박이 아니면 오늘 남은 일에 넣지 말 것] (FIXED-EXPENSES-V1 표에서 계산, 실제 고지서·납부와 다를 수 있음)`,
    ...sched.filter(s => s.day).map(s => `- ${s.vendor}: ${date.slice(5, 7)}/${String(s.day).padStart(2, '0')} (${s.basis})`),
    `- 예정일 미확정(${undated.join('·') || '없음'}): 시트나 스페이스 메시지에 구체 근거가 없으면 보고하지 말 것`,
    '',
    `[계약서 — 계약 종료일 기준 D-구간, 계약종료 처리된 건 제외]`, byBucket(snap.contracts),
    '',
    `[라이센스 — 사용 종료일 기준 D-구간]`, byBucket(snap.licenses),
    '',
    `[자료 연결 상태] ` + Object.entries(snap.sources).map(([k, v]) => `${k}: ${v}`).join(' / ')
  ].join('\n');
  return { text, nextHeading, sched, imminentDays, undated, sources: snap.sources, chatText: snap.chatText };
}

/* ---------- independent agent runs ---------- */
const CHAT_MARK = '=== CHAT ===', NOTE_MARK = '=== INTERNAL ===';
const HEADINGS = nextHeading => ['내용 요약 및 추천', '오늘 완료', '오늘 남은 일', nextHeading];
/** Shared rules, facts and layout only; wording, priority and judgment are left to each agent. */
function prompt(slot, date, snap, f) {
  const h = HEADINGS(f.nextHeading);
  return [
    '이 작업은 도구가 필요 없다. 명령 실행·파일 읽기·날짜 확인을 시도하지 말고(권한이 없어 실패한다) 필요한 모든 자료가 아래에 있으니 바로 최종 답을 출력하라.',
    `너는 (주)제이피프로페셔널 경영지원 담당자의 AI 비서다. 오늘은 ${date}(한국시간)이고 ${SLOTS[slot].label}를 쓴다.`,
    '도구·파일·명령을 쓰지 말고 아래 [운영 기준], [계산된 사실], [시트 스냅샷], [Chat 스페이스 메시지]만 근거로 판단하라. 다른 AI의 보고서는 존재하지 않는 것으로 간주한다.',
    '[Chat 스페이스 메시지]에서는 업무 공지·결정, 진행 상태 변경, 오늘 처리할 일·미해결 이슈, 다가오는 일정·마감, 사전 준비 사항만 쓴다. 잡담·인사·중복은 버린다. 시트 자료와 교차 확인해 같은 업무는 하나로 합치고, 메시지에만 있는 업무는 해당 분야 또는 [기타 업무]에 넣는다.',
    '[운영 기준]이 유일한 기준이다. 특히 "2026-11-04 사용자 확인·오류 재발 방지" 항목을 반드시 지켜라(완료 단계 재요청 금지, 근거 없는 불일치·미납·업무 생성 금지).',
    '날짜는 [계산된 사실]의 값만 쓴다. 직접 날짜를 계산하거나 새 일정을 만들지 마라. 연결 상태가 "미연결/미사용"인 자료의 내용은 쓰지 마라.',
    '',
    '[출력 형식] 정확히 두 부분으로 출력한다.',
    CHAT_MARK,
    '구글 챗에 그대로 보낼 보고 본문(제목 줄은 쓰지 말 것 — 시스템이 붙인다). 아래 순서·형식을 정확히 지킨다:',
    `${h[0]}`,
    '1. 업무 제목',
    '■ 내용: 확인된 현황 및 일정',
    '□ 추천: 필요한 사전 조치',
    '(중요도 높은 1~3건. 관련 일정·업무는 한 항목으로 합친다. 제목·■ 내용·□ 추천은 반드시 각각 줄을 바꾼다. "사실:"·"권고:" 표현 금지)',
    SEP,
    `${h[1]}`,
    '[분야]',
    '- …',
    SEP,
    `${h[2]}`,
    REMAINING_FIELDS[0], '- …', REMAINING_FIELDS[1], '- …', REMAINING_FIELDS[2], '- …', REMAINING_FIELDS[3], '- …',
    SEP,
    `${h[3]}`,
    '[분야]',
    '- …',
    `- 분야 태그는 ${FIELDS.join(' → ')} 순서. "${h[2]}"에는 ${REMAINING_FIELDS.join(' → ')} 4개를 항상 표시하고 업무가 없으면 "- 해당 없음", 스페이스 메시지 등 그 밖의 업무가 있을 때만 마지막에 [기타 업무]를 추가한다. 다른 대분류에서는 대상 없는 분야를 생략하고, 내용이 없으면 "- 해당 없음" 한 줄.`,
    `- "${h[2]}"에는 임박 업무와 실제 미처리 사항만 넣는다. [고정비]는 [계산된 사실]의 "고정비 임박 예정" 목록에서만 고른다. 예정일 미확정 업체는 구체 근거 없이 반복하지 않는다.`,
    `- 자료 연결 상태가 "연결"이 아닌 분야(예: 복지)는 "- 확인 불가(원본 미연결)"로 쓰고 "해당 없음"으로 단정하지 않는다.`,
    '- 날짜 업무는 "N일 납부: 업체A·업체B — 처리 내용" 꼴, 날짜 오름차순, 같은 날짜·같은 처리는 한 줄로 묶음. 날짜 없는 업무는 분야 마지막.',
    '- [계약서]·[라이센스]는 D-7 → D-30 → D-60 순서로 "- D-30 n건 (대상 요약)" 꼴.',
    '- 오늘 새로 확인된 완료가 없으면 오늘 완료에 "- 오늘 새로 확인된 완료 없음". 전자결재 완료 ≠ 지급 완료.',
    `- 본문 ${CHAT_MAX}자 이내. 마크다운 표·굵게·인사말 금지. 운영 기준·금지 규칙 자체를 본문에서 설명하지 말 것(결론만).`,
    `- ${CHAT_MARK} 표시는 최종 답에서 한 번만 쓴다.`,
    NOTE_MARK,
    '내부 기록(챗으로 보내지 않음): 판단 근거, 제외한 항목과 이유, 확인 불가 자료.',
    '',
    '[운영 기준]', rules(),
    '', '[계산된 사실]', f.text,
    '', '[시트 스냅샷]', snap.text,
    '', '[Chat 스페이스 메시지]', snap.chatText || `(${snap.sources['지정 Chat 스페이스 2개']} — 메시지 내용을 쓰지 말 것)`
  ].join('\n');
}

/** Deterministic checks of the latest operating standard. Returns a list of violations (empty = pass). */
function validate(chat, f) {
  const errs = [];
  const lines = chat.split('\n');
  const h = HEADINGS(f.nextHeading);
  const idx = h.map(x => lines.findIndex(l => l.trim() === x));
  if (idx.some(i => i < 0)) errs.push('대분류 제목 누락/불일치: ' + h.filter((_, i) => idx[i] < 0).join(', '));
  else {
    if (idx.some((v, i) => i && v <= idx[i - 1])) errs.push('대분류 순서 오류');
    if (idx[0] !== 0) errs.push('본문이 "내용 요약 및 추천"으로 시작하지 않음');
    for (let i = 1; i < 4; i++) if ((lines[idx[i] - 1] || '').trim() !== SEP) errs.push(`"${h[i]}" 앞 실선 누락`);
    if (lines.filter(l => l.trim() === SEP).length !== 3) errs.push('실선은 대분류 사이 3개여야 함');
    // Summary: "N. 제목" → "■ 내용:" → "□ 추천:" on separate lines, 1–3 items.
    const sumBlock = lines.slice(1, idx[1] - 1).map(l => l.trim());
    const starts = sumBlock.map((l, j) => /^\d+\.\s+\S/.test(l) ? j : -1).filter(j => j >= 0);
    if (starts.length < 1 || starts.length > 3) errs.push(`요약 항목 ${starts.length}건(1~3건이어야 함)`);
    if (starts[0] !== 0) errs.push('요약은 "1. 업무 제목"으로 시작해야 함');
    starts.forEach((s, j) => {
      const item = sumBlock.slice(s + 1, starts[j + 1]);
      const ci = item.findIndex(l => l.startsWith('■ 내용:')), ri = item.findIndex(l => l.startsWith('□ 추천:'));
      if (ci < 0 || ri < 0 || ri < ci) errs.push(`요약 ${j + 1}번: "■ 내용:" 다음 줄에 "□ 추천:" 형식 아님`);
    });
    if (/사실\s*:|권고\s*:/.test(chat)) errs.push('"사실:"/"권고:" 표현 사용');
    for (let i = 1; i < 4; i++) {
      const block = lines.slice(idx[i] + 1, i < 3 ? idx[i + 1] - 1 : undefined);
      const tags = block.filter(l => /^\s*\[[^\]]+\]\s*$/.test(l)).map(l => l.trim());
      if (tags.some(t => !FIELDS.includes(t))) errs.push(`${h[i]}: 허용되지 않은 분야 ${tags.filter(t => !FIELDS.includes(t)).join(',')}`);
      const order = tags.map(t => FIELDS.indexOf(t));
      if (order.some((v, j) => j && v <= order[j - 1])) errs.push(`${h[i]}: 분야 순서/중복 오류`);
      if (i === 2) {
        if (REMAINING_FIELDS.some((t, j) => tags[j] !== t) || tags.length > 5) errs.push(`${h[i]}: ${REMAINING_FIELDS.join('→')} 4개 분야를 모두 표시해야 함`);
        const items = {};
        let cur = null;
        for (const l of block) {
          if (/^\s*\[[^\]]+\]\s*$/.test(l)) { cur = l.trim(); items[cur] = []; } else if (cur && /^\s*-/.test(l)) items[cur].push(l);
        }
        for (const t of tags) if (!items[t]?.length) errs.push(`${h[i]} ${t}: 항목 없음("- 해당 없음" 필요)`);
        if (f.sources?.['복지 원본'] !== '연결' && (items['[복지]'] || []).some(l => !/확인 불가/.test(l))) errs.push(`${h[i]} [복지]: 미연결 자료는 "확인 불가"로 표시`);
      }
      let field = null, lastDay = -1, undated = false, lastBucket = -1;
      for (const l of block) {
        if (/^\s*\[[^\]]+\]\s*$/.test(l)) { field = l.trim(); lastDay = -1; undated = false; lastBucket = -1; continue; }
        if (field === '[고정비]') {
          const d = /^\s*-\s*(?:\d{1,2}\/)?(\d{1,2})일?/.exec(l);
          if (d && /^\s*-\s*\d/.test(l)) {
            const day = Number(d[1]);
            // Under 오늘 남은 일, order by position in the imminent window (handles month wrap).
            const ord = i === 2 ? f.imminentDays.indexOf(day) : day;
            if (i === 2 && ord < 0) errs.push(`${h[i]} [고정비]: 임박(7일 이내) 아님 "${l.trim()}"`);
            if (undated) errs.push(`${h[i]} [고정비]: 날짜 없는 업무 뒤에 날짜 업무`);
            if (ord < lastDay) errs.push(`${h[i]} [고정비]: 날짜 오름차순 아님`);
            lastDay = ord;
          } else if (/^\s*-/.test(l) && !/해당 없음|완료 없음/.test(l)) undated = true;
          if (i === 2) for (const v of f.undated) {
            if (norm(l).includes(norm(v)) && !norm(f.chatText || '').includes(norm(v))) errs.push(`${h[i]}: 예정일 미확정 ${v} 근거 없이 반복`);
          }
        }
        if (field === '[계약서]' || field === '[라이센스]') {
          const b = /D-(7|30|60)\b/.exec(l);
          if (b) { const k = ['7', '30', '60'].indexOf(b[1]); if (k < lastBucket) errs.push(`${h[i]} ${field}: D-7→D-30→D-60 순서 아님`); lastBucket = k; }
        }
      }
      if (i >= 2) {
        for (const l of block) {
          if (/(커피마켓어스|런치랩)/.test(l) && /(결재|결의)/.test(l) && /(요청|필요|진행|제출)/.test(l)) errs.push(`재요청 금지 위반: ${l.trim()}`);
        }
      }
    }
  }
  // Dates must match the computed rule-based schedule for every vendor named on the line.
  for (const l of lines) {
    const days = [...l.matchAll(/(?:\d{1,2}\/)?(\d{1,2})일/g), ...l.matchAll(/\d{1,2}\/(\d{1,2})(?!일)/g)].map(m => Number(m[1]));
    if (!days.length) continue;
    for (const s of f.sched) if (s.day && norm(l).includes(norm(s.vendor)) && !days.includes(s.day)) errs.push(`날짜 오류: ${s.vendor} 규칙상 ${s.day}일 ≠ "${l.trim()}"`);
  }
  if (/검침/.test(chat)) errs.push('허위 업무: 매장 전기 검침');
  if (/생각공장[^\n]*(불일치|미납|재확인)/.test(chat)) errs.push('생각공장 근거 없는 불일치/재확인');
  if (/미납(?!\S*\s*(?:판단|단정|으로 보지|아님))/.test(chat)) errs.push('"미납" 단정 표현');
  if (/이지화물/.test(chat)) errs.push('비활성 업체(이지화물) 포함');
  // No yellow cell ≠ not processed: the sheet cannot prove an expense report is missing.
  if (/(지출결의|결의|결재)[^\n]*(미작성|미제출|미처리)\s*(상태|입니다|임)?/.test(chat)) errs.push('연노랑 없음을 미작성·미처리로 단정');
  const unread = f.chatText ? 'Gmail|메일함|캘린더' : 'Gmail|메일함|캘린더|스페이스|채팅방';
  if (new RegExp(`(${unread})[^\\n]*(확인됨|수신됨|에 따르면|공지)`).test(chat)) errs.push('미연결 자료를 본 것처럼 기술');
  if (chat.length > CHAT_MAX) errs.push(`길이 초과 ${chat.length}>${CHAT_MAX}`);
  return [...new Set(errs)];
}
/** Split an agent answer and validate the chat part; never send raw analysis or a failing report. */
function splitReport(raw, f) {
  const text = raw.replace(/\r/g, '');
  // Some agents echo their reasoning (and the marker) before the answer: use the last CHAT block.
  const ci = text.lastIndexOf(CHAT_MARK), ni = text.indexOf(NOTE_MARK, ci);
  if (ci < 0) throw new Error('format: CHAT section missing');
  const chat = text.slice(ci + CHAT_MARK.length, ni > ci ? ni : undefined).trim()
    .split('\n').map(l => l.trimEnd()).filter(l => l.trim()).join('\n');
  const errs = validate(chat, f);
  if (errs.length) throw new Error('validation: ' + errs.join(' | '));
  return { chat, internal: ni >= 0 ? text.slice(ni + NOTE_MARK.length).trim() : '' };
}
function run(cmd, argv, opts, input) {
  return new Promise(resolve => {
    const p = spawn(cmd, argv, { ...opts, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); err += '\nTIMEOUT'; }, AGENT_TIMEOUT_MS);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    if (input != null) { p.stdin.write(input); }
    p.stdin.end();
  });
}
async function generate(agent, text) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `aiboot-${agent}-`)); // empty, isolated cwd
  try {
    if (agent === 'codex') {
      const outFile = path.join(work, 'out.md');
      const r = await run('codex.cmd', ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', work, '-o', outFile, '-'],
        { cwd: work, shell: true }, text);
      const body = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
      if (r.code !== 0 || !body) throw new Error('codex exit ' + r.code + ' ' + r.err.slice(-300));
      return body;
    }
    const agy = path.join(os.homedir(), 'AppData/Local/agy/bin/agy.exe');
    const r = await run(agy, ['-p', text, '--mode', 'plan', '--print-timeout', '540s'], { cwd: work });
    if (/quota|rate.?limit|resource.?exhausted|429/i.test(r.err)) throw new Error('antigravity QUOTA (no retry)');
    if (r.code !== 0 || !r.out.trim()) throw new Error('antigravity exit ' + r.code + ' ' + r.err.slice(-300));
    return r.out.trim();
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/* ---------- webhook (outbound only) ---------- */
async function post(url, text) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
  } catch { throw new Error('webhook network error'); } // never surface the URL
  if (!res.ok) throw new Error('webhook HTTP ' + res.status);
  const j = await res.json().catch(() => ({}));
  if (!j.name) throw new Error('webhook response without message name');
  return j.name.split('/').pop(); // message id only
}

/* ---------- main ---------- */
async function main() {
  if (args['auth-chat']) return authChat(cfg());
  if (args['check-chat']) {
    const s = await chatSnapshot(cfg(), today());
    return log(`chat check: ${s.status} lines=${s.text ? s.text.split('\n').length : 0}`);
  }
  const slot = args.slot;
  if (!SLOTS[slot]) throw new Error('--slot morning|afternoon');
  const agents = !args.agent || args.agent === 'both' ? Object.keys(AGENTS) : [args.agent];
  if (agents.some(a => !AGENTS[a])) throw new Error('--agent codex|antigravity|both');
  const c = cfg();
  const date = today();
  const test = !!args.test, dry = !!args['dry-run'];

  if (!test) {
    if (date < c.trialStart || date > c.trialEnd) return log(`skip ${date} ${slot}: 운영 기간(${c.trialStart}~${c.trialEnd}) 밖`);
    const now = hm();
    if (now < SLOTS[slot].start || now >= SLOTS[slot].end) return log(`skip ${date} ${slot}: 보고 시간대 밖(${now}) — PC가 꺼져 있었으면 이 회차는 발송하지 않음`);
    const wd = await workday(date, c);
    if (!wd.ok) return log(`skip ${date} ${slot}: ${wd.reason}`);
  }

  const tag = test && args.tag ? String(args.tag) : '';
  if (tag && !TEST_TAGS[tag]) throw new Error('--tag ' + Object.keys(TEST_TAGS).join('|'));
  const snap = await snapshot(c);
  const f = await facts(date, c, snap);
  const hash = crypto.createHash('sha256').update(snap.text + f.text).digest('hex').slice(0, 12);
  log(`snapshot ${date} ${slot} sha=${hash} chars=${snap.text.length} contracts=${snap.contracts.length} licenses=${snap.licenses.length}`);
  const text = prompt(slot, date, snap, f);
  const unconnected = Object.entries(snap.sources).filter(([, v]) => v !== '연결').map(([k]) => k.replace(/\(.*\)/, ''));

  await Promise.all(agents.map(async agent => {
    // Test sends are tracked separately from regular runs: `|test` or `|test:<tag>`.
    const key = `${date}|${slot}|${agent}${test ? '|test' + (tag ? ':' + tag : '') : ''}`;
    const claimed = dry ? true : claim(key);
    if (claimed !== true) return log(`skip ${key}: ledger=${claimed}`);
    const t0 = Date.now();
    try {
      // --from-report re-validates a saved answer without calling the agent (dry-run only).
      const raw = dry && args['from-report'] ? fs.readFileSync(path.join(REPORT_DIR, `${date}-${slot}-${agent}-${args['from-report']}.md`), 'utf8')
        : await generate(agent, text);
      if (/chat\.googleapis\.com|key=AIza|token=/.test(raw)) throw new Error('output contains secret-like text; not sent');
      // Full analysis stays on this PC only (internal record); Chat gets the validated short part.
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      if (!args['from-report']) fs.writeFileSync(path.join(REPORT_DIR, `${date}-${slot}-${agent}${test ? '-test' + (tag ? '-' + tag : '') : ''}${dry ? '-preview' : ''}.md`),
        `snapshot ${hash}\n\n${raw}\n`);
      const { chat } = splitReport(raw, f);
      const title = `${AGENTS[agent]} ${tag ? '[' + TEST_TAGS[tag](date) + '] ' : test ? '[테스트] ' : ''}[AIBoot] ${SLOTS[slot].label} (${date.slice(5).replace('-', '/')})`;
      const msg = `*${title}*\n${chat}\n\n_확인 불가(미연결): ${unconnected.join(' · ')}_`;
      if (dry) return log(`dry-run ${key} ok chat=${chat.length} chars in ${Date.now() - t0}ms\n${msg}`);
      updateLedger(key, { status: 'sending' });
      const id = await post(c.webhookUrl, msg);
      updateLedger(key, { status: 'sent', messageId: id, snapshot: hash });
      log(`sent ${key} messageId=${id} ${Date.now() - t0}ms`);
    } catch (e) {
      const st = readLedger()[key]?.status;
      // 'sending' that failed with a definite HTTP/network error is safe to mark failed; unknown stays 'sending'.
      if (!dry) updateLedger(key, { status: st === 'sending' && !/^webhook/.test(e.message) ? 'sending' : 'failed', error: redact(e.message).slice(0, 300) });
      log(`FAILED ${key}: ${e.message}`);
      process.exitCode = 1;
    }
  }));
}
main().catch(e => { log('FATAL ' + e.message); process.exit(1); });
