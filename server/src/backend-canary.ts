import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AicooError,
  createShareLink,
  ensureFolder,
  messageAnonymousScopedAgent,
  revokeShareLink,
  upsertNote,
} from './aicoo.js';
import { config } from './config.js';

const CANARY_FOLDER = 'Virtual N1 World/Canaries/Backend Message';
const CANARY_NOTE = 'MESSAGE_CANARY.md';

type CanaryStage =
  | 'configuration'
  | 'synthetic-context'
  | 'scoped-capability'
  | 'agent-message'
  | 'revocation'
  | 'revocation-check';

let stage: CanaryStage = 'configuration';

function sanitizedFailure(error: unknown): {
  ok: false;
  stage: CanaryStage;
  error: string;
  status?: number;
} {
  if (error instanceof AicooError) {
    return {
      ok: false,
      stage,
      error: 'Aicoo request failed',
      status: error.status,
    };
  }

  return {
    ok: false,
    stage,
    error: error instanceof Error ? error.message : 'Unknown backend canary failure',
  };
}

async function runBackendCanary(): Promise<void> {
  assert.ok(
    config.operatorApiKey,
    'Missing AICOO_OPERATOR_API_KEY; the live backend canary was not run.'
  );

  const marker = `N1_CANARY_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const noteContent = [
    '# Virtual N1 backend message canary',
    '',
    'This note contains synthetic test data only.',
    `STATUS_CODE=${marker}`,
  ].join('\n');

  stage = 'synthetic-context';
  const folderId = await ensureFolder(config.operatorApiKey, CANARY_FOLDER);
  const noteId = await upsertNote(
    config.operatorApiKey,
    CANARY_FOLDER,
    CANARY_NOTE,
    noteContent
  );

  stage = 'scoped-capability';
  const link = await createShareLink(config.operatorApiKey, {
    folderId,
    noteId,
    label: `Virtual N1 backend canary ${new Date().toISOString()}`,
    expiresIn: '1h',
    requireSignIn: false,
    allowedTools: [],
    linkPolicy: [
      'You are a sealed Virtual N1 backend canary.',
      'Use only the single synthetic canary note in this scoped session.',
      'Never request or infer identity, personal memory, credentials, or tools.',
      'When asked for STATUS_CODE, reply with only its exact value.',
    ].join(' '),
  });

  let revoked = false;
  try {
    stage = 'agent-message';
    const startedAt = performance.now();
    const reply = await messageAnonymousScopedAgent({
      token: link.token,
      message:
        'Read the synthetic canary note. Reply with only the value after STATUS_CODE=.',
    });
    const elapsedMs = Math.round(performance.now() - startedAt);

    assert.ok(
      reply.response.includes(marker),
      'Aicoo returned a message, but it did not contain the current synthetic canary marker.'
    );

    stage = 'revocation';
    await revokeShareLink(config.operatorApiKey, link.id);
    revoked = true;

    stage = 'revocation-check';
    let postRevokeError: unknown;
    try {
      await messageAnonymousScopedAgent({
        token: link.token,
        message: 'This message must be rejected because the capability was revoked.',
      });
    } catch (error) {
      postRevokeError = error;
    }

    assert.ok(
      postRevokeError instanceof AicooError,
      'Aicoo accepted a message after the scoped capability was revoked.'
    );
    assert.equal(
      postRevokeError.status,
      404,
      `Expected a revoked capability to return 404, received ${postRevokeError.status}.`
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          syntheticContext: true,
          anonymousScopedCapability: true,
          messageReceived: true,
          responseCharacters: reply.response.length,
          elapsedMs,
          revoked: true,
          postRevokeStatus: postRevokeError.status,
        },
        null,
        2
      )
    );
  } finally {
    if (!revoked) {
      await revokeShareLink(config.operatorApiKey, link.id).catch(() => undefined);
    }
  }
}

runBackendCanary().catch((error: unknown) => {
  console.error(JSON.stringify(sanitizedFailure(error), null, 2));
  process.exitCode = 1;
});
