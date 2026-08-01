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
/** Turns this process is holding right now, so a clean exit can hand them back. */
const inFlight = new Set<string>();

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
    const won = rows[0]?.lease_owner === holder;
    if (won) inFlight.add(operationId);
    return won;
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

/**
 * Hand back whatever this process is still holding.
 *
 * Without this a restart leaves its turns claimed until the lease lapses, and
 * the agents in them stand still for the rest of the round — five minutes of a
 * dead town after every deploy, and after every file save in development.
 * Expiring them lets the next process pick them straight up.
 *
 * Safe even if the model call already produced an event: the retry carries the
 * same operation id, and the unique index on it drops the second copy.
 */
export async function releaseClaims(): Promise<void> {
  if (!isDatabaseConfigured() || !inFlight.size) return;
  const held = [...inFlight];
  inFlight.clear();
  try {
    await database()`
      UPDATE virtual_n1.town_turns SET lease_expires_at = now()
       WHERE operation_id = ANY(${held}) AND lease_owner = ${holder} AND status = 'claimed'
    `;
    console.log(`[turn] released ${held.length} in-flight turn(s) on the way out`);
  } catch {
    /* they expire on their own soon enough */
  }
}

async function settle(operationId: string, status: 'done' | 'failed', note: string | null): Promise<void> {
  inFlight.delete(operationId);
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
 * agents that took more than one CLAIMED turn inside a single round.
 *
 * Every qualifier there was earned. Counting all events would include the
 * damage that prompted the fix and leave the number stuck in the hundreds.
 * Measuring from the first claim was still wrong — events only started carrying
 * the id of the turn that produced them later, so the window opened on rows
 * that had no identity to be judged by, and reported six duplicates that were
 * six honest rounds seen through the wrong ruler. Hand-driven turns carry no id
 * either, and two of those in a row is a player clicking twice, not a bug.
 *
 * So: only beats that name their turn, and only from the first one that did.
 * The round width comes from the interval the loop actually uses — five minutes
 * hardcoded would call two honest consecutive rounds a duplicate on any shorter
 * setting.
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
    // Agent turns only. The same table also claims the digest window and the
    // year-end write, and counting those here would quietly inflate the number
    // of turns the town took.
    const [row] = await database()`
      SELECT
        count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at > now())  AS open,
        count(*) FILTER (WHERE status = 'done'   AND created_at >= CURRENT_DATE) AS done_today,
        count(*) FILTER (WHERE status = 'failed' AND created_at >= CURRENT_DATE) AS failed_today
      FROM virtual_n1.town_turns
      WHERE operation_id LIKE 'world:%'
    `;
    const [first] = await database()`
      SELECT min(at) AS since FROM virtual_n1.town_events WHERE operation_id IS NOT NULL
    `;
    if (!first?.since) return { ...base, holder };
    const [dupes] = await database()`
      SELECT count(*) AS n FROM (
        SELECT actor, floor(extract(epoch from at) / ${roundSeconds}) AS round
          FROM virtual_n1.town_events
         WHERE at >= ${first.since} AND operation_id IS NOT NULL
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
      measuredSince: new Date(first.since).toISOString(),
    };
  } catch {
    return base;
  }
}
