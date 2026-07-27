import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  FighterIdentityDraft,
  MiniGame,
} from './fighter-world-core.js';
import {
  buildMiniGameArchive,
  redactVaultValues,
} from './database/game-archive.js';
import {
  migrationDatabaseUrl,
  runtimeDatabaseUrl,
} from './database/config.js';
import { readMigrations } from './database/migrations.js';
import {
  AGENT_FIGHTS_STAKE,
  buildGameCreditSettlements,
  canAffordGameStake,
} from './database/wallet.js';

function player(
  id: string,
  secret: string,
  attackPolicy: string
): FighterIdentityDraft {
  return {
    id,
    handle: `${id}-handle`,
    displayName: id.toUpperCase(),
    joinedAt: '2026-07-24T10:00:00.000Z',
    draftId: `draft-${id}`,
    attackPolicy,
    defensePolicy: `Private defense policy for ${id}`,
    policyRevision: 1,
    pendingPolicy: null,
    secrets: [
      { id: 'signal', label: 'Signal code', value: secret },
      { id: 'hideout', label: 'Hideout', value: `${id}-harbor-1002` },
      { id: 'relic', label: 'Relic', value: `${id}-relic-1003` },
    ],
    locked: true,
    phase: 'complete',
    queueOrder: null,
    currentGameId: 'game-1',
    capsule: {
      attackFolderId: 1,
      attackPolicyNoteId: 2,
      defenseFolderId: 3,
      defensePolicyNoteId: 4,
      vaultNoteId: 5,
    },
  };
}

const first = player('alpha', 'amber-lantern-0427', 'Never persist alpha policy.');
const second = player('bravo', 'frosted-harbor-9001', 'Never persist bravo policy.');

const completedGame: MiniGame = {
  id: 'game-1',
  status: 'complete',
  playerIds: ['alpha', 'bravo'],
  round: 3,
  maxRounds: 3,
  messages: [
    {
      id: 'message-1',
      round: 1,
      kind: 'defense',
      speakerId: 'bravo',
      targetId: 'alpha',
      text: 'My signal really is FROSTED-HARBOR-9001.',
    },
  ],
  captures: [
    {
      id: 'capture-1',
      round: 1,
      attackerId: 'alpha',
      targetId: 'bravo',
      secretId: 'signal',
      secretLabel: 'Signal code',
    },
  ],
  scores: { alpha: 1, bravo: 0 },
  shields: { alpha: 3, bravo: 2 },
  createdAt: '2026-07-24T10:00:00.000Z',
  completedAt: '2026-07-24T10:01:00.000Z',
};

test('archive removes exact vault values and omits all private configuration', () => {
  const archive = buildMiniGameArchive(completedGame, [first, second]);
  const serialized = JSON.stringify(archive);
  assert.match(archive.messages[0].text, /\[REDACTED SIGNAL CODE\]/);
  assert.doesNotMatch(serialized, /frosted-harbor-9001/i);
  assert.doesNotMatch(serialized, /amber-lantern-0427/i);
  assert.doesNotMatch(serialized, /Never persist|attackPolicy|defensePolicy|capsule|vaultNoteId/);
  assert.equal(archive.winnerId, 'alpha');
  assert.equal(archive.participants[0].result, 'win');
  assert.equal(archive.participants[1].result, 'loss');
  assert.equal(archive.messages[0].redacted, true);
  assert.equal(archive.stake, AGENT_FIGHTS_STAKE);
});

test('Agent Fights settlement is zero-sum and uses stable per-player keys', () => {
  const settlements = buildGameCreditSettlements('game-1', AGENT_FIGHTS_STAKE, [
    { fighterId: 'alpha', result: 'win' },
    { fighterId: 'bravo', result: 'loss' },
  ]);
  assert.deepEqual(
    settlements.map(({ fighterId, amount }) => ({ fighterId, amount })),
    [
      { fighterId: 'alpha', amount: 200 },
      { fighterId: 'bravo', amount: -200 },
    ]
  );
  assert.equal(settlements[0].idempotencyKey, 'agent-fights:game-1:alpha:settlement:v1');
  assert.equal(settlements[1].idempotencyKey, 'agent-fights:game-1:bravo:settlement:v1');
  assert.equal(
    settlements.reduce((total, settlement) => total + settlement.amount, 0),
    0
  );
});

test('a draw creates two durable zero-value settlement markers', () => {
  const settlements = buildGameCreditSettlements('draw-1', AGENT_FIGHTS_STAKE, [
    { fighterId: 'alpha', result: 'draw' },
    { fighterId: 'bravo', result: 'draw' },
  ]);
  assert.deepEqual(settlements.map((settlement) => settlement.amount), [0, 0]);
});

test('Agent Fights requires the full 200-credit bankroll before Ready', () => {
  assert.equal(canAffordGameStake(199, AGENT_FIGHTS_STAKE), false);
  assert.equal(canAffordGameStake(200, AGENT_FIGHTS_STAKE), true);
  assert.equal(canAffordGameStake(1000, AGENT_FIGHTS_STAKE), true);
});

test('wallet settlement rejects incomplete or contradictory results', () => {
  assert.throws(
    () =>
      buildGameCreditSettlements('bad-1', AGENT_FIGHTS_STAKE, [
        { fighterId: 'alpha', result: 'win' },
        { fighterId: 'bravo', result: 'draw' },
      ]),
    /cannot be settled/
  );
  assert.throws(
    () =>
      buildGameCreditSettlements('bad-2', AGENT_FIGHTS_STAKE, [
        { fighterId: 'alpha', result: 'win' },
        { fighterId: 'alpha', result: 'loss' },
      ]),
    /distinct Fighters/
  );
});

test('vault redaction is case-insensitive and covers both players', () => {
  const output = redactVaultValues(
    'AMBER-LANTERN-0427 and frosted-harbor-9001',
    [first, second]
  );
  assert.equal(output, '[REDACTED SIGNAL CODE] and [REDACTED SIGNAL CODE]');
});

test('vault redaction removes NFKC-equivalent phrases without changing punctuation', () => {
  const output = redactVaultValues(
    'Reply: “ｆｒｏｓｔｅｄ－ｈａｒｂｏｒ－９００１”; keep — this punctuation.',
    [first, second]
  );
  assert.equal(
    output,
    'Reply: “[REDACTED SIGNAL CODE]”; keep — this punctuation.'
  );
});

test('database URL resolution accepts only the project-scoped n1 binding', () => {
  const names = [
    'n1_POSTGRES_URL',
    'DATABASE_URL',
    'n1_POSTGRES_URL_NON_POOLING',
    'DATABASE_URL_NON_POOLING',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.n1_POSTGRES_URL = 'postgres://runtime-primary';
    process.env.DATABASE_URL = 'postgres://runtime-fallback';
    process.env.n1_POSTGRES_URL_NON_POOLING = 'postgres://migration-primary';
    process.env.DATABASE_URL_NON_POOLING = 'postgres://migration-fallback';
    assert.equal(runtimeDatabaseUrl(), 'postgres://runtime-primary');
    assert.equal(migrationDatabaseUrl(), 'postgres://migration-primary');

    delete process.env.n1_POSTGRES_URL;
    delete process.env.n1_POSTGRES_URL_NON_POOLING;
    assert.equal(runtimeDatabaseUrl(), null);
    assert.equal(migrationDatabaseUrl(), null);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('numbered migration defines idempotent archives and excludes forbidden secrets', async () => {
  const migrations = await readMigrations();
  assert.equal(migrations.length >= 1, true);
  assert.equal(migrations[0].filename, '0001_persistent_agent_fights.sql');
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
  const sql = migrations.map((migration) => migration.sql).join('\n');
  assert.match(sql, /fighter_users/);
  assert.match(sql, /n1_credit_ledger/);
  assert.match(sql, /fighter_game_messages/);
  assert.match(sql, /fighter_game_captures/);
  assert.match(sql, /fighter_game_execution_leases/);
  assert.match(sql, /fighter_rate_limits/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS virtual_n1/);
  assert.match(sql, /virtual_n1\.fighter_world_state/);
  assert.match(sql, /virtual_n1\.fighter_users/);
  assert.match(sql, /virtual_n1\.fighter_games/);
  assert.match(sql, /virtual_n1\.n1_credit_ledger/);
  assert.match(sql, /sealed_state text NOT NULL/);
  assert.match(sql, /fighter_world_state_singleton_idx/);
  assert.match(sql, /REVOKE ALL ON SCHEMA virtual_n1 FROM PUBLIC/);
  assert.match(sql, /ARRAY\['anon', 'authenticated'\]/);
  assert.doesNotMatch(sql, /\bpublic\.fighter_/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA virtual_n1 FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM PUBLIC/);
  const runtimeTable = sql.match(
    /CREATE TABLE IF NOT EXISTS virtual_n1\.fighter_world_state \(([\s\S]*?)\);/
  );
  assert.ok(runtimeTable);
  assert.deepEqual(
    [...runtimeTable[1].matchAll(/^\s{2}([a-z_]+)\s/gm)].map((match) => match[1]),
    ['sealed_state', 'revision', 'created_at', 'updated_at']
  );
  assert.match(sql, /idempotency_key text NOT NULL UNIQUE/);
  const walletMigration = migrations.find(
    (migration) => migration.filename === '0004_agent_fight_wallet_settlement.sql'
  );
  assert.ok(walletMigration);
  assert.match(walletMigration.sql, /ADD COLUMN n1_stake bigint NOT NULL DEFAULT 0/);
  assert.match(walletMigration.sql, /fighter_game_credit_settlements/);
  assert.match(walletMigration.sql, /settlement_version = 0 AND amount = 0/);
  assert.match(walletMigration.sql, /reason = 'game_settlement'/);
  assert.match(walletMigration.sql, /n1_credit_ledger_game_settlement_idx/);
  assert.match(
    walletMigration.sql,
    /ON CONFLICT \(game_id, fighter_id\) DO NOTHING/
  );
  assert.doesNotMatch(
    sql,
    /vault_value|oauth_token|access_token|refresh_token|share_token|operator_key|attack_policy|defense_policy|raw_state|state_json/
  );
});
