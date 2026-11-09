/**
 * 보고 운영 기간 — 비교 시험과 시험 종료 후 운영을 나눈다. 순수 함수(파일·네트워크 없음).
 *
 * - trialStart~trialEnd: 비교 시험. 요청한 AI(기본 두 개)가 모두 보고한다.
 * - trialEnd 이후: config.afterTrialAgents에 적힌 AI만 보고한다. 없으면 예전처럼 보고하지 않는다.
 *   설정을 넣기 전까지는 동작이 바뀌지 않으므로, 단독 운영은 검증이 끝난 뒤 설정 한 줄로 켠다.
 */
export function runPlan(date, c, requested, known) {
  if (!c.trialStart || !c.trialEnd) return { skip: '운영 기간 설정 없음' };
  if (date < c.trialStart) return { skip: `운영 기간(${c.trialStart}~) 전` };
  if (date <= c.trialEnd) return { agents: requested, mode: '비교 시험' };
  const after = c.afterTrialAgents;
  if (after === undefined) return { skip: `비교 시험 종료(${c.trialEnd}) — 시험 후 보고 AI 미설정` };
  if (!Array.isArray(after) || !after.length || after.some(a => !known.includes(a))) return { skip: '시험 후 보고 AI 설정 오류 — 보고하지 않음' };
  const agents = requested.filter(a => after.includes(a));
  if (!agents.length) return { skip: `비교 시험 종료(${c.trialEnd}) — 시험 후에는 ${after.join('·')}만 보고` };
  return { agents, mode: '시험 후 운영' };
}

/** 직전 시도가 발송 전 검증에서 막혔다면 그 사유. 같은 표현을 되풀이하지 않도록 다음 시도에만 알린다. */
export function retryNote(entry) {
  const e = String(entry?.status === 'failed' ? entry.error || '' : '');
  if (!e.startsWith('validation:')) return '';
  return `[직전 시도 검증 실패 — 아래 사유가 다시 나오면 발송되지 않는다. 같은 표현을 쓰지 말고 [운영 기준]대로 고쳐 써라]\n${e.slice('validation:'.length).trim()}`;
}
