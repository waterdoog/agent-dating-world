import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, WorldRateLimitError } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('world stream preserves Aicoo rate-limit retry metadata', async () => {
  globalThis.fetch = (async () => new Response(
    `${JSON.stringify({
      type: 'error',
      code: 'aicoo_rate_limit',
      message: 'Aicoo is rate limiting the world.',
      retryAfterMs: 4_000,
    })}\n`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )) as typeof fetch;

  const startedAt = Date.now();
  await assert.rejects(api.runWorld(), (error: unknown) => {
    assert.ok(error instanceof WorldRateLimitError);
    assert.equal(error.message, 'Aicoo is rate limiting the world.');
    assert.ok(error.retryAtMs >= startedAt + 4_000);
    assert.ok(error.retryAtMs <= Date.now() + 4_000);
    return true;
  });
});

test('world stream keeps ordinary scheduler failures as regular errors', async () => {
  globalThis.fetch = (async () => new Response(
    `${JSON.stringify({
      type: 'error',
      message: 'The server scheduler paused this match.',
    })}\n`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )) as typeof fetch;

  await assert.rejects(api.runWorld(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof WorldRateLimitError, false);
    assert.equal(error.message, 'The server scheduler paused this match.');
    return true;
  });
});
