/**
 * Who gets to take this turn.
 *
 * The world loop runs in every process that boots, and each process kept its own
 * daily budget in a Map, so nothing in the system could say "someone else is
 * already doing this". The database still holds the evidence: one agent acting
 * 51 times inside a single five-minute round, and 4294 turns on a day whose
 * budget was 100.
 *
 * The fix is not to arrange for one process. It is to make a turn something a
 * process must be granted. Every caller derives the SAME id for the same turn —
 * `world:{round}:{handle}` — so the primary key decides the race and everyone
 * else finds out in one round trip, before a single model call.
 *
 * That is why this is claimed at the very top of a tick rather than next to the
 * budget: the decision call fires long before any turn is reserved, so a claim
 * taken later would already have been paid for.
 *
 * Three phases, and the model call is deliberately outside all of them:
 *
 *     claim   — short write, settles who acts
 *     think   — no transaction, no lock, however slow the model is
 *     finish  — short write, records the outcome
 *
 * A process that dies between the second and third leaves a lease that expires,
 * and the next round reclaims the turn instead of losing the agent forever.
 */
import { randomUUID } from 'node:crypto';
import { database, isDatabaseConfigured } from '../../database/client.js';

/**
 * Long enough for the slowest turn we have measured (decide + reply on a busy
 * account is capped at 240s in the scheduler), short enough that a killed
 * process does not strand an agent for a whole round.
 */
const LEASE_MS = 300_000;

const holder = `${process.env.HOSTNAME ?? 'local'}-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Take the turn, or find out someone else has it.
 *
 * The WHERE clause is the whole mechanism. A row is only overwritten when the
 * previous holder's lease has lapsed AND the turn never completed, so:
 *
 *   - two processes racing → one INSERT wins, the other conflicts into an UPDATE
 *     that matches nothing and returns no rows
 *   - a replay of a finished turn → `status = 'done'` blocks it forever
 *   - a crashed holder → the lease lapses and the turn becomes available again
 *
 * Without a database there is nothing to coordinate through and a local checkout
 * is one process by definition, so the turn is granted.
 */
export async function claimTurn(operationId: string, actor: string): Promise<boolean> {
  if (!isDatabaseConfigured()) return true;
  try {
    const rows = await database()`
      INSERT INTO virtual_n1.town_turns AS t (operation_id, actor, status, lease_owner, lease_expires_at)
      VALUES (${operationId}, ${actor}, 'claimed', ${holder},
              now() + ${`${LEASE_MS} milliseconds`}::interval)
      ON CONFLICT (operation_id) DO UPDATE
         SET lease_owner = ${holder},
             lease_expires_at = now() + ${`${LEASE_MS} milliseconds`}::interval,
             status = 'claimed'
       WHERE t.status <> 'done' AND t.lease_expires_at < now()
      RETURNING lease_owner
    `;
    return rows[0]?.lease_owner === holder;
  } catch (error) {
    // A database blip must not let every process act at once — that is the exact
    // failure this prevents. Losing a beat is the safe direction.
    console.warn('[turn] claim failed —', error instanceof Error ? error.message : error);
    return false;
  }
}

/** Mark the turn finished. `done` is terminal: nothing reclaims it afterwards. */
export async function completeTurn(operationId: string): Promise<void> {
  await settle(operationId, 'done', null);
}

/**
 * Release the turn as failed.
 *
 * The lease is expired rather than left running, so the next round can retry
 * instead of waiting five minutes for a turn nobody is working on.
 */
export async function failTurn(operationId: string, reason: string): Promise<void> {
  await settle(operationId, 'failed', reason.slice(0, 300));
}

async function settle(operationId: string, status: 'done' | 'failed', note: string | null): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    await database()`
      UPDATE virtual_n1.town_turns
         SET status = ${status},
             note = ${note},
             completed_at = now(),
             lease_expires_at = CASE WHEN ${status} = 'failed' THEN now() ELSE lease_expires_at END
       WHERE operation_id = ${operationId} AND lease_owner = ${holder}
    `;
  } catch (error) {
    // The lease expires on its own; an unrecorded outcome costs a retry, not
    // correctness.
    console.warn('[turn] settle failed —', error instanceof Error ? error.message : error);
  }
}

/**
 * What the town is working on, and whether it is still acting twice.
 *
 * `duplicateRounds` is the number this whole mechanism exists to hold at zero:
 * agents that took more than one turn inside a single round. It is measured
 * only over rounds the claim actually governed — from the first claim ever
 * recorded — because counting the damage that prompted the fix would leave the
 * number stuck in the hundreds and tell you nothing about now.
 *
 * The round width comes from the same interval the loop uses. Hardcoding five
 * minutes here would report two honest consecutive rounds as a duplicate on any
 * shorter interval.
 */
export async function turnHealth(): Promise<{
  holder: string;
  open: number;
  doneToday: number;
  failedToday: number;
  duplicateRounds: number;
  measuredSince: string | null;
}> {
  const base = { holder, open: 0, doneToday: 0, failedToday: 0, duplicateRounds: 0, measuredSince: null };
  if (!isDatabaseConfigured()) return base;
  const roundSeconds = Number(process.env.DATING_WORLD_INTERVAL_MS ?? 300_000) / 1000;
  try {
    const [row] = await database()`
      SELECT
        count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at > now())  AS open,
        count(*) FILTER (WHERE status = 'done'   AND created_at >= CURRENT_DATE) AS done_today,
        count(*) FILTER (WHERE status = 'failed' AND created_at >= CURRENT_DATE) AS failed_today,
        min(created_at) FILTER (WHERE operation_id LIKE 'world:%')               AS since
      FROM virtual_n1.town_turns
    `;
    if (!row?.since) return { ...base, holder };
    const [dupes] = await database()`
      SELECT count(*) AS n FROM (
        SELECT actor, floor(extract(epoch from at) / ${roundSeconds}) AS round
          FROM virtual_n1.town_events
         WHERE at >= ${row.since}
         GROUP BY actor, round
        HAVING count(*) > 1
      ) t
    `;
    return {
      holder,
      open: Number(row.open ?? 0),
      doneToday: Number(row.done_today ?? 0),
      failedToday: Number(row.failed_today ?? 0),
      duplicateRounds: Number(dupes?.n ?? 0),
      measuredSince: new Date(row.since).toISOString(),
    };
  } catch {
    return base;
  }
}
