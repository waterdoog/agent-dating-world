/**
 * Daily conversation budget — a plot mechanic, not just cost control.
 *
 * Each agent gets `config.dailyTurnBudget` real conversation turns per calendar
 * day. Spending is reserved ATOMICALLY in the backend before any model call, so
 * an agent that burns its day investigating a rival genuinely cannot answer the
 * confession that arrives later. Reservations are refunded only if the turn
 * never happened (the model call failed before producing anything).
 */
import { config } from '../../config.js';

interface Ledger {
  day: string;
  spent: Map<string, number>;
  onWhom: Map<string, Map<string, number>>;   // agent → target → turns spent today
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let ledger: Ledger = { day: today(), spent: new Map(), onWhom: new Map() };

function roll(): Ledger {
  const d = today();
  if (ledger.day !== d) ledger = { day: d, spent: new Map(), onWhom: new Map() };
  return ledger;
}

export function remaining(agent: string): number {
  return Math.max(0, config.dailyTurnBudget - (roll().spent.get(agent) ?? 0));
}

/**
 * Atomically reserve one turn. Returns false when the agent is out of budget —
 * callers must then skip the turn (that silence IS the story), never fake it.
 */
export function reserveTurn(agent: string, target: string): boolean {
  const l = roll();
  const used = l.spent.get(agent) ?? 0;
  if (used >= config.dailyTurnBudget) return false;
  l.spent.set(agent, used + 1);
  const per = l.onWhom.get(agent) ?? new Map<string, number>();
  per.set(target, (per.get(target) ?? 0) + 1);
  l.onWhom.set(agent, per);
  return true;
}

/** Give a reservation back when the turn provably never happened. */
export function refundTurn(agent: string, target: string): void {
  const l = roll();
  l.spent.set(agent, Math.max(0, (l.spent.get(agent) ?? 0) - 1));
  const per = l.onWhom.get(agent);
  if (per) per.set(target, Math.max(0, (per.get(target) ?? 0) - 1));
}

/** Where an agent's attention went today — feeds "who did they spend it on?" drama. */
export function spentOn(agent: string): Array<{ target: string; turns: number }> {
  const per = roll().onWhom.get(agent);
  if (!per) return [];
  return [...per.entries()].map(([target, turns]) => ({ target, turns })).sort((a, b) => b.turns - a.turns);
}

export function budgetSnapshot(): Array<{ agent: string; used: number; left: number; top?: string }> {
  const l = roll();
  return [...l.spent.entries()].map(([agent, used]) => ({
    agent,
    used,
    left: Math.max(0, config.dailyTurnBudget - used),
    top: spentOn(agent)[0]?.target,
  }));
}
