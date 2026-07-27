export const AGENT_FIGHTS_STAKE = 200;
export const AGENT_FIGHTS_SETTLEMENT_VERSION = 1;

export type SettledGameResult = 'win' | 'loss' | 'draw';

export interface SettlementParticipant {
  fighterId: string;
  result: SettledGameResult;
}

export interface GameCreditSettlement {
  gameId: string;
  fighterId: string;
  amount: number;
  version: number;
  idempotencyKey: string;
}

export function canAffordGameStake(balance: number, stake: number): boolean {
  return (
    Number.isSafeInteger(balance) &&
    balance >= 0 &&
    Number.isSafeInteger(stake) &&
    stake >= 0 &&
    balance >= stake
  );
}

/**
 * Converts one locked, completed 1v1 result into its zero-sum wallet entries.
 * Draws deliberately return two zero-value settlement markers even though the
 * append-only credit ledger itself accepts only non-zero amounts.
 */
export function buildGameCreditSettlements(
  gameId: string,
  stake: number,
  participants: readonly SettlementParticipant[]
): GameCreditSettlement[] {
  if (!gameId || !Number.isSafeInteger(stake) || stake < 0) {
    throw new Error('The game stake is invalid.');
  }
  if (participants.length !== 2) {
    throw new Error('A wallet settlement requires exactly two Fighters.');
  }
  if (new Set(participants.map((participant) => participant.fighterId)).size !== 2) {
    throw new Error('A wallet settlement requires two distinct Fighters.');
  }

  const draws = participants.filter((participant) => participant.result === 'draw');
  const wins = participants.filter((participant) => participant.result === 'win');
  const losses = participants.filter((participant) => participant.result === 'loss');
  const isDraw = draws.length === 2 && wins.length === 0 && losses.length === 0;
  const hasWinner =
    draws.length === 0 && wins.length === 1 && losses.length === 1;
  if (!isDraw && !hasWinner) {
    throw new Error('The completed Fighter results cannot be settled.');
  }

  return participants.map((participant) => ({
    gameId,
    fighterId: participant.fighterId,
    amount:
      participant.result === 'win'
        ? stake
        : participant.result === 'loss'
          ? -stake
          : 0,
    version: AGENT_FIGHTS_SETTLEMENT_VERSION,
    idempotencyKey:
      `agent-fights:${gameId}:${participant.fighterId}:settlement:v${AGENT_FIGHTS_SETTLEMENT_VERSION}`,
  }));
}
