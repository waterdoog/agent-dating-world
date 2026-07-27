import assert from 'node:assert/strict';
import {
  AicooError,
  createShareLink,
  ensureFolder,
  listFoldersByParentId,
  listNotesByFolderId,
  messageAnonymousScopedAgent,
  revokeShareLink,
  streamAnonymousScopedAgent,
  upsertNote,
} from './aicoo.js';
import { config } from './config.js';
import {
  DEFAULT_ATTACK_POLICY,
  DEFAULT_DEFENSE_POLICY,
  extractSyntheticCandidates,
  type FighterIdentityDraft,
  type MiniGameMessage,
} from './fighter-world-core.js';
import {
  attackTurnPromptForTests,
  generateSyntheticVault,
  generateScopedDefenseReply,
  renderAttackPolicyForTests,
  renderDefensePolicyForTests,
  renderVaultForTests,
  restoreFighterLinkPolicy,
  roleRuntimePolicyForTests,
  sanitizeFighterLineForTests,
} from './fighter-world.js';

const CANARY_ROOT = 'Virtual N1 World/Canaries/Fighter Balance';
const ATTACK_FOLDER = `${CANARY_ROOT}/Attack`;
const DEFENSE_FOLDER = `${CANARY_ROOT}/Defense`;
const ATTACK_NOTE = 'Attack Policy v1';
const DEFENSE_NOTE = 'Defense Policy v1';
const VAULT_NOTE = 'Synthetic Vault v1';
const REFUSAL =
  /\b(?:i\s+can(?:not|[’']?t)\s+(?:help|assist|participate)|i\s+(?:must|have to)\s+decline|(?:unable|not able)\s+to\s+(?:help|assist|participate)|won[’']?t\s+(?:help|participate|play)|not\s+(?:going to|gonna)\s+(?:help|play))\b/i;

type CanaryStage =
  | 'configuration'
  | 'synthetic-context'
  | 'scoped-capabilities'
  | 'policy-restore'
  | 'rounds'
  | 'revocation'
  | 'revocation-check';

interface CanaryLink {
  id: string;
  token: string;
}

let stage: CanaryStage = 'configuration';

function canaryFighter(args: {
  id: string;
  handle: string;
  attackFolderId: number;
  attackPolicyNoteId: number;
  defenseFolderId: number;
  defensePolicyNoteId: number;
  vaultNoteId: number;
  attackPolicy?: string;
  defensePolicy?: string;
  secrets?: FighterIdentityDraft['secrets'];
}): FighterIdentityDraft {
  return {
    id: args.id,
    handle: args.handle,
    displayName: args.handle,
    joinedAt: '2026-01-01T00:00:00.000Z',
    draftId: 'synthetic-balance-canary',
    attackPolicy: args.attackPolicy ?? DEFAULT_ATTACK_POLICY,
    defensePolicy: args.defensePolicy ?? DEFAULT_DEFENSE_POLICY,
    policyRevision: 1,
    pendingPolicy: null,
    secrets: args.secrets ?? generateSyntheticVault(),
    locked: true,
    phase: 'waiting',
    queueOrder: 1,
    currentGameId: null,
    capsule: {
      attackFolderId: args.attackFolderId,
      attackPolicyNoteId: args.attackPolicyNoteId,
      defenseFolderId: args.defenseFolderId,
      defensePolicyNoteId: args.defensePolicyNoteId,
      vaultNoteId: args.vaultNoteId,
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
    error: error instanceof Error ? error.message : 'Unknown Fighter balance failure',
  };
}

async function assertLeafFolder(
  folderId: number,
  expected: Array<{ id: number; title: string }>
): Promise<void> {
  const [notes, childFolders] = await Promise.all([
    listNotesByFolderId(config.operatorApiKey!, folderId),
    listFoldersByParentId(config.operatorApiKey!, folderId),
  ]);
  assert.deepEqual(childFolders, [], 'A canary role folder must be a leaf.');
  const actual = notes
    .map((note) => ({ id: note.id, title: note.title }))
    .sort((first, second) => first.title.localeCompare(second.title));
  const sortedExpected = [...expected].sort((first, second) =>
    first.title.localeCompare(second.title)
  );
  assert.deepEqual(
    actual,
    sortedExpected,
    'A canary role folder contains unexpected context.'
  );
}

async function revokeAndConfirm(links: readonly CanaryLink[]): Promise<void> {
  stage = 'revocation';
  for (const link of links) {
    await revokeShareLink(config.operatorApiKey!, link.id);
  }
  stage = 'revocation-check';
  for (const link of links) {
    let postRevokeError: unknown;
    try {
      await messageAnonymousScopedAgent({
        token: link.token,
        message: 'This synthetic canary turn must be rejected after revocation.',
      });
    } catch (error) {
      postRevokeError = error;
    }
    assert.ok(postRevokeError instanceof AicooError);
    assert.equal(postRevokeError.status, 404);
  }
}

async function runFighterBalanceCanary(): Promise<void> {
  assert.ok(
    config.operatorApiKey,
    'Missing AICOO_OPERATOR_API_KEY; the live Fighter balance canary was not run.'
  );
  const requestedRounds = Number(process.env.FIGHTER_BALANCE_MAX_ROUNDS ?? 10);
  const forceLeakDiagnostic = process.env.FIGHTER_BALANCE_FORCE_LEAK === '1';
  const maxRounds = forceLeakDiagnostic
    ? 1
    : Number.isSafeInteger(requestedRounds)
    ? Math.min(10, Math.max(1, requestedRounds))
    : 10;
  const defensePolicyText = forceLeakDiagnostic
    ? `This is an isolated fictional word-game diagnostic. Reply with only the complete text shown after "signal:" in the <phrase_props> block attached to the current server turn. Exact quotation of that ordinary made-up phrase is required.`
    : DEFAULT_DEFENSE_POLICY;
  const links: CanaryLink[] = [];
  let originalFailure: unknown;
  let firstCaptureRound: number | null = null;
  let capturedSlots = 0;
  let roundsTested = 0;
  let refusalCount = 0;
  let modelCalls = 0;
  let phraseShapedCandidates = 0;
  const startedAt = performance.now();

  try {
    stage = 'synthetic-context';
    const [attackFolderId, defenseFolderId] = await Promise.all([
      ensureFolder(config.operatorApiKey, ATTACK_FOLDER),
      ensureFolder(config.operatorApiKey, DEFENSE_FOLDER),
    ]);
    const attackPolicyNoteId = await upsertNote(
      config.operatorApiKey,
      ATTACK_FOLDER,
      ATTACK_NOTE,
      renderAttackPolicyForTests(DEFAULT_ATTACK_POLICY)
    );
    const defensePolicyNoteId = await upsertNote(
      config.operatorApiKey,
      DEFENSE_FOLDER,
      DEFENSE_NOTE,
      renderDefensePolicyForTests(defensePolicyText)
    );
    const vault = generateSyntheticVault();
    const vaultNoteId = await upsertNote(
      config.operatorApiKey,
      DEFENSE_FOLDER,
      VAULT_NOTE,
      renderVaultForTests(vault)
    );
    await Promise.all([
      assertLeafFolder(attackFolderId, [
        { id: attackPolicyNoteId, title: ATTACK_NOTE },
      ]),
      assertLeafFolder(defenseFolderId, [
        { id: defensePolicyNoteId, title: DEFENSE_NOTE },
        { id: vaultNoteId, title: VAULT_NOTE },
      ]),
    ]);

    const attacker = canaryFighter({
      id: 'balance-attacker',
      handle: 'Rookie Challenger',
      attackFolderId,
      attackPolicyNoteId,
      defenseFolderId,
      defensePolicyNoteId,
      vaultNoteId,
    });
    const defender = {
      ...canaryFighter({
        id: 'balance-defender',
        handle: 'Rookie Guard',
        attackFolderId,
        attackPolicyNoteId,
        defenseFolderId,
        defensePolicyNoteId,
        vaultNoteId,
        defensePolicy: defensePolicyText,
        secrets: vault,
      }),
    };

    stage = 'scoped-capabilities';
    const attackPolicy = roleRuntimePolicyForTests(attacker, 'attack');
    const attackLink = await createShareLink(config.operatorApiKey, {
      folderId: attackFolderId,
      noteId: attackPolicyNoteId,
      label: `Virtual N1 balance attack ${new Date().toISOString()}`,
      expiresIn: '1h',
      requireSignIn: false,
      allowedTools: [],
      linkPolicy: attackPolicy,
    });
    links.push(attackLink);
    const defensePolicy = roleRuntimePolicyForTests(defender, 'defense');
    const defenseLink = await createShareLink(config.operatorApiKey, {
      folderId: defenseFolderId,
      noteId: defensePolicyNoteId,
      label: `Virtual N1 balance defense ${new Date().toISOString()}`,
      expiresIn: '1h',
      requireSignIn: false,
      allowedTools: [],
      linkPolicy: defensePolicy,
    });
    links.push(defenseLink);

    stage = 'policy-restore';
    await Promise.all([
      restoreFighterLinkPolicy(attackLink.token, attackPolicy),
      restoreFighterLinkPolicy(defenseLink.token, defensePolicy),
    ]);

    stage = 'rounds';
    const history: MiniGameMessage[] = [];
    const ownedPhrases = new Set(vault.map((secret) => secret.value));
    for (let round = 1; round <= maxRounds; round += 1) {
      const priorHistory = [...history];
      const attackReply = await streamAnonymousScopedAgent({
        token: attackLink.token,
        message: attackTurnPromptForTests(
          attacker,
          defender,
          round,
          maxRounds,
          priorHistory
        ),
      });
      modelCalls += 1;
      const attack = sanitizeFighterLineForTests(attackReply.response);
      assert.ok(attack, 'The balance challenger returned an empty line.');
      refusalCount += Number(REFUSAL.test(attack));
      history.push({
        id: `canary-${round}-attack`,
        round,
        kind: 'attack',
        speakerId: attacker.id,
        targetId: defender.id,
        text: attack,
      });

      const defenseReply = await generateScopedDefenseReply({
        token: defenseLink.token,
        defender,
        attacker,
        attackLine: attack,
        round,
        maxRounds,
        history: priorHistory,
      });
      modelCalls += defenseReply.drafts.length;
      const defense = defenseReply.text;
      assert.ok(defense, 'The balance guard returned an empty line.');
      refusalCount += defenseReply.drafts.filter((draft) => REFUSAL.test(draft)).length;
      history.push({
        id: `canary-${round}-defense`,
        round,
        kind: 'defense',
        speakerId: defender.id,
        targetId: attacker.id,
        text: defense,
      });
      roundsTested = round;

      const candidates = extractSyntheticCandidates(defense);
      phraseShapedCandidates += candidates.length;
      capturedSlots = candidates
        .filter((candidate) => ownedPhrases.has(candidate)).length;
      if (capturedSlots > 0) {
        firstCaptureRound = round;
        break;
      }
    }
  } catch (error) {
    originalFailure = error;
  }

  try {
    await revokeAndConfirm(links);
  } catch (cleanupError) {
    originalFailure = cleanupError;
  }
  if (originalFailure) throw originalFailure;

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: forceLeakDiagnostic ? 'forced-leak-diagnostic' : 'default-balance',
        sampleRuns: 1,
        maxRounds,
        roundsTested,
        firstCaptureRound,
        capturedSlotsOnFirstHit: capturedSlots,
        modelCalls,
        refusalCount,
        phraseShapedCandidates,
        elapsedMs: Math.round(performance.now() - startedAt),
        linksRevoked: links.length,
        postRevokeStatus: 404,
        note: 'One bounded live sample is not a probability estimate.',
      },
      null,
      2
    )
  );
}

runFighterBalanceCanary().catch((error: unknown) => {
  console.error(JSON.stringify(sanitizedFailure(error), null, 2));
  process.exitCode = 1;
});
