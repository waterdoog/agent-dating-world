import assert from 'node:assert/strict';
import {
  AicooError,
  createShareLink,
  ensureFolder,
  listFoldersByParentId,
  listNotesByFolderId,
  messageAnonymousScopedAgent,
  revokeShareLink,
  upsertNote,
} from './aicoo.js';
import { config } from './config.js';
import {
  DEFAULT_ATTACK_POLICY,
  DEFAULT_DEFENSE_POLICY,
  type FighterIdentityDraft,
} from './fighter-world-core.js';
import {
  attackTurnPromptForTests,
  restoreFighterLinkPolicy,
  roleRuntimePolicyForTests,
} from './fighter-world.js';

const CANARY_FOLDER = 'Virtual N1 World/Canaries/Fighter Language/Attack';
const CANARY_NOTE = 'Attack Policy v1';
const REFUSAL =
  /\b(?:i\s+can(?:not|[’']?t)\s+(?:help|assist|participate)|i\s+(?:must|have to)\s+decline|(?:unable|not able)\s+to\s+(?:help|assist|participate)|won[’']?t\s+(?:help|participate|play)|not\s+(?:going to|gonna)\s+(?:help|play))\b/i;

type CanaryStage =
  | 'configuration'
  | 'synthetic-policy'
  | 'scoped-capability'
  | 'policy-restore'
  | 'attack-message'
  | 'revocation'
  | 'revocation-check';

let stage: CanaryStage = 'configuration';

function canaryFighter(
  id: string,
  handle: string,
  attackPolicy = DEFAULT_ATTACK_POLICY
): FighterIdentityDraft {
  return {
    id,
    handle,
    displayName: handle,
    joinedAt: '2026-01-01T00:00:00.000Z',
    draftId: 'synthetic-language-canary',
    attackPolicy,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
    policyRevision: 1,
    pendingPolicy: null,
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'amber-lantern-1001' },
      { id: 'hideout', label: 'Hideout', value: 'hidden-orchid-2002' },
      { id: 'relic', label: 'Relic', value: 'copper-comet-3003' },
    ],
    locked: true,
    phase: 'waiting',
    queueOrder: 1,
    currentGameId: null,
    capsule: {
      attackFolderId: 1,
      attackPolicyNoteId: 2,
      defenseFolderId: 3,
      defensePolicyNoteId: 4,
      vaultNoteId: 5,
    },
  };
}

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
    error: error instanceof Error ? error.message : 'Unknown Fighter language failure',
  };
}

async function runFighterLanguageCanary(): Promise<void> {
  assert.ok(
    config.operatorApiKey,
    'Missing AICOO_OPERATOR_API_KEY; the live Fighter language canary was not run.'
  );

  const attacker = canaryFighter('canary-attacker', 'Canary Challenger');
  const defender = canaryFighter('canary-defender', 'Canary Responder');

  stage = 'synthetic-policy';
  const folderId = await ensureFolder(config.operatorApiKey, CANARY_FOLDER);
  const noteId = await upsertNote(
    config.operatorApiKey,
    CANARY_FOLDER,
    CANARY_NOTE,
    `# Player Attack Policy\n\n${attacker.attackPolicy}\n`
  );
  const [notes, childFolders] = await Promise.all([
    listNotesByFolderId(config.operatorApiKey, folderId),
    listFoldersByParentId(config.operatorApiKey, folderId),
  ]);
  assert.deepEqual(childFolders, [], 'The canary attack folder must be a leaf.');
  assert.deepEqual(
    notes.map((note) => ({ id: note.id, title: note.title })),
    [{ id: noteId, title: CANARY_NOTE }],
    'The canary attack folder must contain only its locked policy note.'
  );

  stage = 'scoped-capability';
  const linkPolicy = roleRuntimePolicyForTests(attacker, 'attack');
  const link = await createShareLink(config.operatorApiKey, {
    folderId,
    noteId,
    label: `Virtual N1 Fighter language canary ${new Date().toISOString()}`,
    expiresIn: '1h',
    requireSignIn: false,
    allowedTools: [],
    linkPolicy,
  });

  let revoked = false;
  try {
    stage = 'policy-restore';
    await restoreFighterLinkPolicy(link.token, linkPolicy);
    stage = 'attack-message';
    const startedAt = performance.now();
    const reply = await messageAnonymousScopedAgent({
      token: link.token,
      message: attackTurnPromptForTests(attacker, defender, 1, 3),
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    const refusalDetected = REFUSAL.test(reply.response);

    assert.equal(
      refusalDetected,
      false,
      'Aicoo returned a refusal instead of an in-character attack line.'
    );

    stage = 'revocation';
    await revokeShareLink(config.operatorApiKey, link.id);
    revoked = true;

    stage = 'revocation-check';
    let postRevokeError: unknown;
    try {
      await messageAnonymousScopedAgent({
        token: link.token,
        message: 'This turn must be rejected because the capability was revoked.',
      });
    } catch (error) {
      postRevokeError = error;
    }
    assert.ok(postRevokeError instanceof AicooError);
    assert.equal(postRevokeError.status, 404);

    const showSample = process.env.FIGHTER_CANARY_SHOW_SAMPLE === '1';
    console.log(
      JSON.stringify(
        {
          ok: true,
          anonymousScopedCapability: true,
          attackMessageReceived: true,
          refusalDetected,
          responseCharacters: reply.response.length,
          elapsedMs,
          revoked,
          postRevokeStatus: postRevokeError.status,
          ...(showSample ? { sampleAttack: reply.response } : {}),
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

runFighterLanguageCanary().catch((error: unknown) => {
  console.error(JSON.stringify(sanitizedFailure(error), null, 2));
  process.exitCode = 1;
});
