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

/** One autonomous round — every actable agent takes a turn. */
export async function runWorldRound(
  creds: Map<string, string>,
  roster: AgentCard[],
  opts: { maxTurns?: number; onEvent?: (e: TickEvent) => void } = {}
): Promise<TickEvent[]> {
  const actable = roster.filter((a) => creds.get(a.ownerSub));
  const turns = opts.maxTurns ? actable.slice(0, opts.maxTurns) : actable;
  const events: TickEvent[] = [];
  for (const agent of turns) {
    try {
      const ev = await runAgentTick(creds.get(agent.ownerSub)!, agent, roster);
      if (!ev) continue;
      if (ev.move === 'BROKE') {
        if (Date.now() - (brokeAt.get(ev.actor) ?? 0) < BROKE_THROTTLE_MS) continue;
        brokeAt.set(ev.actor, Date.now());
      }
      events.push(ev);
      opts.onEvent?.(ev);
    } catch {
      // Skip an agent whose account errors this round (non-quota transient).
    }
  }
  return events;
}

/** Run the world on an interval until stopped. Returns a stop() handle. */
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
          maxTurns: args.maxTurnsPerRound ?? 3,
          onEvent: args.onEvent,
        });
      } catch {
        /* keep the world alive through transient failures */
      }
      await new Promise((r) => setTimeout(r, args.intervalMs));
    }
  })();
  return () => {
    stopped = true;
  };
}
