import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { config } from '../config.js';
import {
  MINI_GAME_ROUNDS,
  MINI_GAME_VERSION,
  ROOM_CODE_PATTERN,
  createMiniGameState,
  normalizePolicy,
  type FighterMiniGameState,
} from '../fighter-world-core.js';
import {
  VAULT_SLOTS,
  isSyntheticVault,
} from '../synthetic-vault-core.js';
import { database, type DatabaseQueryClient } from './client.js';

const SEAL_VERSION = 'n1ws1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SEALED_BYTES = 16 * 1024 * 1024;
const KEY_SALT = Buffer.from('virtual-n1-world-state-key-v1', 'utf8');
const KEY_INFO = Buffer.from('fighter-mini-game-state/aes-256-gcm', 'utf8');
const AUTHENTICATED_CONTEXT = Buffer.from(
  'virtual-n1/fighter-mini-game-state/n1ws1',
  'utf8'
);

interface StoredWorldStateRow {
  sealed_state: string;
  revision: string | number;
}

export interface WorldStateMutation<T> {
  state: FighterMiniGameState;
  result: T;
}

export interface WorldStateLeaseFence {
  gameId: string;
  leaseToken: string;
}

export class WorldStateIntegrityError extends Error {
  constructor() {
    super('Stored Fighter world state failed authenticated validation.');
    this.name = 'WorldStateIntegrityError';
  }
}

export class WorldStateLeaseLostError extends Error {
  constructor() {
    super('The Fighter match runner no longer owns its execution lease.');
    this.name = 'WorldStateLeaseLostError';
  }
}

function failIntegrity(): never {
  throw new WorldStateIntegrityError();
}

function deriveKey(secret: string): Buffer {
  if (!secret) failIntegrity();
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), KEY_SALT, KEY_INFO, 32)
  );
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) failIntegrity();
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    failIntegrity();
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  const accepted = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => accepted.has(key))
  );
}

function nonEmptyString(value: unknown, max = 4_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validCapsule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    'attackFolderId',
    'attackPolicyNoteId',
    'defenseFolderId',
    'defensePolicyNoteId',
    'vaultNoteId',
  ] as const;
  return exactKeys(value, keys) && keys.every((key) => positiveInteger(value[key]));
}

function normalizedPolicy(value: unknown, label: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    return normalizePolicy(value, label) === value;
  } catch {
    return false;
  }
}

function validPendingPolicy(value: unknown, policyRevision: number): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'revision',
      'effectiveRound',
      'attackPolicy',
      'defensePolicy',
    ]) &&
    positiveInteger(value.revision) &&
    value.revision === policyRevision + 1 &&
    positiveInteger(value.effectiveRound) &&
    normalizedPolicy(value.attackPolicy, 'Attack policy') &&
    normalizedPolicy(value.defensePolicy, 'Defense policy')
  );
}

function validPlayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(
      value,
      [
        'id',
        'handle',
        'displayName',
        'joinedAt',
        'draftId',
        'attackPolicy',
        'defensePolicy',
        'policyRevision',
        'pendingPolicy',
        'secrets',
        'locked',
        'phase',
        'queueOrder',
        'roomCode',
        'currentGameId',
        'capsule',
      ],
      ['agentLanguage']
    ) ||
    !nonEmptyString(value.id, 256) ||
    !nonEmptyString(value.handle, 256) ||
    !nonEmptyString(value.displayName, 512) ||
    !isoTimestamp(value.joinedAt) ||
    !nonEmptyString(value.draftId, 256) ||
    !normalizedPolicy(value.attackPolicy, 'Attack policy') ||
    !normalizedPolicy(value.defensePolicy, 'Defense policy') ||
    (Object.hasOwn(value, 'agentLanguage') &&
      value.agentLanguage !== 'en' &&
      value.agentLanguage !== 'zh-CN') ||
    !positiveInteger(value.policyRevision) ||
    (value.pendingPolicy !== null &&
      !validPendingPolicy(value.pendingPolicy, value.policyRevision)) ||
    typeof value.locked !== 'boolean' ||
    !['setup', 'waiting', 'playing', 'complete'].includes(String(value.phase)) ||
    !Array.isArray(value.secrets) ||
    !isSyntheticVault(value.secrets)
  ) {
    return false;
  }

  if (value.phase === 'setup') {
    return (
      !value.locked &&
      value.queueOrder === null &&
      value.roomCode === null &&
      value.currentGameId === null &&
      value.capsule === null
    );
  }
  if (value.phase === 'waiting') {
    return (
      value.locked &&
      positiveInteger(value.queueOrder) &&
      (value.roomCode === null ||
        (typeof value.roomCode === 'string' &&
          ROOM_CODE_PATTERN.test(value.roomCode))) &&
      value.currentGameId === null &&
      validCapsule(value.capsule)
    );
  }
  return (
    value.locked &&
    value.queueOrder === null &&
    value.roomCode === null &&
    nonEmptyString(value.currentGameId, 256) &&
    validCapsule(value.capsule)
  );
}

function validScoreRecord(
  value: unknown,
  playerIds: readonly [string, string]
): boolean {
  if (!isRecord(value) || !exactKeys(value, playerIds)) return false;
  return playerIds.every((playerId) => nonNegativeInteger(value[playerId]));
}

function expectedMessage(
  message: Record<string, unknown>,
  index: number,
  playerIds: readonly [string, string],
  maxRounds: number
): boolean {
  if (
    !exactKeys(message, [
      'id',
      'round',
      'kind',
      'speakerId',
      'targetId',
      'text',
    ]) ||
    !nonEmptyString(message.id, 256) ||
    !nonEmptyString(message.text, 1_600) ||
    index >= maxRounds * 4
  ) {
    return false;
  }
  const round = Math.floor(index / 4) + 1;
  const [first, second] = playerIds;
  const turns = [
    ['attack', first, second],
    ['defense', second, first],
    ['attack', second, first],
    ['defense', first, second],
  ] as const;
  const [kind, speakerId, targetId] = turns[index % turns.length];
  return (
    message.round === round &&
    message.kind === kind &&
    message.speakerId === speakerId &&
    message.targetId === targetId
  );
}

function validCapture(
  value: unknown,
  playerIds: readonly [string, string],
  maxRounds: number
): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'round',
      'attackerId',
      'targetId',
      'secretId',
      'secretLabel',
    ]) ||
    !nonEmptyString(value.id, 256) ||
    !positiveInteger(value.round) ||
    value.round > maxRounds ||
    !playerIds.includes(String(value.attackerId)) ||
    !playerIds.includes(String(value.targetId)) ||
    value.attackerId === value.targetId
  ) {
    return false;
  }
  const slot = VAULT_SLOTS.find((candidate) => candidate.id === value.secretId);
  return Boolean(slot && value.secretLabel === slot.label);
}

function validGame(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        'id',
        'status',
        'playerIds',
        'round',
        'maxRounds',
        'messages',
        'captures',
        'scores',
        'shields',
        'roomCode',
        'createdAt',
      ],
      ['completedAt']
    ) ||
    !nonEmptyString(value.id, 256) ||
    !['playing', 'complete'].includes(String(value.status)) ||
    !Array.isArray(value.playerIds) ||
    value.playerIds.length !== 2 ||
    !value.playerIds.every((id) => nonEmptyString(id, 256)) ||
    value.playerIds[0] === value.playerIds[1] ||
    !positiveInteger(value.round) ||
    !positiveInteger(value.maxRounds) ||
    value.round > value.maxRounds ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.captures) ||
    !(
      value.roomCode === null ||
      (typeof value.roomCode === 'string' && ROOM_CODE_PATTERN.test(value.roomCode))
    ) ||
    !isoTimestamp(value.createdAt)
  ) {
    return false;
  }
  const playerIds = value.playerIds as [string, string];
  if (
    !value.messages.every(
      (message, index) =>
        isRecord(message) &&
        expectedMessage(message, index, playerIds, value.maxRounds as number)
    ) ||
    !value.captures.every((capture) =>
      validCapture(capture, playerIds, value.maxRounds as number)
    ) ||
    !validScoreRecord(value.scores, playerIds) ||
    !validScoreRecord(value.shields, playerIds)
  ) {
    return false;
  }
  const captureKeys = new Set<string>();
  for (const capture of value.captures as Array<Record<string, unknown>>) {
    const key = `${String(capture.targetId)}:${String(capture.secretId)}`;
    if (captureKeys.has(key)) return false;
    captureKeys.add(key);
  }
  if (value.status === 'playing') {
    return !Object.hasOwn(value, 'completedAt');
  }
  return isoTimestamp(value.completedAt);
}

function upgradeLegacyPolicyState(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.version !== MINI_GAME_VERSION ||
    !Array.isArray(value.players)
  ) {
    return value;
  }

  let upgraded = false;
  const players = value.players.map((player) => {
    if (
      !isRecord(player) ||
      Object.hasOwn(player, 'policyRevision') ||
      Object.hasOwn(player, 'pendingPolicy')
    ) {
      return player;
    }
    upgraded = true;
    return {
      ...player,
      policyRevision: 1,
      pendingPolicy: null,
    };
  });

  return upgraded ? { ...value, players } : value;
}

function upgradeLegacyRoomCodeState(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.players) ||
    !Array.isArray(value.games)
  ) {
    return value;
  }
  return {
    ...value,
    version: MINI_GAME_VERSION,
    players: value.players.map((player) =>
      isRecord(player) && !Object.hasOwn(player, 'roomCode')
        ? { ...player, roomCode: null }
        : player
    ),
    games: value.games.map((game) =>
      isRecord(game) && !Object.hasOwn(game, 'roomCode')
        ? { ...game, roomCode: null }
        : game
    ),
  };
}

function upgradeLegacyActiveGameRounds(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.version !== MINI_GAME_VERSION ||
    !Array.isArray(value.games)
  ) {
    return value;
  }

  let upgraded = false;
  const games = value.games.map((game) => {
    if (
      !isRecord(game) ||
      game.status !== 'playing' ||
      game.maxRounds !== 3 ||
      !validGame(game)
    ) {
      return game;
    }
    upgraded = true;
    return {
      ...game,
      maxRounds: MINI_GAME_ROUNDS,
    };
  });

  return upgraded ? { ...value, games } : value;
}

function assertValidWorldState(value: unknown): asserts value is FighterMiniGameState {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'nextQueueOrder',
      'nextGameNumber',
      'players',
      'games',
    ]) ||
    value.version !== MINI_GAME_VERSION ||
    !positiveInteger(value.nextQueueOrder) ||
    !positiveInteger(value.nextGameNumber) ||
    !Array.isArray(value.players) ||
    !Array.isArray(value.games) ||
    !value.players.every(validPlayer) ||
    !value.games.every(validGame)
  ) {
    failIntegrity();
  }

  const players = value.players as FighterMiniGameState['players'];
  const games = value.games as FighterMiniGameState['games'];
  const nextQueueOrder = value.nextQueueOrder as number;
  if (
    new Set(players.map((player) => player.id)).size !== players.length ||
    new Set(games.map((game) => game.id)).size !== games.length
  ) {
    failIntegrity();
  }
  const playerById = new Map(players.map((player) => [player.id, player]));
  const gameById = new Map(games.map((game) => [game.id, game]));
  const queueOrders = players
    .map((player) => player.queueOrder)
    .filter((order): order is number => order !== null);
  if (
    new Set(queueOrders).size !== queueOrders.length ||
    queueOrders.some((order) => order >= nextQueueOrder)
  ) {
    failIntegrity();
  }
  const waitingRoomCodes = players
    .filter((player) => player.phase === 'waiting')
    .map((player) => player.roomCode)
    .filter((roomCode): roomCode is string => roomCode !== null);
  const gameRoomCodes = games
    .map((game) => game.roomCode)
    .filter((roomCode): roomCode is string => roomCode !== null);
  if (
    new Set(waitingRoomCodes).size !== waitingRoomCodes.length ||
    new Set(gameRoomCodes).size !== gameRoomCodes.length ||
    waitingRoomCodes.some((roomCode) => gameRoomCodes.includes(roomCode))
  ) {
    failIntegrity();
  }
  for (const game of games) {
    if (game.playerIds.some((id) => !playerById.has(id))) failIntegrity();
  }
  for (const player of players) {
    if (!player.currentGameId) continue;
    const game = gameById.get(player.currentGameId);
    if (
      !game ||
      !game.playerIds.includes(player.id) ||
      (player.phase === 'playing' && game.status !== 'playing') ||
      (player.phase === 'complete' && game.status !== 'complete')
    ) {
      failIntegrity();
    }
  }
}

/**
 * Seal one complete world snapshot. The database receives only this opaque,
 * authenticated value; configuration and synthetic values never become SQL
 * fields.
 */
export function sealWorldState(
  state: FighterMiniGameState,
  secret = config.arenaSecret
): string {
  assertValidWorldState(state);
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), nonce);
  cipher.setAAD(AUTHENTICATED_CONTEXT);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed = [
    SEAL_VERSION,
    encode(nonce),
    encode(ciphertext),
    encode(tag),
  ].join('.');
  if (Buffer.byteLength(sealed, 'utf8') > MAX_SEALED_BYTES) failIntegrity();
  return sealed;
}

/** Open and strictly validate an authenticated world snapshot. */
export function openWorldState(
  sealed: string,
  secret = config.arenaSecret
): FighterMiniGameState {
  try {
    if (
      typeof sealed !== 'string' ||
      Buffer.byteLength(sealed, 'utf8') > MAX_SEALED_BYTES
    ) {
      failIntegrity();
    }
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== SEAL_VERSION) failIntegrity();
    const nonce = decode(parts[1], NONCE_BYTES);
    const ciphertext = decode(parts[2]);
    const tag = decode(parts[3], TAG_BYTES);
    if (ciphertext.length === 0) failIntegrity();
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), nonce);
    decipher.setAAD(AUTHENTICATED_CONTEXT);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    const value = upgradeLegacyActiveGameRounds(
      upgradeLegacyPolicyState(upgradeLegacyRoomCodeState(parsed))
    );
    assertValidWorldState(value);
    return value;
  } catch {
    failIntegrity();
  }
}

async function insertInitialState(sql: DatabaseQueryClient): Promise<void> {
  const sealed = sealWorldState(createMiniGameState());
  await sql`
    INSERT INTO virtual_n1.fighter_world_state (
      sealed_state,
      revision
    )
    VALUES (${sealed}, 0)
    ON CONFLICT DO NOTHING
  `;
}

function requireStoredRow(rows: StoredWorldStateRow[]): StoredWorldStateRow {
  const row = rows[0];
  if (!row || rows.length !== 1 || !nonNegativeInteger(Number(row.revision))) {
    failIntegrity();
  }
  return row;
}

/**
 * Read the durable snapshot. The first caller creates an encrypted empty
 * snapshot, so callers never need a separate initialization step.
 */
export async function readWorldState(): Promise<FighterMiniGameState> {
  const sql = database();
  return sql.begin(async (tx) => {
    await insertInitialState(tx);
    const rows = await tx<StoredWorldStateRow[]>`
      SELECT sealed_state, revision
      FROM virtual_n1.fighter_world_state
    `;
    return openWorldState(requireStoredRow(rows).sealed_state);
  });
}

/**
 * Serialize one state transition with a row lock. The callback's state and
 * result commit atomically; throwing from the callback rolls the transaction
 * back and leaves the previous sealed snapshot intact.
 */
export async function mutateWorldState<T>(
  work: (
    state: FighterMiniGameState
  ) => WorldStateMutation<T> | Promise<WorldStateMutation<T>>,
  leaseFence?: WorldStateLeaseFence
): Promise<T> {
  const sql = database();
  const result = await sql.begin(async (tx) => {
    if (leaseFence) {
      const leases = await tx<Array<{ lease_token: string }>>`
        SELECT lease_token
        FROM virtual_n1.fighter_game_execution_leases
        WHERE game_id = ${leaseFence.gameId}
          AND lease_token = ${leaseFence.leaseToken}
          AND lease_expires_at > now()
        FOR UPDATE
      `;
      if (
        leases.length !== 1 ||
        leases[0]?.lease_token !== leaseFence.leaseToken
      ) {
        throw new WorldStateLeaseLostError();
      }
    }
    await insertInitialState(tx);
    const rows = await tx<StoredWorldStateRow[]>`
      SELECT sealed_state, revision
      FROM virtual_n1.fighter_world_state
      FOR UPDATE
    `;
    const current = requireStoredRow(rows);
    const mutation = await work(openWorldState(current.sealed_state));
    if (!isRecord(mutation) || !exactKeys(mutation, ['state', 'result'])) {
      failIntegrity();
    }
    const nextSealed = sealWorldState(mutation.state as FighterMiniGameState);
    const updated = await tx<Array<{ revision: string | number }>>`
      UPDATE virtual_n1.fighter_world_state
      SET
        sealed_state = ${nextSealed},
        revision = revision + 1,
        updated_at = now()
      WHERE revision = ${current.revision}
      RETURNING revision
    `;
    if (updated.length !== 1) failIntegrity();
    return mutation.result as T;
  });
  return result as T;
}
