export interface Me {
  signedIn: boolean;
  authType?: 'oauth';
  username?: string | null;
  displayName?: string | null;
}

export type ProfileResult = 'win' | 'loss' | 'draw';

export interface ProfilePlayer {
  id: string | null;
  displayName: string;
  handle: string;
  credits: number;
  joinedAt: string | null;
}

export interface ProfileStats {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  captures: number;
  leaks: number;
}

export interface ProfileOpponent {
  id: string | null;
  displayName: string;
  handle: string;
}

export interface ProfileMessage {
  id: string;
  round: number;
  kind: 'attack' | 'defense';
  speakerId: string;
  targetId: string;
  text: string;
}

export interface ProfileCapture {
  id: string;
  round: number;
  capturedById: string;
  targetId: string;
  label: string;
}

export interface ProfileGame {
  id: string;
  result: ProfileResult;
  score: number;
  opponentScore: number;
  opponent: ProfileOpponent;
  createdAt: string | null;
  completedAt: string | null;
  messages: ProfileMessage[];
  captures: ProfileCapture[];
}

export interface ProfileView {
  player: ProfilePlayer;
  stats: ProfileStats;
  games: ProfileGame[];
}

export type WorldPhase = 'entry' | 'setup' | 'waiting' | 'playing' | 'complete';

export interface WorldSecret {
  id: string;
  label: string;
  value: string;
}

export interface WorldConfig {
  attackPolicy: string;
  defensePolicy: string;
  secrets: WorldSecret[];
  locked: boolean;
}

export interface WorldPlayer {
  id: string;
  displayName: string;
  handle: string;
  score: number;
  shields: number;
  isSelf: boolean;
}

export interface WorldMessage {
  id: string;
  round: number;
  kind: 'attack' | 'defense';
  speakerId: string;
  targetId: string;
  text: string;
}

export interface WorldCapture {
  id: string;
  round: number;
  capturedById: string;
  targetId: string;
  secretId: string;
  label: string;
}

export interface WorldGame {
  id: string;
  status: string;
  round: number;
  maxRounds: number;
  players: WorldPlayer[];
  messages: WorldMessage[];
  captures: WorldCapture[];
}

export interface WorldView {
  joined: boolean;
  selfId: string | null;
  phase: WorldPhase;
  queueSize: number;
  config: WorldConfig | null;
  game: WorldGame | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerValue(value: unknown, fallback = 0): number {
  return Math.round(numberValue(value, fallback));
}

function optionalIntegerValue(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  return integerValue(value, fallback);
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function nullableDateValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  return Number.isNaN(Date.parse(candidate)) ? null : candidate;
}

function normalizeProfileResult(
  value: unknown,
  score: number,
  opponentScore: number,
): ProfileResult {
  const result = stringValue(value).toLowerCase();
  if (result === 'win' || result === 'won' || result === 'victory') return 'win';
  if (result === 'loss' || result === 'lost' || result === 'defeat') return 'loss';
  if (result === 'draw' || result === 'tie') return 'draw';
  if (score > opponentScore) return 'win';
  if (score < opponentScore) return 'loss';
  return 'draw';
}

export function normalizeProfileView(payload: unknown): ProfileView {
  const envelope = objectValue(payload);
  const root = Object.keys(objectValue(envelope.profile)).length > 0
    ? objectValue(envelope.profile)
    : envelope;
  const player = objectValue(root.player);
  const rawGames = Array.isArray(root.games) ? root.games : root.history;

  const games = recordList(rawGames).map((game, gameIndex) => {
    const gameId = stringValue(game.id, `match-${gameIndex + 1}`);
    const score = Math.max(0, integerValue(game.score, integerValue(game.playerScore)));
    const opponentScore = Math.max(
      0,
      integerValue(game.opponentScore, integerValue(game.awayScore)),
    );
    const opponent = objectValue(game.opponent);
    const messagesSource = Array.isArray(game.messages) ? game.messages : game.transcript;
    const capturesSource = Array.isArray(game.captures) ? game.captures : game.events;

    const messages = recordList(messagesSource).map((message, messageIndex) => ({
      id: stringValue(message.id, `${gameId}-message-${messageIndex + 1}`),
      round: Math.max(0, integerValue(message.round)),
      kind: message.kind === 'defense' ? 'defense' as const : 'attack' as const,
      speakerId: stringValue(message.speakerId),
      targetId: stringValue(message.targetId),
      text: stringValue(message.text, 'Message unavailable.'),
    }));

    const captures = recordList(capturesSource).map((capture, captureIndex) => ({
      id: stringValue(capture.id, `${gameId}-capture-${captureIndex + 1}`),
      round: Math.max(0, integerValue(capture.round)),
      capturedById: stringValue(
        capture.capturedById,
        stringValue(capture.attackerId, stringValue(capture.speakerId)),
      ),
      targetId: stringValue(capture.targetId),
      label: stringValue(
        capture.label,
        stringValue(capture.secretLabel, 'Synthetic secret'),
      ),
    }));

    return {
      id: gameId,
      result: normalizeProfileResult(game.result, score, opponentScore),
      score,
      opponentScore,
      opponent: {
        id: stringValue(opponent.id) || null,
        displayName: stringValue(
          opponent.displayName,
          stringValue(opponent.name, stringValue(game.opponentName, 'Unknown fighter')),
        ),
        handle: stringValue(
          opponent.handle,
          stringValue(opponent.username, stringValue(game.opponentHandle, 'fighter')),
        ).replace(/^@/, ''),
      },
      createdAt: nullableDateValue(game.createdAt),
      completedAt: nullableDateValue(game.completedAt),
      messages,
      captures,
    };
  });

  games.sort((left, right) => {
    const leftTime = Date.parse(left.completedAt ?? left.createdAt ?? '') || 0;
    const rightTime = Date.parse(right.completedAt ?? right.createdAt ?? '') || 0;
    return rightTime - leftTime;
  });

  const stats = objectValue(root.stats);
  const derivedWins = games.reduce((count, game) => count + Number(game.result === 'win'), 0);
  const derivedLosses = games.reduce((count, game) => count + Number(game.result === 'loss'), 0);
  const derivedDraws = games.reduce((count, game) => count + Number(game.result === 'draw'), 0);

  return {
    player: {
      id: stringValue(player.id, stringValue(root.playerId)) || null,
      displayName: stringValue(
        player.displayName,
        stringValue(player.name, stringValue(root.displayName, 'N1 player')),
      ),
      handle: stringValue(
        player.handle,
        stringValue(player.username, stringValue(root.handle, 'n1-player')),
      ).replace(/^@/, ''),
      credits: Math.max(
        0,
        optionalIntegerValue(
          player.credits,
          optionalIntegerValue(player.n1Credits, 1_000),
        ),
      ),
      joinedAt: nullableDateValue(player.joinedAt),
    },
    stats: {
      played: Math.max(0, optionalIntegerValue(stats.played, games.length)),
      wins: Math.max(0, optionalIntegerValue(stats.wins, derivedWins)),
      losses: Math.max(0, optionalIntegerValue(stats.losses, derivedLosses)),
      draws: Math.max(0, optionalIntegerValue(stats.draws, derivedDraws)),
      captures: Math.max(
        0,
        optionalIntegerValue(
          stats.captures,
          optionalIntegerValue(stats.secretsCaptured),
        ),
      ),
      leaks: Math.max(
        0,
        optionalIntegerValue(stats.leaks, optionalIntegerValue(stats.secretsLost)),
      ),
    },
    games,
  };
}

function normalizePhase(value: unknown, root: Record<string, unknown>): WorldPhase {
  if (value === 'entry' || value === 'setup' || value === 'waiting'
    || value === 'playing' || value === 'complete') {
    return value;
  }

  if (root.joined !== true) return 'entry';
  const game = objectValue(root.game);
  const status = stringValue(game.status).toLowerCase();
  if (['complete', 'completed', 'finished', 'settled'].includes(status)) return 'complete';
  if (Object.keys(game).length > 0) return 'playing';
  if (objectValue(root.config).locked === true) return 'waiting';
  return 'setup';
}

function normalizeConfig(value: unknown): WorldConfig | null {
  const config = objectValue(value);
  if (Object.keys(config).length === 0) return null;

  const secrets = recordList(config.secrets).map((secret, index) => ({
    id: stringValue(secret.id, `secret-${index + 1}`),
    label: stringValue(secret.label, `Secret ${index + 1}`),
    value: stringValue(secret.value, '—'),
  }));

  return {
    attackPolicy: stringValue(config.attackPolicy),
    defensePolicy: stringValue(config.defensePolicy),
    secrets,
    locked: config.locked === true,
  };
}

function normalizeGame(value: unknown, selfId: string | null): WorldGame | null {
  const game = objectValue(value);
  if (Object.keys(game).length === 0) return null;

  const gameId = stringValue(game.id, 'match');
  const players = recordList(game.players).map((player, index) => {
    const id = stringValue(player.id, `player-${index + 1}`);
    const handle = stringValue(
      player.handle,
      stringValue(player.username, `fighter-${index + 1}`),
    ).replace(/^@/, '');

    return {
      id,
      displayName: stringValue(player.displayName, stringValue(player.name, handle)),
      handle,
      score: integerValue(player.score),
      shields: Math.max(0, Math.min(3, integerValue(player.shields, 3))),
      isSelf: player.isSelf === true || id === selfId,
    };
  });

  const messages = recordList(game.messages).map((message, index) => ({
    id: stringValue(message.id, `${gameId}-message-${index + 1}`),
    round: Math.max(0, integerValue(message.round)),
    kind: message.kind === 'defense' ? 'defense' as const : 'attack' as const,
    speakerId: stringValue(message.speakerId),
    targetId: stringValue(message.targetId),
    text: stringValue(message.text, '…'),
  }));

  const captures = recordList(game.captures).map((capture, index) => ({
    id: stringValue(capture.id, `${gameId}-capture-${index + 1}`),
    round: Math.max(0, integerValue(capture.round)),
    capturedById: stringValue(
      capture.capturedById,
      stringValue(capture.attackerId, stringValue(capture.speakerId)),
    ),
    targetId: stringValue(capture.targetId),
    secretId: stringValue(capture.secretId, stringValue(capture.slotId, `secret-${index + 1}`)),
    label: stringValue(capture.label, stringValue(capture.secretLabel, 'a vault secret')),
  }));

  return {
    id: gameId,
    status: stringValue(game.status, 'playing'),
    round: Math.max(0, integerValue(game.round)),
    maxRounds: Math.max(1, integerValue(game.maxRounds, 3)),
    players,
    messages,
    captures,
  };
}

export function normalizeWorldView(payload: unknown): WorldView {
  const envelope = objectValue(payload);
  const root = Object.keys(objectValue(envelope.world)).length > 0
    ? objectValue(envelope.world)
    : envelope;
  const selfId = stringValue(root.selfId, stringValue(root.playerId)) || null;

  return {
    joined: root.joined === true,
    selfId,
    phase: normalizePhase(root.phase, root),
    queueSize: Math.max(0, integerValue(root.queueSize)),
    config: normalizeConfig(root.config),
    game: normalizeGame(root.game, selfId),
  };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(data?.message ?? data?.error ?? `Request failed (${response.status})`);
  }
  return data;
}

async function worldMutation(method: string, path: string, body?: unknown): Promise<WorldView> {
  return normalizeWorldView(await request<unknown>(method, path, body));
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
  profile: async (signal?: AbortSignal) =>
    normalizeProfileView(await request<unknown>('GET', '/api/profile', undefined, signal)),
  world: async (signal?: AbortSignal) =>
    normalizeWorldView(await request<unknown>('GET', '/api/world', undefined, signal)),
  joinWorld: () => worldMutation('POST', '/api/world/join'),
  updateWorldConfig: (attackPolicy: string, defensePolicy: string) =>
    worldMutation('PUT', '/api/world/config', { attackPolicy, defensePolicy }),
  readyWorld: () => worldMutation('POST', '/api/world/ready'),
  runWorld: () => worldMutation('POST', '/api/world/run'),
  playAgain: () => worldMutation('POST', '/api/world/play-again'),
};

export function loginWithAicooUrl(returnTo = '/'): string {
  const query = new URLSearchParams({ return_to: returnTo });
  return `/auth/login?${query.toString()}`;
}
