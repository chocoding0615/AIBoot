import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSpaceService } from '../spaces.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

test('WorkspaceSpaceService - list, add, update, remove, and verify', async () => {
  const service = new WorkspaceSpaceService();

  // 1. List default spaces
  const initial = service.list();
  assert.equal(initial.items.length, 2);
  assert.equal(initial.items[0].name, '업무 공유 (운영)');

  // 2. Add space
  assert.throws(() => service.add({}), { code: 'INVALID_REQUEST' });
  assert.throws(() => service.add({ name: '테스트', url: 'invalid-url' }), { code: 'INVALID_URL' });

  const added = service.add({
    name: '계약 관리 스페이스',
    url: 'https://chat.google.com/room/XXXXYYYYZZZZ',
    agents: ['general', 'contracts'],
  });
  assert.ok(added.id);
  assert.equal(added.name, '계약 관리 스페이스');
  assert.equal(added.spaceId, 'XXXXYYYYZZZZ');
  assert.equal(added.enabled, false); // Safe default
  assert.equal(added.status, 'unverified');

  // 3. Update space (enable & modify agents)
  const updated = service.update(added.id, { enabled: true, agents: ['contracts'] });
  assert.equal(updated.enabled, true);
  assert.deepEqual(updated.agents, ['contracts']);

  // 4. Verify space
  const verified = await service.verify(added.id);
  assert.equal(verified.verified, true);
  assert.equal(verified.status, 'connected');

  // 5. Remove space
  const removed = service.remove(added.id);
  assert.equal(removed.removed, true);
  assert.throws(() => service.get(added.id), { code: 'NOT_FOUND' });
});

test('HTTP API & Session proxy for spaces', async () => {
  const token = 'c'.repeat(64);
  const pairingCode = 'd'.repeat(64);
  const spaceService = new WorkspaceSpaceService();
  const control = createApi({ spaceService, token, port: 0 });
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
    // Session login
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

    // GET /api/spaces
    const listRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/spaces`, { headers: { Origin: 'http://127.0.0.1:5173', Cookie: cookie, 'X-CSRF-Token': csrfToken } });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.data.items.length, 2);

    // POST /api/spaces
    const addRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/spaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '신규 스페이스',
        url: 'https://chat.google.com/room/NEWSPACE123',
        agents: ['fixed'],
      }),
    });
    assert.equal(addRes.status, 201);
    const addJson = await addRes.json();
    const newId = addJson.data.id;

    // PATCH /api/spaces/:id
    const patchRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/spaces/${newId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(patchRes.status, 200);
    const patchJson = await patchRes.json();
    assert.equal(patchJson.data.enabled, true);

    // POST /api/spaces/:id/verify
    const verifyRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/spaces/${newId}/verify`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(verifyRes.status, 200);

    // DELETE /api/spaces/:id
    const delRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/spaces/${newId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);
  } finally {
    await session.close();
    await control.close();
  }
});
