import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceTodoService } from '../todos.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

test('WorkspaceTodoService - list, add, toggle, and remove', async () => {
  let recorded = null;
  const mockLedger = {
    recordAction: (action) => {
      recorded = action;
    },
  };

  const service = new WorkspaceTodoService({ ledger: mockLedger });

  // 1. List default todos
  const initial = service.list();
  assert.equal(initial.items.length, 2);
  assert.equal(initial.items[0].title, '생각공장 주차권');
  assert.equal(initial.items[0].source, 'report');

  // 2. Add todo
  assert.throws(() => service.add({}), { code: 'INVALID_REQUEST' });
  const added = service.add({
    title: '전기요금 영수증 제출',
    dueDate: '2026-11-27',
    taskRef: 'fixed:electric',
  });
  assert.ok(added.id);
  assert.equal(added.title, '전기요금 영수증 제출');
  assert.equal(added.completed, false);
  assert.equal(added.source, 'user');

  // 3. Toggle todo (completed -> true, triggers ledger recording)
  const toggled = service.toggle(added.id, true);
  assert.equal(toggled.completed, true);
  assert.ok(toggled.completedAt);
  assert.ok(recorded);
  assert.equal(recorded.taskRef, 'fixed:electric');
  assert.equal(recorded.action, 'completed');

  // 4. Toggle back (completed -> false)
  const untoggled = service.toggle(added.id, false);
  assert.equal(untoggled.completed, false);
  assert.equal(untoggled.completedAt, null);

  // 5. Remove todo
  const removed = service.remove(added.id);
  assert.equal(removed.removed, true);
  assert.throws(() => service.get(added.id), { code: 'NOT_FOUND' });
});

test('HTTP API & Session proxy for todos', async () => {
  const token = 'e'.repeat(64);
  const pairingCode = 'f'.repeat(64);
  const todoService = new WorkspaceTodoService();
  const control = createApi({ todoService, token, port: 0 });
  const controlAddr = await control.listen();

  const session = createSessionBackend({
    controlUrl: `http://127.0.0.1:${controlAddr.port}`,
    controlToken: token,
    pairingCode,
    pairingExpiresAt: Date.now() + 60000,
    uiOrigin: 'http://127.0.0.1:5173',
    port: 0,
  });
  const sessionAddr = await session.listen();

  try {
    const pairRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ code: pairingCode }),
    });
    const cookie = pairRes.headers.get('set-cookie');
    const { data: { csrfToken } } = await pairRes.json();
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:5173',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken,
    };

    // GET /api/todos
    const listRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/todos`, { headers: { Origin: 'http://127.0.0.1:5173', Cookie: cookie, 'X-CSRF-Token': csrfToken } });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.data.items.length, 2);

    // POST /api/todos
    const addRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/todos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '신규 할 일',
        dueDate: '2026-11-29',
      }),
    });
    assert.equal(addRes.status, 201);
    const addJson = await addRes.json();
    const newId = addJson.data.id;

    // PATCH /api/todos/:id
    const patchRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/todos/${newId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ completed: true }),
    });
    assert.equal(patchRes.status, 200);
    const patchJson = await patchRes.json();
    assert.equal(patchJson.data.completed, true);

    // DELETE /api/todos/:id
    const delRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/todos/${newId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);
  } finally {
    await session.close();
    await control.close();
  }
});
