import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDatabaseForTests, database } from './client.js';
import { settleCompletedGameWith } from './repository.js';
import { AGENT_FIGHTS_STAKE } from './wallet.js';

const ROLLBACK_SIGNAL = 'ROLLBACK_AGENT_FIGHTS_WALLET_CANARY';
const suffix = randomUUID();
const winnerId = `wallet-canary-winner-${suffix}`;
const loserId = `wallet-canary-loser-${suffix}`;
const winGameId = `wallet-canary-win-${suffix}`;
const drawGameId = `wallet-canary-draw-${suffix}`;

let report:
  | {
      winnerBalance: number;
      loserBalance: number;
      settlementMarkers: number;
      ledgerEntries: number;
      ledgerNet: number;
    }
  | undefined;

try {
  await database().begin(async (tx) => {
    await tx`
      INSERT INTO virtual_n1.fighter_users (
        id,
        handle,
        display_name,
        n1_credits
      )
      VALUES
        (${winnerId}, 'wallet-canary-winner', 'Wallet Canary Winner', 1000),
        (${loserId}, 'wallet-canary-loser', 'Wallet Canary Loser', 1000)
    `;
    await tx`
      INSERT INTO virtual_n1.fighter_games (
        id,
        status,
        current_round,
        max_rounds,
        n1_stake,
        winner_fighter_id,
        created_at,
        completed_at
      )
      VALUES
        (
          ${winGameId},
          'complete',
          1,
          100,
          ${AGENT_FIGHTS_STAKE},
          ${winnerId},
          now(),
          now()
        ),
        (
          ${drawGameId},
          'complete',
          1,
          100,
          ${AGENT_FIGHTS_STAKE},
          NULL,
          now(),
          now()
        )
    `;
    await tx`
      INSERT INTO virtual_n1.fighter_game_participants (
        game_id,
        fighter_id,
        seat,
        handle_snapshot,
        display_name_snapshot,
        score,
        shields_remaining,
        result
      )
      VALUES
        (
          ${winGameId},
          ${winnerId},
          1,
          'wallet-canary-winner',
          'Wallet Canary Winner',
          1,
          3,
          'win'
        ),
        (
          ${winGameId},
          ${loserId},
          2,
          'wallet-canary-loser',
          'Wallet Canary Loser',
          0,
          2,
          'loss'
        ),
        (
          ${drawGameId},
          ${winnerId},
          1,
          'wallet-canary-winner',
          'Wallet Canary Winner',
          0,
          3,
          'draw'
        ),
        (
          ${drawGameId},
          ${loserId},
          2,
          'wallet-canary-loser',
          'Wallet Canary Loser',
          0,
          3,
          'draw'
        )
    `;

    await settleCompletedGameWith(tx, winGameId);
    await settleCompletedGameWith(tx, winGameId);
    await settleCompletedGameWith(tx, drawGameId);
    await settleCompletedGameWith(tx, drawGameId);

    const balances = await tx<Array<{ id: string; n1_credits: string | number }>>`
      SELECT id, n1_credits
      FROM virtual_n1.fighter_users
      WHERE id = ${winnerId} OR id = ${loserId}
      ORDER BY id
    `;
    const settlements = await tx<
      Array<{
        settlement_markers: string | number;
        ledger_entries: string | number;
        ledger_net: string | number;
      }>
    >`
      SELECT
        (
          SELECT COUNT(*)
          FROM virtual_n1.fighter_game_credit_settlements
          WHERE game_id = ${winGameId} OR game_id = ${drawGameId}
        ) AS settlement_markers,
        COUNT(*) AS ledger_entries,
        COALESCE(SUM(amount), 0) AS ledger_net
      FROM virtual_n1.n1_credit_ledger
      WHERE game_id = ${winGameId} OR game_id = ${drawGameId}
    `;
    const winnerBalance = Number(
      balances.find((row) => row.id === winnerId)?.n1_credits
    );
    const loserBalance = Number(
      balances.find((row) => row.id === loserId)?.n1_credits
    );
    const summary = settlements[0];
    report = {
      winnerBalance,
      loserBalance,
      settlementMarkers: Number(summary.settlement_markers),
      ledgerEntries: Number(summary.ledger_entries),
      ledgerNet: Number(summary.ledger_net),
    };

    assert.deepEqual(report, {
      winnerBalance: 1200,
      loserBalance: 800,
      settlementMarkers: 4,
      ledgerEntries: 2,
      ledgerNet: 0,
    });
    throw new Error(ROLLBACK_SIGNAL);
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== ROLLBACK_SIGNAL) {
    throw error;
  }
} finally {
  await closeDatabaseForTests();
}

if (!report) throw new Error('The wallet canary did not complete.');
console.log(JSON.stringify({ ok: true, rolledBack: true, ...report }));
