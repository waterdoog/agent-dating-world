import type {
  FighterIdentityDraft,
  MiniGame,
  MiniGameCapture,
  MiniGameMessage,
} from '../fighter-world-core.js';

export interface FighterUserRecord {
  id: string;
  handle: string;
  displayName: string;
  joinedAt?: string;
}

export interface ArchivedParticipant extends FighterUserRecord {
  seat: 1 | 2;
  score: number;
  shields: number;
  result: 'pending' | 'win' | 'loss' | 'draw';
}

export interface ArchivedMessage extends MiniGameMessage {
  sequence: number;
  /** Always true: exact vault values have been removed before persistence. */
  redacted: true;
}

export interface MiniGameArchive {
  id: string;
  status: MiniGame['status'];
  round: number;
  maxRounds: number;
  winnerId: string | null;
  createdAt: string;
  completedAt: string | null;
  participants: [ArchivedParticipant, ArchivedParticipant];
  messages: ArchivedMessage[];
  captures: MiniGameCapture[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactVaultValues(
  text: string,
  players: readonly Pick<FighterIdentityDraft, 'secrets'>[]
): string {
  let redacted = text;
  const secrets = players
    .flatMap((player) => player.secrets)
    .sort((first, second) => second.value.length - first.value.length);
  for (const secret of secrets) {
    if (!secret.value) continue;
    redacted = redacted.replace(
      new RegExp(escapeRegex(secret.value), 'giu'),
      `[REDACTED ${secret.label.toUpperCase()}]`
    );
  }
  return redacted;
}

function resultFor(
  game: MiniGame,
  fighterId: string
): ArchivedParticipant['result'] {
  if (game.status !== 'complete') return 'pending';
  const [firstId, secondId] = game.playerIds;
  const firstScore = game.scores[firstId] ?? 0;
  const secondScore = game.scores[secondId] ?? 0;
  if (firstScore === secondScore) return 'draw';
  const winnerId = firstScore > secondScore ? firstId : secondId;
  return fighterId === winnerId ? 'win' : 'loss';
}

function winnerFor(game: MiniGame): string | null {
  if (game.status !== 'complete') return null;
  const [firstId, secondId] = game.playerIds;
  const firstScore = game.scores[firstId] ?? 0;
  const secondScore = game.scores[secondId] ?? 0;
  if (firstScore === secondScore) return null;
  return firstScore > secondScore ? firstId : secondId;
}

/**
 * Selects the durable, privacy-safe subset of an in-memory mini-game. This is
 * deliberately the only bridge into the repository: policies, capsules,
 * share tokens, OAuth subjects, and raw vault values have no archive fields.
 */
export function buildMiniGameArchive(
  game: MiniGame,
  players: readonly FighterIdentityDraft[]
): MiniGameArchive {
  const participants = game.playerIds.map((fighterId, index) => {
    const player = players.find((candidate) => candidate.id === fighterId);
    if (!player) throw new Error(`Cannot archive ${game.id}: Fighter ${fighterId} is missing.`);
    return {
      id: player.id,
      handle: player.handle,
      displayName: player.displayName,
      joinedAt: player.joinedAt,
      seat: (index + 1) as 1 | 2,
      score: game.scores[fighterId] ?? 0,
      shields: game.shields[fighterId] ?? 0,
      result: resultFor(game, fighterId),
    };
  }) as [ArchivedParticipant, ArchivedParticipant];

  return {
    id: game.id,
    status: game.status,
    round: game.round,
    maxRounds: game.maxRounds,
    winnerId: winnerFor(game),
    createdAt: game.createdAt,
    completedAt: game.completedAt ?? null,
    participants,
    messages: game.messages.map((message, index) => ({
      ...message,
      sequence: index + 1,
      text: redactVaultValues(message.text, players),
      redacted: true,
    })),
    captures: game.captures.map((capture) => ({ ...capture })),
  };
}
