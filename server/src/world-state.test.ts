import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_ATTACK_POLICY,
  DEFAULT_DEFENSE_POLICY,
  MINI_GAME_ROUNDS,
  addFighterDraft,
  createPrivateFighterRoom,
  createMiniGameState,
  lockFighterForQueue,
  pairOldestReadyFighters,
  type FighterMiniGameState,
} from './fighter-world-core.js';
import {
  WorldStateIntegrityError,
  openWorldState,
  sealWorldState,
} from './database/world-state.js';

const FIRST_SECRET = 'first-test-arena-secret-with-enough-entropy';
const SECOND_SECRET = 'second-test-arena-secret-with-enough-entropy';

function authenticatedSnapshot(value: unknown): string {
  const plaintext = JSON.stringify(value);
  const salt = Buffer.from('virtual-n1-world-state-key-v1', 'utf8');
  const info = Buffer.from('fighter-mini-game-state/aes-256-gcm', 'utf8');
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(FIRST_SECRET, 'utf8'), salt, info, 32)
  );
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from('virtual-n1/fighter-mini-game-state/n1ws1', 'utf8')
  );
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  return [
    'n1ws1',
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

function populatedState(): FighterMiniGameState {
  return addFighterDraft(createMiniGameState(), {
    id: 'fighter-alpha',
    handle: 'alpha',
    displayName: 'Alpha',
    joinedAt: '2026-07-25T03:00:00.000Z',
    draftId: 'draft-alpha',
    attackPolicy: DEFAULT_ATTACK_POLICY,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'amber-lantern-0427' },
      { id: 'hideout', label: 'Hideout', value: 'frosted-harbor-9001' },
      { id: 'relic', label: 'Relic', value: 'lunar-quartz-1003' },
    ],
  });
}

function pairedState(): FighterMiniGameState {
  let state = populatedState();
  state = addFighterDraft(state, {
    id: 'fighter-bravo',
    handle: 'bravo',
    displayName: 'Bravo',
    joinedAt: '2026-07-25T03:01:00.000Z',
    draftId: 'draft-bravo',
    attackPolicy: DEFAULT_ATTACK_POLICY,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'hidden-orchid-1001' },
      { id: 'hideout', label: 'Hideout', value: 'copper-comet-1002' },
      { id: 'relic', label: 'Relic', value: 'juniper-riddle-1003' },
    ],
  });
  state = lockFighterForQueue(state, 'fighter-alpha', {
    attackFolderId: 1,
    attackPolicyNoteId: 2,
    defenseFolderId: 3,
    defensePolicyNoteId: 4,
    vaultNoteId: 5,
  });
  state = lockFighterForQueue(state, 'fighter-bravo', {
    attackFolderId: 6,
    attackPolicyNoteId: 7,
    defenseFolderId: 8,
    defensePolicyNoteId: 9,
    vaultNoteId: 10,
  });
  return pairOldestReadyFighters(
    state,
    '2026-07-25T03:02:00.000Z'
  ).state;
}

function legacyVersion2(state: FighterMiniGameState): {
  version: number;
  players: Array<Record<string, unknown>>;
  games: Array<Record<string, unknown>>;
  [key: string]: unknown;
} {
  const legacy = structuredClone(state) as unknown as {
    version: number;
    players: Array<Record<string, unknown>>;
    games: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  legacy.version = 2;
  for (const player of legacy.players) delete player.roomCode;
  for (const game of legacy.games) delete game.roomCode;
  return legacy;
}

test('world snapshots round-trip through authenticated encryption', () => {
  const state = populatedState();
  const first = sealWorldState(state, FIRST_SECRET);
  const second = sealWorldState(state, FIRST_SECRET);
  assert.notEqual(first, second, 'each seal must use a fresh nonce');
  assert.deepEqual(openWorldState(first, FIRST_SECRET), state);
  assert.deepEqual(openWorldState(second, FIRST_SECRET), state);
});

test('Simplified Chinese agent language round-trips without plaintext leakage', () => {
  const state = populatedState();
  state.players[0].agentLanguage = 'zh-CN';
  const sealed = sealWorldState(state, FIRST_SECRET);

  assert.doesNotMatch(sealed, /zh-CN/);
  assert.deepEqual(openWorldState(sealed, FIRST_SECRET), state);
});

test('legacy players without an agent language remain compatible as English', () => {
  const legacyState = structuredClone(populatedState());
  delete legacyState.players[0].agentLanguage;

  const opened = openWorldState(
    authenticatedSnapshot(legacyState),
    FIRST_SECRET
  );

  assert.equal(Object.hasOwn(opened.players[0], 'agentLanguage'), false);
  assert.equal(opened.players[0].agentLanguage ?? 'en', 'en');
  assert.deepEqual(opened, legacyState);
});

test('authenticated agent language values are strictly validated', () => {
  const state = populatedState();
  const invalidLanguages: unknown[] = ['zh', 'EN', '', null, false, 1];

  for (const agentLanguage of invalidLanguages) {
    const invalidState = structuredClone(state) as unknown as {
      players: Array<Record<string, unknown>>;
    };
    invalidState.players[0].agentLanguage = agentLanguage;
    assert.throws(
      () =>
        openWorldState(
          authenticatedSnapshot(invalidState),
          FIRST_SECRET
        ),
      WorldStateIntegrityError
    );
  }
});

test('sealed world snapshots contain no policy or synthetic value plaintext', () => {
  const state = populatedState();
  const sealed = sealWorldState(state, FIRST_SECRET);
  assert.doesNotMatch(sealed, /amber-lantern-0427/);
  assert.doesNotMatch(sealed, /Be charming, curious/);
  assert.doesNotMatch(sealed, /Protect every exact/);
  assert.match(sealed, /^n1ws1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('world snapshot opening fails closed on tampering or the wrong key', () => {
  const sealed = sealWorldState(populatedState(), FIRST_SECRET);
  const parts = sealed.split('.');
  const position = Math.floor(parts[2].length / 2);
  const replacement = parts[2][position] === 'A' ? 'B' : 'A';
  parts[2] =
    parts[2].slice(0, position) + replacement + parts[2].slice(position + 1);
  assert.throws(
    () => openWorldState(parts.join('.'), FIRST_SECRET),
    WorldStateIntegrityError
  );
  assert.throws(
    () => openWorldState(sealed, SECOND_SECRET),
    WorldStateIntegrityError
  );
});

test('authenticated but invalid state is rejected after decryption', () => {
  const invalid = {
    ...createMiniGameState(),
    version: 999,
  };
  assert.throws(
    () => openWorldState(authenticatedSnapshot(invalid), FIRST_SECRET),
    WorldStateIntegrityError
  );
});

test('legacy version-2 players are upgraded without losing stored state', () => {
  const state = populatedState();
  const legacyState = legacyVersion2(state);
  const legacyPlayer = legacyState.players[0];
  delete legacyPlayer.policyRevision;
  delete legacyPlayer.pendingPolicy;

  assert.deepEqual(
    openWorldState(authenticatedSnapshot(legacyState), FIRST_SECRET),
    state
  );
});

test('legacy active version-2 games upgrade from 3 to the current round count', () => {
  const currentState = pairedState();
  const legacyState = legacyVersion2(currentState);
  legacyState.games[0].maxRounds = 3;

  const opened = openWorldState(
    authenticatedSnapshot(legacyState),
    FIRST_SECRET
  );

  assert.equal(opened.games[0].status, 'playing');
  assert.equal(opened.games[0].maxRounds, MINI_GAME_ROUNDS);
  assert.deepEqual(opened.games[0], {
    ...currentState.games[0],
    maxRounds: MINI_GAME_ROUNDS,
  });
});

test('legacy completed version-2 games retain their historical 3 rounds', () => {
  const expected = pairedState();
  const game = expected.games[0];
  game.status = 'complete';
  game.round = 3;
  game.maxRounds = 3;
  game.completedAt = '2026-07-25T03:05:00.000Z';
  for (const player of expected.players) player.phase = 'complete';
  const legacyState = legacyVersion2(expected);

  const opened = openWorldState(
    authenticatedSnapshot(legacyState),
    FIRST_SECRET
  );

  assert.equal(opened.games[0].status, 'complete');
  assert.equal(opened.games[0].maxRounds, 3);
  assert.deepEqual(opened, expected);
});

test('private room codes round-trip encrypted and remain absent from sealed text', () => {
  const state = createPrivateFighterRoom(
    populatedState(),
    'fighter-alpha',
    {
      attackFolderId: 1,
      attackPolicyNoteId: 2,
      defenseFolderId: 3,
      defensePolicyNoteId: 4,
      vaultNoteId: 5,
    },
    ['ABC234']
  ).state;
  const sealed = sealWorldState(state, FIRST_SECRET);

  assert.doesNotMatch(sealed, /ABC234/);
  assert.deepEqual(openWorldState(sealed, FIRST_SECRET), state);
});

test('authenticated world state rejects duplicate private waiting codes', () => {
  let state = populatedState();
  state = addFighterDraft(state, {
    id: 'fighter-bravo',
    handle: 'bravo',
    displayName: 'Bravo',
    joinedAt: '2026-07-25T03:01:00.000Z',
    draftId: 'draft-bravo',
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'hidden-orchid-1001' },
      { id: 'hideout', label: 'Hideout', value: 'copper-comet-1002' },
      { id: 'relic', label: 'Relic', value: 'juniper-riddle-1003' },
    ],
  });
  state = lockFighterForQueue(state, 'fighter-alpha', {
    attackFolderId: 1,
    attackPolicyNoteId: 2,
    defenseFolderId: 3,
    defensePolicyNoteId: 4,
    vaultNoteId: 5,
  }, 'ABC234');
  state = lockFighterForQueue(state, 'fighter-bravo', {
    attackFolderId: 6,
    attackPolicyNoteId: 7,
    defenseFolderId: 8,
    defensePolicyNoteId: 9,
    vaultNoteId: 10,
  }, 'ABC234');

  assert.throws(
    () => sealWorldState(state, FIRST_SECRET),
    WorldStateIntegrityError
  );
});

test('valid pending policy metadata round-trips through encrypted state', () => {
  const state = populatedState();
  state.players[0].pendingPolicy = {
    revision: 2,
    effectiveRound: 12,
    attackPolicy: DEFAULT_ATTACK_POLICY,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
  };

  assert.deepEqual(
    openWorldState(sealWorldState(state, FIRST_SECRET), FIRST_SECRET),
    state
  );
});

test('authenticated pending policy metadata is strictly validated', () => {
  const state = populatedState();
  const validPendingPolicy = {
    revision: 2,
    effectiveRound: 12,
    attackPolicy: DEFAULT_ATTACK_POLICY,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
  };
  const invalidPlayers: Array<Record<string, unknown>> = [
    { ...state.players[0], policyRevision: 0 },
    { ...state.players[0], policyRevision: 1.5 },
    {
      ...state.players[0],
      pendingPolicy: { ...validPendingPolicy, revision: 3 },
    },
    {
      ...state.players[0],
      pendingPolicy: { ...validPendingPolicy, effectiveRound: 0 },
    },
    {
      ...state.players[0],
      pendingPolicy: { ...validPendingPolicy, effectiveRound: 12.5 },
    },
    {
      ...state.players[0],
      pendingPolicy: {
        ...validPendingPolicy,
        attackPolicy: `${DEFAULT_ATTACK_POLICY} `,
      },
    },
    {
      ...state.players[0],
      pendingPolicy: { ...validPendingPolicy, unexpected: true },
    },
  ];

  for (const player of invalidPlayers) {
    const invalidState = { ...state, players: [player] };
    assert.throws(
      () =>
        openWorldState(authenticatedSnapshot(invalidState), FIRST_SECRET),
      WorldStateIntegrityError
    );
  }
});

test('partially present policy metadata is not treated as legacy state', () => {
  const state = populatedState();
  const withoutRevision = { ...state.players[0] } as Partial<
    FighterMiniGameState['players'][number]
  >;
  const withoutPending = { ...state.players[0] } as Partial<
    FighterMiniGameState['players'][number]
  >;
  delete withoutRevision.policyRevision;
  delete withoutPending.pendingPolicy;

  for (const player of [withoutRevision, withoutPending]) {
    assert.throws(
      () =>
        openWorldState(
          authenticatedSnapshot({ ...state, players: [player] }),
          FIRST_SECRET
        ),
      WorldStateIntegrityError
    );
  }
});
