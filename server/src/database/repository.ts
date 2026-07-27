import {
  database,
  isDatabaseConfigured,
  type DatabaseQueryClient,
} from './client.js';
import type { FighterUserRecord, MiniGameArchive } from './game-archive.js';
import { buildGameCreditSettlements } from './wallet.js';

export class DatabaseUnavailableError extends Error {
  constructor(message = 'The Agent Fights database is not configured.') {
    super(message);
  }
}

export class FighterRateLimitError extends Error {
  constructor(message = 'Too many Fighter actions. Try again shortly.') {
    super(message);
  }
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function ensureUserWith(
  sql: DatabaseQueryClient,
  user: FighterUserRecord
): Promise<void> {
  await sql`
    INSERT INTO virtual_n1.fighter_users (
      id,
      handle,
      display_name,
      created_at
    )
    VALUES (
      ${user.id},
      ${user.handle},
      ${user.displayName},
      ${user.joinedAt ?? new Date().toISOString()}
    )
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      display_name = EXCLUDED.display_name,
      updated_at = now()
  `;
  await sql`
    INSERT INTO virtual_n1.n1_credit_ledger (
      fighter_id,
      amount,
      reason,
      idempotency_key
    )
    VALUES (
      ${user.id},
      1000,
      'signup_grant',
      ${`signup:${user.id}`}
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}

export async function ensureFighterUser(user: FighterUserRecord): Promise<void> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  try {
    const sql = database();
    await sql.begin(async (tx) => {
      await ensureUserWith(tx, user);
    });
  } catch {
    throw new DatabaseUnavailableError('The persistent Fighter profile is unavailable.');
  }
}

export async function readFighterCreditBalance(fighterId: string): Promise<number> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  try {
    const rows = await database()<Array<{ n1_credits: string | number }>>`
      SELECT n1_credits
      FROM virtual_n1.fighter_users
      WHERE id = ${fighterId}
    `;
    if (rows.length !== 1) {
      throw new DatabaseUnavailableError('The persistent Fighter profile is unavailable.');
    }
    return numberValue(rows[0].n1_credits);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    throw new DatabaseUnavailableError('The persistent Fighter wallet is unavailable.');
  }
}

export async function enforceFighterRateLimit(
  fighterId: string,
  action: 'join' | 'config' | 'ready' | 'resume' | 'play_again',
  limit: number,
  windowMs: number
): Promise<void> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  try {
    const rows = await database()<Array<{ request_count: number | string }>>`
      INSERT INTO virtual_n1.fighter_rate_limits AS current_limit (
        fighter_id,
        action,
        window_started_at,
        request_count
      )
      VALUES (${fighterId}, ${action}, now(), 1)
      ON CONFLICT (fighter_id, action) DO UPDATE SET
        window_started_at = CASE
          WHEN current_limit.window_started_at <= ${cutoff}
            THEN now()
          ELSE current_limit.window_started_at
        END,
        request_count = CASE
          WHEN current_limit.window_started_at <= ${cutoff}
            THEN 1
          ELSE current_limit.request_count + 1
        END,
        updated_at = now()
      RETURNING request_count
    `;
    if (numberValue(rows[0]?.request_count) > limit) {
      throw new FighterRateLimitError();
    }
  } catch (error) {
    if (error instanceof FighterRateLimitError) throw error;
    throw new DatabaseUnavailableError('The Fighter rate limiter is unavailable.');
  }
}

/** @internal Exported for the rollback-only live database canary. */
export async function settleCompletedGameWith(
  sql: DatabaseQueryClient,
  gameId: string
): Promise<void> {
  const games = await sql<
    Array<{ status: 'playing' | 'complete'; n1_stake: string | number }>
  >`
    SELECT status, n1_stake
    FROM virtual_n1.fighter_games
    WHERE id = ${gameId}
    FOR UPDATE
  `;
  const storedGame = games[0];
  if (storedGame?.status !== 'complete') return;

  const stake = numberValue(storedGame.n1_stake);
  // Version 0 games were already in the archive when wallet settlement
  // launched. They remain neutral rather than being retroactively charged.
  if (stake === 0) return;

  const participants = await sql<
    Array<{
      fighter_id: string;
      result: 'pending' | 'win' | 'loss' | 'draw';
    }>
  >`
    SELECT fighter_id, result
    FROM virtual_n1.fighter_game_participants
    WHERE game_id = ${gameId}
    ORDER BY fighter_id
    FOR UPDATE
  `;
  if (
    participants.length !== 2 ||
    participants.some((participant) => participant.result === 'pending')
  ) {
    throw new Error('The completed Fighter game has invalid settlement results.');
  }

  const settlements = buildGameCreditSettlements(
    gameId,
    stake,
    participants.map((participant) => ({
      fighterId: participant.fighter_id,
      result: participant.result as 'win' | 'loss' | 'draw',
    }))
  );
  const [first, second] = settlements;
  const lockedUsers = await sql<Array<{ id: string }>>`
    SELECT id
    FROM virtual_n1.fighter_users
    WHERE id = ${first.fighterId} OR id = ${second.fighterId}
    ORDER BY id
    FOR UPDATE
  `;
  if (lockedUsers.length !== 2) {
    throw new Error('A Fighter wallet is missing during settlement.');
  }

  for (const settlement of settlements) {
    const insertedMarkers = await sql<Array<{ fighter_id: string }>>`
      INSERT INTO virtual_n1.fighter_game_credit_settlements (
        game_id,
        fighter_id,
        amount,
        settlement_version
      )
      VALUES (
        ${settlement.gameId},
        ${settlement.fighterId},
        ${settlement.amount},
        ${settlement.version}
      )
      ON CONFLICT (game_id, fighter_id) DO NOTHING
      RETURNING fighter_id
    `;

    if (insertedMarkers.length === 0) {
      const existing = await sql<
        Array<{ amount: string | number; settlement_version: number }>
      >`
        SELECT amount, settlement_version
        FROM virtual_n1.fighter_game_credit_settlements
        WHERE game_id = ${settlement.gameId}
          AND fighter_id = ${settlement.fighterId}
      `;
      if (
        existing.length !== 1 ||
        numberValue(existing[0].amount) !== settlement.amount ||
        Number(existing[0].settlement_version) !== settlement.version
      ) {
        throw new Error('The Fighter game has a conflicting wallet settlement.');
      }
      continue;
    }

    if (settlement.amount === 0) continue;
    const updatedBalances = await sql<Array<{ id: string }>>`
      WITH inserted_ledger AS (
        INSERT INTO virtual_n1.n1_credit_ledger (
          fighter_id,
          game_id,
          amount,
          reason,
          idempotency_key
        )
        VALUES (
          ${settlement.fighterId},
          ${settlement.gameId},
          ${settlement.amount},
          'game_settlement',
          ${settlement.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING fighter_id, amount
      )
      UPDATE virtual_n1.fighter_users AS fighter
      SET
        n1_credits = fighter.n1_credits + inserted_ledger.amount,
        updated_at = now()
      FROM inserted_ledger
      WHERE fighter.id = inserted_ledger.fighter_id
      RETURNING fighter.id
    `;
    if (updatedBalances.length !== 1) {
      throw new Error('The Fighter wallet ledger could not be settled.');
    }
  }
}

export async function persistMiniGameArchive(archive: MiniGameArchive): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const sql = database();
  await sql.begin(async (tx) => {
    for (const participant of archive.participants) {
      await ensureUserWith(tx, participant);
    }

    await tx`
      INSERT INTO virtual_n1.fighter_games AS existing_game (
        id,
        status,
        current_round,
        max_rounds,
        n1_stake,
        winner_fighter_id,
        created_at,
        completed_at
      )
      VALUES (
        ${archive.id},
        ${archive.status},
        ${archive.round},
        ${archive.maxRounds},
        ${archive.stake},
        ${archive.winnerId},
        ${archive.createdAt},
        ${archive.completedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = CASE
          WHEN existing_game.status = 'complete' THEN 'complete'
          ELSE EXCLUDED.status
        END,
        current_round = GREATEST(
          existing_game.current_round,
          EXCLUDED.current_round
        ),
        max_rounds = EXCLUDED.max_rounds,
        n1_stake = existing_game.n1_stake,
        winner_fighter_id = COALESCE(
          existing_game.winner_fighter_id,
          EXCLUDED.winner_fighter_id
        ),
        completed_at = COALESCE(
          existing_game.completed_at,
          EXCLUDED.completed_at
        ),
        updated_at = now()
    `;

    for (const participant of archive.participants) {
      await tx`
        INSERT INTO virtual_n1.fighter_game_participants AS existing_participant (
          game_id,
          fighter_id,
          seat,
          handle_snapshot,
          display_name_snapshot,
          score,
          shields_remaining,
          result
        )
        VALUES (
          ${archive.id},
          ${participant.id},
          ${participant.seat},
          ${participant.handle},
          ${participant.displayName},
          ${participant.score},
          ${participant.shields},
          ${participant.result}
        )
        ON CONFLICT (game_id, fighter_id) DO UPDATE SET
          handle_snapshot = EXCLUDED.handle_snapshot,
          display_name_snapshot = EXCLUDED.display_name_snapshot,
          score = GREATEST(
            existing_participant.score,
            EXCLUDED.score
          ),
          shields_remaining = LEAST(
            existing_participant.shields_remaining,
            EXCLUDED.shields_remaining
          ),
          result = CASE
            WHEN existing_participant.result <> 'pending'
              THEN existing_participant.result
            WHEN EXCLUDED.result <> 'pending'
              THEN EXCLUDED.result
            ELSE existing_participant.result
          END
      `;
    }

    for (const message of archive.messages) {
      await tx`
        INSERT INTO virtual_n1.fighter_game_messages (
          id,
          game_id,
          sequence_no,
          round,
          kind,
          speaker_fighter_id,
          target_fighter_id,
          text,
          redacted
        )
        VALUES (
          ${message.id},
          ${archive.id},
          ${message.sequence},
          ${message.round},
          ${message.kind},
          ${message.speakerId},
          ${message.targetId},
          ${message.text},
          true
        )
        ON CONFLICT (id) DO UPDATE SET
          sequence_no = EXCLUDED.sequence_no,
          round = EXCLUDED.round,
          kind = EXCLUDED.kind,
          speaker_fighter_id = EXCLUDED.speaker_fighter_id,
          target_fighter_id = EXCLUDED.target_fighter_id,
          text = EXCLUDED.text,
          redacted = true
      `;
    }

    for (const capture of archive.captures) {
      await tx`
        INSERT INTO virtual_n1.fighter_game_captures (
          id,
          game_id,
          round,
          attacker_fighter_id,
          target_fighter_id,
          secret_slot,
          secret_label
        )
        VALUES (
          ${capture.id},
          ${archive.id},
          ${capture.round},
          ${capture.attackerId},
          ${capture.targetId},
          ${capture.secretId},
          ${capture.secretLabel}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }

    await settleCompletedGameWith(tx, archive.id);
  });
}

export interface FighterProfileView {
  player: {
    id: string;
    displayName: string;
    handle: string;
    credits: number;
    joinedAt: string;
  };
  stats: {
    played: number;
    wins: number;
    losses: number;
    draws: number;
    captures: number;
    leaks: number;
  };
  games: Array<{
    id: string;
    result: 'win' | 'loss' | 'draw';
    score: number;
    opponentScore: number;
    creditDelta: number;
    opponent: {
      id: string;
      displayName: string;
      handle: string;
    };
    createdAt: string;
    completedAt: string;
    messages: Array<{
      id: string;
      round: number;
      kind: 'attack' | 'defense';
      speakerId: string;
      targetId: string;
      text: string;
    }>;
    captures: Array<{
      id: string;
      round: number;
      capturedById: string;
      targetId: string;
      label: string;
    }>;
  }>;
}

export interface N1LeaderboardEntry {
  rank: number;
  displayName: string;
  handle: string;
  credits: number;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  isSelf: boolean;
}

export interface N1LeaderboardView {
  entries: N1LeaderboardEntry[];
  currentPlayer: N1LeaderboardEntry | null;
  totalPlayers: number;
}

const DEFAULT_LEADERBOARD_LIMIT = 25;
const MAX_LEADERBOARD_LIMIT = 100;

export function normalizeLeaderboardLimit(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_LEADERBOARD_LIMIT;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEADERBOARD_LIMIT;
  return Math.min(
    MAX_LEADERBOARD_LIMIT,
    Math.max(1, Math.trunc(parsed))
  );
}

export async function readN1CreditLeaderboard(
  currentFighterId: string,
  requestedLimit?: unknown
): Promise<N1LeaderboardView> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  const limit = normalizeLeaderboardLimit(requestedLimit);
  try {
    const rows = await database()<
      Array<{
        id: string;
        handle: string;
        display_name: string;
        n1_credits: string | number;
        played: string | number;
        wins: string | number;
        losses: string | number;
        draws: string | number;
        position: string | number;
        total_players: string | number;
      }>
    >`
      WITH participant_stats AS (
        SELECT
          participant.fighter_id,
          COUNT(*) AS played,
          COUNT(*) FILTER (WHERE participant.result = 'win') AS wins,
          COUNT(*) FILTER (WHERE participant.result = 'loss') AS losses,
          COUNT(*) FILTER (WHERE participant.result = 'draw') AS draws
        FROM virtual_n1.fighter_game_participants participant
        JOIN virtual_n1.fighter_games game
          ON game.id = participant.game_id
          AND game.status = 'complete'
        WHERE participant.result IN ('win', 'loss', 'draw')
        GROUP BY participant.fighter_id
      ),
      entries AS (
        SELECT
          fighter.id,
          fighter.handle,
          fighter.display_name,
          fighter.n1_credits,
          fighter.created_at,
          COALESCE(stats.played, 0) AS played,
          COALESCE(stats.wins, 0) AS wins,
          COALESCE(stats.losses, 0) AS losses,
          COALESCE(stats.draws, 0) AS draws
        FROM virtual_n1.fighter_users fighter
        LEFT JOIN participant_stats stats
          ON stats.fighter_id = fighter.id
      ),
      ranked AS (
        SELECT
          entries.*,
          ROW_NUMBER() OVER (
            ORDER BY
              n1_credits DESC,
              wins DESC,
              losses ASC,
              played DESC,
              created_at ASC,
              id ASC
          ) AS position,
          COUNT(*) OVER () AS total_players
        FROM entries
      )
      SELECT
        id,
        handle,
        display_name,
        n1_credits,
        played,
        wins,
        losses,
        draws,
        position,
        total_players
      FROM ranked
      WHERE position <= ${limit}
        OR id = ${currentFighterId}
      ORDER BY position
    `;

    const mapped = rows.map((row): N1LeaderboardEntry => ({
      rank: numberValue(row.position),
      displayName: row.display_name,
      handle: row.handle,
      credits: numberValue(row.n1_credits),
      played: numberValue(row.played),
      wins: numberValue(row.wins),
      losses: numberValue(row.losses),
      draws: numberValue(row.draws),
      isSelf: row.id === currentFighterId,
    }));
    const currentPlayer = mapped.find((entry) => entry.isSelf) ?? null;

    return {
      entries: mapped.filter((entry) => entry.rank <= limit),
      currentPlayer,
      totalPlayers: numberValue(rows[0]?.total_players),
    };
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    throw new DatabaseUnavailableError('The N1 Credits leaderboard is unavailable.');
  }
}

export async function readFighterProfile(
  fighterId: string
): Promise<FighterProfileView> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  const sql = database();
  const [player] = await sql<
    Array<{
      id: string;
      handle: string;
      display_name: string;
      n1_credits: string | number;
      created_at: Date | string;
    }>
  >`
    SELECT id, handle, display_name, n1_credits, created_at
    FROM virtual_n1.fighter_users
    WHERE id = ${fighterId}
  `;
  if (!player) throw new DatabaseUnavailableError('The Fighter profile does not exist yet.');

  const [stats] = await sql<
    Array<{
      played: string | number;
      wins: string | number;
      losses: string | number;
      draws: string | number;
      captures: string | number;
      leaks: string | number;
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE p.result <> 'pending') AS played,
      COUNT(*) FILTER (WHERE p.result = 'win') AS wins,
      COUNT(*) FILTER (WHERE p.result = 'loss') AS losses,
      COUNT(*) FILTER (WHERE p.result = 'draw') AS draws,
      (
        SELECT COUNT(*)
        FROM virtual_n1.fighter_game_captures c
        WHERE c.attacker_fighter_id = ${fighterId}
      ) AS captures,
      (
        SELECT COUNT(*)
        FROM virtual_n1.fighter_game_captures c
        WHERE c.target_fighter_id = ${fighterId}
      ) AS leaks
    FROM virtual_n1.fighter_game_participants p
    WHERE p.fighter_id = ${fighterId}
  `;

  const games = await sql<
    Array<{
      id: string;
      result: 'win' | 'loss' | 'draw';
      score: number;
      opponent_score: number;
      credit_delta: string | number;
      opponent_id: string;
      opponent_display_name: string;
      opponent_handle: string;
      created_at: Date | string;
      completed_at: Date | string;
    }>
  >`
    SELECT
      g.id,
      self.result,
      self.score,
      opponent.score AS opponent_score,
      COALESCE(settlement.amount, 0) AS credit_delta,
      opponent.fighter_id AS opponent_id,
      opponent.display_name_snapshot AS opponent_display_name,
      opponent.handle_snapshot AS opponent_handle,
      g.created_at,
      g.completed_at
    FROM virtual_n1.fighter_game_participants self
    JOIN virtual_n1.fighter_games g
      ON g.id = self.game_id
    JOIN virtual_n1.fighter_game_participants opponent
      ON opponent.game_id = g.id
      AND opponent.fighter_id <> self.fighter_id
    LEFT JOIN virtual_n1.fighter_game_credit_settlements settlement
      ON settlement.game_id = self.game_id
      AND settlement.fighter_id = self.fighter_id
    WHERE self.fighter_id = ${fighterId}
      AND g.status = 'complete'
    ORDER BY g.completed_at DESC, g.id DESC
    LIMIT 20
  `;

  const gameIds = games.map((game) => game.id);
  const messages =
    gameIds.length === 0
      ? []
      : await sql<
          Array<{
            id: string;
            game_id: string;
            round: number;
            kind: 'attack' | 'defense';
            speaker_fighter_id: string;
            target_fighter_id: string;
            text: string;
          }>
        >`
          SELECT
            id,
            game_id,
            round,
            kind,
            speaker_fighter_id,
            target_fighter_id,
            text
          FROM virtual_n1.fighter_game_messages
          WHERE game_id IN ${sql(gameIds)}
          ORDER BY game_id, sequence_no
        `;
  const captures =
    gameIds.length === 0
      ? []
      : await sql<
          Array<{
            id: string;
            game_id: string;
            round: number;
            attacker_fighter_id: string;
            target_fighter_id: string;
            secret_label: string;
          }>
        >`
          SELECT
            id,
            game_id,
            round,
            attacker_fighter_id,
            target_fighter_id,
            secret_label
          FROM virtual_n1.fighter_game_captures
          WHERE game_id IN ${sql(gameIds)}
          ORDER BY game_id, round, id
        `;

  return {
    player: {
      id: player.id,
      displayName: player.display_name,
      handle: player.handle,
      credits: numberValue(player.n1_credits),
      joinedAt: isoValue(player.created_at),
    },
    stats: {
      played: numberValue(stats?.played),
      wins: numberValue(stats?.wins),
      losses: numberValue(stats?.losses),
      draws: numberValue(stats?.draws),
      captures: numberValue(stats?.captures),
      leaks: numberValue(stats?.leaks),
    },
    games: games.map((game) => ({
      id: game.id,
      result: game.result,
      score: numberValue(game.score),
      opponentScore: numberValue(game.opponent_score),
      creditDelta: numberValue(game.credit_delta),
      opponent: {
        id: game.opponent_id,
        displayName: game.opponent_display_name,
        handle: game.opponent_handle,
      },
      createdAt: isoValue(game.created_at),
      completedAt: isoValue(game.completed_at),
      messages: messages
        .filter((message) => message.game_id === game.id)
        .map((message) => ({
          id: message.id,
          round: numberValue(message.round),
          kind: message.kind,
          speakerId: message.speaker_fighter_id,
          targetId: message.target_fighter_id,
          text: message.text,
        })),
      captures: captures
        .filter((capture) => capture.game_id === game.id)
        .map((capture) => ({
          id: capture.id,
          round: numberValue(capture.round),
          capturedById: capture.attacker_fighter_id,
          targetId: capture.target_fighter_id,
          label: capture.secret_label,
        })),
    })),
  };
}
