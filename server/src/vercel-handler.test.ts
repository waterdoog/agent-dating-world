import assert from 'node:assert/strict';
import test from 'node:test';
import { handler, resolveRequestUrl } from '../../api/handler.js';
import { app } from './index.js';

test('Vercel relative request URLs resolve against the configured public origin', () => {
  const url = resolveRequestUrl('/api/health?__route=%2Fapi%2Fhealth&path=health');

  assert.equal(url.pathname, '/api/health');
  assert.equal(url.searchParams.get('__route'), '/api/health');
});

test('Vercel relative requests reach the intended Hono route', async () => {
  const request = new Request('https://example.test/api/handler?__route=%2Fapi%2Fhealth');
  Object.defineProperty(request, 'url', {
    value: '/api/handler?__route=%2Fapi%2Fhealth&path=health',
  });

  const response = await handler(request);
  const payload = (await response.json()) as { ok?: boolean };

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

test('world mutation routes are authenticated and the legacy fights route is gone', async () => {
  const scheduler = await app.request('/api/world/run', { method: 'POST' });
  assert.equal(scheduler.status, 401);
  assert.deepEqual(await scheduler.json(), {
    error: true,
    message: 'Not signed in (or session expired).',
  });

  const ready = await app.request('/api/world/ready', {
    method: 'POST',
    body: JSON.stringify({ mode: 'room', action: 'create' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(ready.status, 401);

  const leave = await app.request('/api/world/leave-queue', { method: 'POST' });
  assert.equal(leave.status, 401);

  const legacy = await app.request('/api/fights/join', { method: 'POST' });
  assert.equal(legacy.status, 404);
  assert.deepEqual(await legacy.json(), {
    error: true,
    message: 'API route not found.',
  });
});

test('leaderboard requires an authenticated Aicoo player', async () => {
  const response = await app.request('/api/leaderboard');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: true,
    message: 'Not signed in (or session expired).',
  });
});
