import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { occurrences, recurringOmissions } from '../local-dual-report/recurring.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const normal = value => String(value).replace(/[^a-z0-9가-힣]/gi, '').toLowerCase();
const actions = [
  ['공지', /공지/], ['교육 이수', /이수/], ['지출결의 작성', /지출결의/],
  ['실제 납부', /납부/], ['갱신 검토', /갱신검토/], ['갱신 계약', /갱신(?:계약|확정)/]
];
const actionOf = text => {
  const found = actions.filter(([, re]) => re.test(normal(text)));
  return found.length === 1 ? found[0][0] : null;
};

/** Reuse source IDs and occurrence calculations. No metadata/Sheet writes for missing IDs. */
export function completionTargets(source, cal, today, scope) {
  return source.tasks.filter(t => t.use.active && !t.idConflict && !t.sameTitle && !t.rule.error).flatMap(task => {
    const action = actionOf(task.title);
    if (!action) return [];
    const ruleHash = digest([task.title, task.cycle, task.basis]);
    const taskId = task.id || `local:${ruleHash}`;
    return occurrences(task.rule, cal, today).filter(o => o.due).map(o => ({
      scope, taskId, ruleHash, title: task.title, occurrenceKey: o.key, basis: o.due, action,
      history: source.history?.get(`${task.id}|${o.key}`), historyState: source.historyState
    }));
  });
}

const recordKey = target => digest([target.scope, target.taskId, target.ruleHash, target.basis, target.action]);
const conflict = target => target.historyState === '조회 실패' || target.history?.duplicate ||
  target.history && (target.history.basis !== target.basis || target.history.status !== '완료' || !target.history.hasNote);

/** Exact identity + occurrence + action only; ordinary text/fixed costs/licenses cannot match. */
export function completedAction(target, history = {}) {
  if (!target.scope || !target.taskId || !target.ruleHash || !target.basis || !target.action) return false;
  const record = history?.[recordKey(target)];
  return !!record && record.scope === target.scope && record.taskId === target.taskId &&
    record.ruleHash === target.ruleHash && record.title === target.title && record.occurrenceKey === target.occurrenceKey && record.basis === target.basis && record.action === target.action &&
    record.actor && record.confirmationId && record.requestId && !conflict(target);
}

/** Read the existing atomic store without acquiring its write lock or changing it. */
export function readReportCompletions(home, today, readFile = fs.readFileSync) {
  let state;
  try { state = JSON.parse(readFile(path.join(home, 'assistant/state.json'), 'utf8')); }
  catch (error) { return { history: {}, status: error.code === 'ENOENT' ? '없음' : '조회 실패' }; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { history: {}, status: '조회 실패' };
  const history = state.completionHistory;
  if (history === undefined) return { history: {}, status: '없음' };
  try {
    if (!history || typeof history !== 'object' || Array.isArray(history)) throw Error();
    if (!Object.keys(history).length) return { history: {}, status: '없음' };
    const config = JSON.parse(readFile(path.join(home, 'assistant.json'), 'utf8'));
    if (state.version !== 1 || !/^spaces\/[\w-]+$/.test(config.space || '') || !/^users\/\d+$/.test(config.owner || '') ||
        state.identity !== `${config.space}|${config.owner}|${config.startAt}`) throw Error();
    for (const [key, record] of Object.entries(history)) {
      if (!record || recordKey(record) !== key || record.actor !== config.owner || !actions.some(([a]) => a === record.action) ||
          !['scope', 'taskId', 'ruleHash', 'title', 'occurrenceKey', 'basis', 'requestId', 'confirmationId'].every(k => typeof record[k] === 'string' && record[k])) throw Error();
      for (const date of [record.basis, record.processedDate]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error();
      }
      if (record.processedDate > today || !Number.isFinite(Date.parse(record.confirmedAt)) || Date.parse(record.confirmedAt) > Date.parse(`${today}T23:59:59.999+09:00`)) throw Error();
      const entry = Object.entries(state.completionRequests || {}).find(([token, r]) => /^[a-f0-9]{24}$/.test(token) && r?.key === key && r.requestId === record.requestId &&
        r.owner === config.owner && r.space === config.space &&
        new RegExp(`^완료 확인 ${token} 처리일 ${record.processedDate}[.!]?\\s*$`).test(state.questions?.[record.confirmationId]?.text?.trim() || ''));
      const request = state.questions?.[record.requestId], confirmation = state.questions?.[record.confirmationId];
      if (!entry || ![request, confirmation].every(q => q?.id?.startsWith(`${config.space}/messages/`)) ||
          confirmation.at !== record.confirmedAt || Date.parse(confirmation.at) <= Date.parse(request.at) ||
          !Number.isFinite(Date.parse(request.at)) || Date.parse(confirmation.at) - Date.parse(request.at) > 86400000) throw Error();
    }
    return { history, status: '연결' };
  } catch { return { history: {}, status: '조회 실패' }; }
}

/** Shared projection: only exact confirmed occurrences/actions are removed. */
export function filterCompletedRecurring(lines, targets, history = {}) {
  return lines.flatMap(text => {
    const target = targets.find(t => text.startsWith(`${t.title}: ${t.basis} (`));
    if (target && completedAction(target, history)) return [];
    const mismatch = target && history?.[recordKey(target)] && conflict(target);
    return [{ text: mismatch ? `${text} / 완료 기록과 원본 불일치 — 확인 필요` : text, target }];
  });
}

/** Reuse the same projection at the report's existing source boundary. */
export function reportRecurring(source, cal, today, spreadsheetId, lines, history) {
  const scope = 'recurring:' + crypto.createHash('sha256').update(spreadsheetId).digest('hex').slice(0, 24);
  const targets = completionTargets(source, cal, today, scope);
  const completed = targets.filter(t => completedAction(t, history)).map(({title, basis, action}) => ({title, basis, action}));
  return { lines: filterCompletedRecurring(lines, targets, history).map(x => x.text), completed };
}

/** Check recommendations, not historical completion statements. No automatic text rewriting. */
export function completedRecommendations(chat, completed = [], nextHeading, remaining = []) {
  const datePattern = /(?<!\d)(?:(\d{4})[/.-])?(\d{1,2})[/.-](\d{1,2})(?!\d)|(?<!\d)(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/g;
  const sameOccurrence = (text, due) => {
    const dates = [...text.matchAll(datePattern)];
    return !dates.length || dates.some(m => (!m[1] && !m[4] || (m[1] || m[4]) === due.slice(0, 4)) &&
      Number(m[2] || m[5]) === Number(due.slice(5, 7)) && Number(m[3] || m[6]) === Number(due.slice(8)));
  };
  const repeats = (context, recommendation, target) => {
    let namedText = normal(context.replace(datePattern, ''));
    // A longer, independently listed task name is not this task's completion.
    for (const line of remaining) {
      const other = /^(.+?): \d{4}-\d{2}-\d{2} \(D[+-]\d+\)/.exec(line)?.[1];
      if (other && normal(other).length > normal(target.title).length) namedText = namedText.replaceAll(normal(other), '');
    }
    const named = namedText.includes(normal(target.title));
    const action = actionOf(recommendation);
    if (!named || action && action !== target.action) return false;
    if (!sameOccurrence(context, target.basis) && remaining.some(r => r.startsWith(`${target.title}: `) && recurringOmissions([r], [context]).length === 0)) return false;
    return true;
  };
  const errors = [];
  const lines = chat.split('\n');
  let section = '', summary = [], recommendation = [], item = [];
  for (const line of lines) {
    if (['내용 요약 및 추천', '오늘 완료', '오늘 남은 일', nextHeading].includes(line.trim())) { section = line.trim(); summary = []; recommendation = []; item = []; continue; }
    if (section === '내용 요약 및 추천') {
      if (/^\d+\.\s/.test(line.trim())) { summary = []; recommendation = []; }
      summary.push(line);
      if (/^□\s*추천:/.test(line.trim())) recommendation = [line];
      else if (recommendation.length) recommendation.push(line);
      else continue;
    } else {
      if (!['오늘 남은 일', nextHeading].includes(section)) continue;
      if (/^\s*\[/.test(line)) { item = []; continue; }
      if (/^\s*-/.test(line)) item = [line];
      else if (item.length) item.push(line);
      else continue;
    }
    for (const target of completed) {
      if (repeats(section === '내용 요약 및 추천' ? summary.join(' ') : item.join(' '), section === '내용 요약 및 추천' ? recommendation.join(' ') : item.join(' '), target)) {
        errors.push(`완료 행위 재추천: ${target.title} ${target.basis} ${target.action}`);
      }
    }
  }
  return [...new Set(errors)];
}

/** Deterministic confirmation flow. Collected owner messages only; never invokes AI or posts. */
export async function handleCompletion(state, q, config, io) {
  const confirm = /^완료 확인 ([a-f0-9]{24})(?: 처리일 (\d{4}-\d{2}-\d{2}))?[.!]?\s*$/.exec(q.text.trim());
  const statement = /^(.*?)\s*완료(?:했어|했어요|했습니다)?[.!]?\s*$/.exec(q.text.trim());
  if (!confirm && !statement) return null;
  if (!io.readCompletionSource) return '완료 이력 원본 조회 미연결 — 기록하지 않았습니다.';
  let data;
  try { data = await io.readCompletionSource(); }
  catch { return '완료 이력 원본 조회 실패 — 기록하지 않았습니다.'; }
  const targets = completionTargets(data.source, data.cal, data.today, data.scope);
  if (confirm) {
    const request = state.completionRequests?.[confirm[1]];
    if (!request || !Number.isFinite(Date.parse(q.at)) || !Number.isFinite(Date.parse(request.at)) || request.owner !== config.owner || request.space !== config.space ||
        Date.parse(q.at) <= Date.parse(request.at) || Date.parse(q.at) - Date.parse(request.at) > 86400000) {
      return '확인 요청이 없거나 유효하지 않습니다. 대상 업무와 회차를 다시 확인해 주세요.';
    }
    const target = targets.find(t => recordKey(t) === request.key);
    if (!target || conflict(target)) return '업무·회차 변경 또는 원본 이력과 불일치 — 확인 필요, 기록하지 않았습니다.';
    if (completedAction(target, state.completionHistory)) return '같은 업무·회차·행위는 이미 완료 기록이 있습니다. 중복 저장하지 않았습니다.';
    const processedDate = confirm[2];
    if (!processedDate || !Number.isFinite(Date.parse(processedDate)) || new Date(processedDate).toISOString().slice(0, 10) !== processedDate || processedDate > data.today) {
      return '실제 처리일 확인 필요 — "완료 확인 코드 처리일 YYYY-MM-DD"로 확인해 주세요. 기록하지 않았습니다.';
    }
    if (config.completionRecordingApproved !== true) return '완료 기록 미리보기만 확인했습니다. 운영 기록 승인이 없어 저장하지 않았습니다.';
    // Stored atomically with this message's preview in the existing assistant store.
    state.completionHistory ??= {};
    state.completionHistory[request.key] = {
      scope: target.scope, taskId: target.taskId, ruleHash: target.ruleHash, title: target.title,
      occurrenceKey: target.occurrenceKey, basis: target.basis, action: target.action,
      processedDate, confirmedAt: q.at, actor: config.owner,
      requestId: request.requestId, confirmationId: q.id
    };
    return `${target.title} / 회차 ${target.basis} / ${target.action} 완료 이력을 저장했습니다. 다른 행위·다음 회차는 완료 처리하지 않았습니다.`;
  }
  const requested = statement[1];
  const date = /\d{4}-\d{2}-\d{2}/.exec(requested)?.[0];
  const title = normal(requested.replace(/\d{4}-\d{2}-\d{2}/g, ''));
  const matches = targets.filter(t => normal(t.title) === title && (!date || t.basis === date));
  if (matches.length !== 1) return '업무명·완료 행위·회차를 하나로 확인할 수 없습니다. 원본의 정확한 업무명과 회차 기준일(YYYY-MM-DD)을 알려 주세요. 기록하지 않았습니다.';
  const target = matches[0];
  if (conflict(target)) return '원본 처리 이력과 불일치하거나 조회 실패 — 확인 필요, 기록하지 않았습니다.';
  if (completedAction(target, state.completionHistory)) return '같은 업무·회차·행위는 이미 완료 기록이 있습니다. 중복 저장하지 않았습니다.';
  const key = recordKey(target), token = digest([q.id, key, config.owner, config.space]);
  state.completionRequests ??= {};
  state.completionRequests[token] = { key, owner: config.owner, space: config.space, requestId: q.id, at: q.at };
  return `${target.title} / 회차 ${target.basis} / 완료 행위: ${target.action}\n맞으면 24시간 안에 "완료 확인 ${token} 처리일 YYYY-MM-DD"에 실제 처리일을 넣어 입력해 주세요. 아직 완료 이력은 저장하지 않았습니다.`;
}
