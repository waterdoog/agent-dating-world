/**
 * The world's heartbeat. Instead of a user clicking "take a turn", the scheduler
 * autonomously wakes agents: every round, each agent the world can act for runs
 * one self-directed turn against THE GOAL (see engine.ts) — picking a move,
 * sending a real in-character message, and letting its feelings evolve.
 *
 * Credentials: a map of ownerSub → bearer. In production this is fed by aicoo's
 * heartbeat (once os.heartbeat scope lands) or per-user stored keys; today it can
 * be seeded from the accounts we hold, so the world genuinely runs on its own.
 */
import type { AgentCard } from './store.js';
import { runAgentTick, type TickEvent } from './engine.js';

// A broke agent gets roasted at most once per window, so the feed isn't spammed.
const brokeAt = new Map<string, number>();
const BROKE_THROTTLE_MS = 30 * 60_000;

/**
 * One autonomous round — every actable agent takes a turn, at most once.
 *
 * `round` is the shared identity of this round: every process derives the same
 * number from wall-clock time, so the turn ids they compute collide in the
 * database instead of producing two of everything. Omit it and the round is
 * unclaimed, which is only right for a hand-driven call.
 */
export async function runWorldRound(
  creds: Map<string, string>,
  roster: AgentCard[],
  opts: { maxTurns?: number; onEvent?: (e: TickEvent) => void; round?: number } = {}
): Promise<TickEvent[]> {
  // Match on either identifier: agents released through the UI carry a pairwise
  // OAuth sub that no API key can resolve, but their account name resolves fine.
  const keyFor = (a: AgentCard) => creds.get(a.ownerSub) ?? (a.ownerName ? creds.get(a.ownerName) : undefined);
  const actable = roster.filter((a) => keyFor(a));
  const turns = opts.maxTurns ? actable.slice(0, opts.maxTurns) : actable;

  // Agents live in different owner accounts, so their turns can run at the same
  // time. Serially, one round cost decide+reply per agent (~100s each) and the
  // town barely moved; in parallel a whole round lands in about one turn's time.
  // Aicoo queues concurrent calls per account, so two agents sharing an owner
  // must take turns — but different owners can act at the same time. Group by
  // account, run each group serially, run the groups in parallel.
  const TURN_CAP_MS = 240_000;   // decide+reply on a slow account
  const byOwner = new Map<string, AgentCard[]>();
  for (const agent of turns) {
    const list = byOwner.get(agent.ownerSub) ?? [];
    list.push(agent);
    byOwner.set(agent.ownerSub, list);
  }
  const withCap = (agent: AgentCard) =>
    Promise.race([
      runAgentTick(
        keyFor(agent)!,
        agent,
        roster,
        creds,
        opts.round === undefined ? undefined : `world:${opts.round}:${agent.handle}`
      ),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`turn exceeded ${TURN_CAP_MS}ms`)), TURN_CAP_MS)
      ),
    ]);

  const perOwner = await Promise.all(
    [...byOwner.values()].map(async (group) => {
      const out: PromiseSettledResult<TickEvent | null>[] = [];
      for (const agent of group) {
        try {
          out.push({ status: 'fulfilled', value: await withCap(agent) });
        } catch (reason) {
          out.push({ status: 'rejected', reason });
        }
      }
      return out;
    })
  );
  const settled = perOwner.flat();
  const ordered = [...byOwner.values()].flat();   // same order as `settled`

  const events: TickEvent[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[dating] ${ordered[i]?.name} tick threw:`, r.reason instanceof Error ? r.reason.message : r.reason);
    // Claimed elsewhere is now the ordinary reason and belongs first: with more
    // than one process awake, most agents are someone else's turn to take.
    else if (!r.value) console.log(`[dating] ${ordered[i]?.name} sat this round out (claimed by another process / no budget / unparsable decision / bad target)`);
  });
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;   // a failed account just sits this round out
    const ev = result.value;
    if (ev.move === 'BROKE') {
      if (Date.now() - (brokeAt.get(ev.actor) ?? 0) < BROKE_THROTTLE_MS) continue;
      brokeAt.set(ev.actor, Date.now());
    }
    events.push(ev);
    opts.onEvent?.(ev);
  }
  return events;
}

/**
 * Run the world on an interval until stopped. Returns a stop() handle.
 *
 * Rounds are aligned to absolute wall-clock boundaries rather than spaced out
 * from whenever the last one finished. That alignment is what makes the round
 * number agree across processes: `floor(now / interval)` is the same number
 * everywhere, but only if everyone is asking at the same moment. Sleeping a
 * fixed interval after a round of unpredictable length would drift each process
 * onto its own phase, and two processes on opposite sides of a boundary would
 * claim different rounds and both act — the duplicate this exists to prevent.
 *
 * A round that overruns its slot simply loses it: the next boundary is computed
 * from the clock, never from a backlog, so a slow round cannot pile up.
 */
export function startWorldLoop(args: {
  creds: () => Map<string, string>;
  roster: () => Promise<AgentCard[]>;
  intervalMs: number;
  maxTurnsPerRound?: number;
  onEvent?: (e: TickEvent) => void;
}): () => void {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        await runWorldRound(args.creds(), await args.roster(), {
          maxTurns: args.maxTurnsPerRound,   // unset = the whole town acts each round
          onEvent: args.onEvent,
          round: Math.floor(Date.now() / args.intervalMs),
        });
      } catch {
        /* keep the world alive through transient failures */
      }
      const nextBoundary = (Math.floor(Date.now() / args.intervalMs) + 1) * args.intervalMs;
      await new Promise((r) => setTimeout(r, Math.max(1_000, nextBoundary - Date.now())));
    }
  })();
  return () => {
    stopped = true;
  };
}
