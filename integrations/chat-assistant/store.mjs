import fs from 'node:fs';
import path from 'node:path';
import { initialState, recover } from './core.mjs';

export function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'state.json'), lock = path.join(directory, 'lock');
  // PID-owned lock; age alone never steals a live worker's lock. Incomplete lock needs manual inspection.
  const acquire = () => fs.mkdirSync(lock);
  try { acquire(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recoveryLock = `${lock}.recovery`;
    try { fs.mkdirSync(recoveryLock); } catch { throw new Error('대화 잠금 복구 중 또는 확인 필요'); }
    try {
      let pid;
      try { pid = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid; } catch { throw new Error('대화 잠금 확인 필요'); }
      if (!Number.isInteger(pid) || pid < 1) throw new Error('대화 잠금 확인 필요');
      try { process.kill(pid, 0); throw new Error('대화 처리기가 이미 실행 중'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      fs.rmSync(lock, { recursive: true }); acquire();
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    } finally { fs.rmSync(recoveryLock, { recursive: true }); }
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const close = () => fs.rmSync(lock, { recursive: true });
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('대화 상태 손상 — 초기화하지 않고 중단');
      state = initialState();
    }
    if (state.version !== 1 || !state.questions || !Array.isArray(state.messages) || !Array.isArray(state.context) || !state.proposals || !state.usage) throw new Error('대화 상태 형식 확인 필요');
    recover(state);
    const save = () => {
      const temp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    };
    save();
    return { state, save, close };
  } catch (e) { close(); throw e; }
}
