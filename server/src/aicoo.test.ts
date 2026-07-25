import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShareLink,
  listFoldersByParentId,
  messageAnonymousScopedAgent,
  revokeShareLink,
} from './aicoo.js';
import { APP_SCOPES } from './config.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('Aicoo login grants identity only, never the player workspace', () => {
  assert.deepEqual(APP_SCOPES, ['openid', 'profile', 'offline_access']);
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
