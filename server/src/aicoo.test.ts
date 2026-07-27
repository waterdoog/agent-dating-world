import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AicooError,
  createShareLink,
  listFoldersByParentId,
  messageAnonymousScopedAgent,
  parseRetryAfterMs,
  revokeShareLink,
  streamAnonymousScopedAgent,
} from './aicoo.js';
import { APP_SCOPES } from './config.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('Aicoo login grants identity only, never the player workspace', () => {
  assert.deepEqual(APP_SCOPES, ['openid', 'profile', 'offline_access']);
});

test('Retry-After parser accepts seconds and HTTP-date values', () => {
  const nowMs = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('12', nowMs), 12_000);
  assert.equal(
    parseRetryAfterMs('Wed, 21 Oct 2015 07:28:45 GMT', nowMs),
    45_000
  );
  assert.equal(parseRetryAfterMs('not-a-retry-date', nowMs), undefined);
});

test('operator JSON errors expose Aicoo Retry-After seconds', async () => {
  globalThis.fetch = (async () =>
    new Response('operator quota reached', {
      status: 429,
      headers: { 'Retry-After': '9' },
    })) as typeof fetch;

  await assert.rejects(
    listFoldersByParentId('operator-key', 42),
    (error: unknown) => {
      assert.ok(error instanceof AicooError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 9_000);
      return true;
    }
  );
});

test('guest JSON errors expose Aicoo Retry-After HTTP dates', async () => {
  const retryAt = new Date(Date.now() + 60_000);
  globalThis.fetch = (async () =>
    new Response('guest quota reached', {
      status: 429,
      headers: { 'Retry-After': retryAt.toUTCString() },
    })) as typeof fetch;

  await assert.rejects(
    messageAnonymousScopedAgent({
      token: 'fresh-encounter-token',
      message: 'Wait for the next quota window.',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AicooError);
      assert.equal(error.status, 429);
      assert.ok(
        error.retryAfterMs !== undefined
          && error.retryAfterMs >= 58_000
          && error.retryAfterMs <= 60_000
      );
      return true;
    }
  );
});

test('initial stream errors expose Aicoo Retry-After metadata', async () => {
  globalThis.fetch = (async () =>
    new Response('stream quota reached', {
      status: 429,
      headers: { 'Retry-After': '3' },
    })) as typeof fetch;

  await assert.rejects(
    streamAnonymousScopedAgent({
      token: 'fresh-encounter-token',
      message: 'Stream after the quota window.',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AicooError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 3_000);
      return true;
    }
  );
});

test('role-folder checks can enumerate direct child folders', async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      String(input),
      'https://www.aicoo.io/api/v1/os/folders?parentId=42'
    );
    assert.equal(init?.method, 'GET');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Bearer operator-key'
    );
    return new Response(
      JSON.stringify({
        folders: [
          { id: 43, name: 'Unexpected child', parentId: 42 },
          { id: 99, name: 'Unrelated shared folder', parentId: 7 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  assert.deepEqual(await listFoldersByParentId('operator-key', 42), [
    { id: 43, name: 'Unexpected child', parentId: 42 },
  ]);
});

test('encounter links pin the synthetic capsule note and allow anonymous runtime only', async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://www.aicoo.io/api/v1/os/share');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer operator-key');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      scope: 'folders',
      access: 'read',
      notesAccess: 'read',
      folderIds: [42],
      noteId: 43,
      label: 'Virtual N1 alpha enc-1',
      expiresIn: '1h',
      requireSignIn: false,
      identity: { loadCoo: false, loadUser: false, loadPolicy: false },
      email: { read: false },
      todos: { read: false, create: false },
      tools: { allowedTools: [] },
      linkPolicy: 'Locked synthetic policy',
    });
    return new Response(
      JSON.stringify({
        shareLink: {
          id: 'encounter-link',
          token: 'encounter-token',
          url: 'https://www.aicoo.io/a/encounter-token',
          requireSignIn: false,
          requireSignInForced: false,
        },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  await createShareLink('operator-key', {
    folderId: 42,
    noteId: 43,
    label: 'Virtual N1 alpha enc-1',
    linkPolicy: 'Locked synthetic policy',
    expiresIn: '1h',
    requireSignIn: false,
    allowedTools: [],
  });
});

test('encounter links fail closed and revoke when Aicoo forces sign-in', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          shareLink: {
            id: 'forced-link',
            token: 'forced-token',
            url: 'https://www.aicoo.io/a/forced-token',
            requireSignIn: true,
            requireSignInForced: true,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    createShareLink('operator-key', {
      folderId: 42,
      noteId: 43,
      label: 'Virtual N1 forced link',
      linkPolicy: 'Locked synthetic policy',
      requireSignIn: false,
      allowedTools: [],
    }),
    /did not grant an anonymous isolated Fighter capability/
  );
  assert.deepEqual(requests, [
    { url: 'https://www.aicoo.io/api/v1/os/share', method: 'POST' },
    {
      url: 'https://www.aicoo.io/api/v1/os/share/forced-link',
      method: 'DELETE',
    },
  ]);
});

test('anonymous encounter turns send no Authorization or Cookie header', async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://www.aicoo.io/api/chat/guest-v04');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      token: 'fresh-encounter-token',
      message: 'Hello, other Fighter.',
      stream: false,
      mode: 'agent',
    });
    return new Response(
      JSON.stringify({
        sessionKey: 'anonymous-session',
        agentName: 'Virtual N1 Fighter',
        ownerName: 'Virtual N1 World',
        response: 'Hello from the grid.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const response = await messageAnonymousScopedAgent({
    token: 'fresh-encounter-token',
    message: 'Hello, other Fighter.',
  });
  assert.equal(response.response, 'Hello from the grid.');
});

test('anonymous encounter turns reject malformed Aicoo responses', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ response: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(
    messageAnonymousScopedAgent({
      token: 'fresh-encounter-token',
      message: 'Hello, other Fighter.',
    }),
    /invalid Fighter response/
  );
});

test('anonymous encounter streams parse NDJSON deltas without duplicate legacy content', async () => {
  const encoder = new TextEncoder();
  const deltas: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://www.aicoo.io/api/chat/guest-v04');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.Cookie, undefined);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      token: 'fresh-encounter-token',
      message: 'Stream the attack.',
      stream: true,
      mode: 'agent',
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"sessionKey":"anonymous-session"}\n'
            + '{"type":"text-delta","textDelta":"Paper "}\n'
            + '{"content":"Paper "}\n'
          ));
          controller.enqueue(encoder.encode(
            '{"type":"text-delta","textDelta":"strike."}\n'
            + '{"content":"strike."}\n'
            + '{"type":"completion","metadata":{"elapsedMs":321,"terminationReason":"complete"}}\n'
          ));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }) as typeof fetch;

  const response = await streamAnonymousScopedAgent({
    token: 'fresh-encounter-token',
    message: 'Stream the attack.',
    onDelta: ({ delta }) => {
      deltas.push(delta);
    },
  });
  assert.deepEqual(deltas, ['Paper ', 'strike.']);
  assert.equal(response.response, 'Paper strike.');
  assert.equal(response.sessionKey, 'anonymous-session');
  assert.equal(response.elapsedMs, 321);
});

test('anonymous encounter streams fail closed before a completion event', async () => {
  globalThis.fetch = (async () =>
    new Response(
      '{"sessionKey":"anonymous-session"}\n'
      + '{"type":"text-delta","textDelta":"unfinished"}\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )) as typeof fetch;

  await assert.rejects(
    streamAnonymousScopedAgent({
      token: 'fresh-encounter-token',
      message: 'This stream will stop early.',
    }),
    /ended before completion/
  );
});

test('anonymous encounter streams reject unsuccessful terminal reasons', async () => {
  globalThis.fetch = (async () =>
    new Response(
      '{"sessionKey":"anonymous-session"}\n'
      + '{"type":"text-delta","textDelta":"partial answer"}\n'
      + '{"type":"completion","metadata":{"terminationReason":"total_timeout"}}\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )) as typeof fetch;

  await assert.rejects(
    streamAnonymousScopedAgent({
      token: 'fresh-encounter-token',
      message: 'This execution times out.',
    }),
    /did not complete successfully/
  );
});

test('encounter share capabilities can be revoked after the fixed rounds', async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://www.aicoo.io/api/v1/os/share/link-to-revoke');
    assert.equal(init?.method, 'DELETE');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer operator-key');
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await revokeShareLink('operator-key', 'link-to-revoke');
});
