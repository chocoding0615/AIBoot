#!/usr/bin/env node
/**
 * 정기 업무 처리 도구 — AIBoot에서 시트에 쓰는 유일한 코드다. 사람이 직접 실행할 때만 동작하고 스케줄러는 부르지 않는다.
 * --apply가 없으면 계획만 출력하고 시트를 바꾸지 않는다. `업무` 탭의 셀은 어떤 경우에도 쓰지 않는다.
 *
 *   node recurring-status.mjs                                  규칙·업무ID·회차 상태 보기 (읽기만)
 *   node recurring-status.mjs --init [--apply]                 숨김 이력 탭 1개 생성, 행에 업무ID 지정
 *   node recurring-status.mjs --mark --id T1a2b3c4d --key 2026-11 --status 완료 --note "근거" [--apply]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { HISTORY_HEADER, HISTORY_TAB, ID_KEY, STATES, loadHolidays, makeCalendar, occurrenceState, occurrences, readRecurringSource } from './recurring.mjs';

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const kstDate = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const kstStamp = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

/** @return {{requests:object[], createTab:boolean, assign:{row:number,id:string}[]}} */
export function planInit(source, newId = () => 'T' + crypto.randomBytes(4).toString('hex'), tabId = crypto.randomInt(1000000, 2000000000)) {
  const createTab = source.historyState === '미생성';
  if (source.historyState === '조회 실패') throw new Error('이력 탭을 읽지 못해 생성 여부를 판단할 수 없음');
  if (!createTab && HISTORY_HEADER.some((h, i) => clean(source.historyHeader?.[i]) !== h)) throw new Error('이력 탭 머리글이 고정 열과 다름');
  const used = new Set(source.tasks.map(t => t.id).filter(Boolean));
  const assign = [];
  for (const t of source.tasks) {
    if (t.id || t.rule.error === '업무명 없음') continue;
    let id = newId();
    while (used.has(id)) id = newId();
    used.add(id);
    assign.push({ row: t.row, id });
  }
  const requests = [];
  if (createTab) requests.push(
    { addSheet: { properties: { sheetId: tabId, title: HISTORY_TAB, hidden: true, gridProperties: { rowCount: 2000, columnCount: HISTORY_HEADER.length } } } },
    { updateCells: { start: { sheetId: tabId, rowIndex: 0, columnIndex: 0 }, fields: 'userEnteredValue', rows: [{ values: HISTORY_HEADER.map(stringValue => ({ userEnteredValue: { stringValue } })) }] } }
  );
  for (const a of assign) requests.push({ createDeveloperMetadata: { developerMetadata: { metadataKey: ID_KEY, metadataValue: a.id, visibility: 'DOCUMENT',
    location: { dimensionRange: { sheetId: source.taskSheetId, dimension: 'ROWS', startIndex: a.row - 1, endIndex: a.row } } } } });
  return { requests, createTab, assign };
}

/**
 * 회차 하나의 상태 기록 계획. 계산 가능한 회차만 받고(미래 회차를 미리 만들지 않음), 완료·보류는 근거가 있어야 한다.
 * 같은 회차는 새 행을 만들지 않고 그 행을 갱신한다.
 */
export function planMark(source, { id, key, status, note }, cal, today, stamp) {
  if (source.historyState !== '연결') throw new Error(`이력 탭 상태가 ${source.historyState} — 먼저 --init`);
  const task = source.tasks.filter(t => t.id === id);
  if (task.length !== 1) throw new Error(task.length ? '같은 업무ID가 두 행에 있음' : '업무ID 없음');
  if (!STATES.includes(status)) throw new Error(`상태는 ${STATES.join('·')} 중 하나`);
  const text = clean(note);
  if (status !== '미처리' && !text) throw new Error(`${status}에는 --note 근거가 필요`);
  const occ = occurrences(task[0].rule, cal, today, { before: 400 }).find(o => o.key === key && o.due);
  if (!occ) throw new Error('계산 가능한 회차가 아님(미래 회차는 D-60 이내만)');
  const current = source.history.get(`${id}|${key}`);
  if (current?.duplicate) throw new Error('같은 회차 행이 이미 여럿 — 수동 정리 필요');
  if (!current && status === '미처리') return { op: 'none', reason: '기록이 없어 되돌릴 것이 없음' };
  if (current?.status === status && current.basis === occ.due && (status === '미처리' || current.hasNote)) return { op: 'none', reason: '이미 같은 상태' };
  return { op: current ? 'update' : 'append', row: current?.row, values: [id, key, status, stamp, text, occ.due] };
}

function connect() {
  const home = path.join(os.homedir(), '.aiboot');
  const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  if (!c.recurringSpreadsheetId) throw new Error('config.json에 recurringSpreadsheetId가 없음');
  const require = createRequire(path.join(c.googleAuthDir, 'package.json'));
  const { google } = require('googleapis');
  const keys = JSON.parse(fs.readFileSync(path.join(c.googleAuthDir, 'dist/gcp-oauth.keys.json'), 'utf8'));
  const k = keys.installed || keys.web;
  const auth = new google.auth.OAuth2(k.client_id, k.client_secret, (k.redirect_uris || [])[0]);
  auth.setCredentials(JSON.parse(fs.readFileSync(path.join(c.googleAuthDir, 'dist/.gsheets-server-credentials.json'), 'utf8')));
  return { c, home, api: google.sheets({ version: 'v4', auth }).spreadsheets };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(x => x.length));
  const { c, home, api } = connect();
  const spreadsheetId = c.recurringSpreadsheetId, today = kstDate();
  const source = await readRecurringSource(api, spreadsheetId, console.error);
  const cal = makeCalendar(await loadHolidays({ file: path.join(home, 'holidays.json'), today, log: console.error }), c);
  if (args.init) {
    const plan = planInit(source);
    console.log(`이력 탭: ${plan.createTab ? '숨김 탭 생성' : '이미 있음'} · 업무ID 지정 ${plan.assign.length}행`);
    if (!plan.requests.length) return;
    if (!args.apply) return console.log('계획만 출력했다. 실행하려면 --apply');
    await api.batchUpdate({ spreadsheetId, requestBody: { requests: plan.requests } });
    return console.log('적용 완료');
  }
  if (args.mark) {
    const plan = planMark(source, { id: args.id, key: args.key, status: args.status, note: args.note === true ? '' : args.note }, cal, today, kstStamp());
    console.log(plan.op === 'none' ? `변경 없음: ${plan.reason}` : `${plan.op === 'update' ? `${plan.row}행 갱신` : '새 행 추가'}: ${plan.values.slice(0, 3).join(' / ')}`);
    if (plan.op === 'none') return;
    if (!args.apply) return console.log('계획만 출력했다. 실행하려면 --apply');
    const requestBody = { values: [plan.values] };
    if (plan.op === 'update') await api.values.update({ spreadsheetId, range: `'${HISTORY_TAB}'!A${plan.row}:F${plan.row}`, valueInputOption: 'RAW', requestBody });
    else await api.values.append({ spreadsheetId, range: `'${HISTORY_TAB}'!A:F`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody });
    return console.log('적용 완료');
  }
  console.log(`처리이력: ${source.historyState} · Master_Sheet 등록: ${source.registered === null ? '확인 실패' : source.registered ? '확인' : '없음'}`);
  for (const t of source.tasks) {
    console.log(`${t.row}행 ${t.title} [${t.id || 'ID 없음'}] 사용 여부 ${t.use.label}${t.rule.error ? ' · 규칙 오류: ' + t.rule.error : ''}`);
    for (const o of occurrences(t.rule, cal, today)) console.log(`  ${o.key || '-'} ${o.due || o.unknown} ${o.due ? occurrenceState(t, o, source.history).state : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error('실패: ' + e.message); process.exit(1); });
