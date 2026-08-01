/**
 * Daily conversation budget — a plot mechanic, not just cost control.
 *
 * Each agent gets `config.dailyTurnBudget` real conversation turns per calendar
 * day. An agent that burns its day investigating a rival genuinely cannot answer
 * the confession that arrives later. Reservations are refunded only if the turn
 * never happened (the model call failed before producing anything).
 *
 * This used to be a module-level Map, and the comment above it claimed the
 * reservation was atomic. It was — inside one Node process. The world loop runs
 * in every process that imports the BFF, so thirty-one of them each kept a
 * private ledger, each saw 0/100 used, and each said yes. The database recorded
 * 4294 turns on a day the budget allowed 100.
 *
 * The limit now lives in one row that every process contends for. The agent's
 * day total is the row with `target = ''`; a single `ON CONFLICT DO UPDATE …
 * WHERE turns < cap` both checks and increments it, so the row lock does the
 * serialising and no caller can observe a stale count. Per-target rows record
 * where the attention went and are deliberately not part of the limit.
 *
 * Without a database the in-memory ledger is kept: a local checkout with no
 * Postgres is a single process by definition, and the town still runs.
 */
import { config } from '../../config.js';
import { database, isDatabaseConfigured } from '../../database/client.js';

const TOTAL = '';   // the sentinel target that holds the day total

// ── in-memory fallback (no database configured) ──────────────────────

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

// ── the API, unchanged in shape and now asynchronous ─────────────────

export async function remaining(agent: string): Promise<number> {
  if (!isDatabaseConfigured()) {
    return Math.max(0, config.dailyTurnBudget - (roll().spent.get(agent) ?? 0));
  }
  try {
    const [row] = await database()`
      SELECT turns FROM virtual_n1.town_budget
       WHERE day = CURRENT_DATE AND agent = ${agent} AND target = ${TOTAL}
    `;
    return Math.max(0, config.dailyTurnBudget - Number(row?.turns ?? 0));
  } catch (error) {
    // Reporting a budget we cannot read as spent would silence the whole town
    // over a transient blip. The reservation itself still fails closed.
    console.warn('[budget] remaining failed —', error instanceof Error ? error.message : error);
    return config.dailyTurnBudget;
  }
}

/**
 * Reserve one turn. Returns false when the agent is out of budget — callers must
 * then skip the turn (that silence IS the story), never fake it.
 *
 * The RETURNING row is the proof: `ON CONFLICT DO UPDATE` matches nothing once
 * the total reaches the cap, so a caller that gets no row was refused.
 */
export async function reserveTurn(agent: string, target: string): Promise<boolean> {
  if (config.dailyTurnBudget <= 0) return false;
  if (!isDatabaseConfigured()) {
    const l = roll();
    const used = l.spent.get(agent) ?? 0;
    if (used >= config.dailyTurnBudget) return false;
    l.spent.set(agent, used + 1);
    const per = l.onWhom.get(agent) ?? new Map<string, number>();
    per.set(target, (per.get(target) ?? 0) + 1);
    l.onWhom.set(agent, per);
    return true;
  }
  try {
    const rows = await database()`
      INSERT INTO virtual_n1.town_budget AS b (day, agent, target, turns)
      VALUES (CURRENT_DATE, ${agent}, ${TOTAL}, 1)
      ON CONFLICT (day, agent, target) DO UPDATE
         SET turns = b.turns + 1
       WHERE b.turns < ${config.dailyTurnBudget}
      RETURNING turns
    `;
    if (!rows.length) return false;
  } catch (error) {
    // Fail closed: an unrecorded turn is a turn that could be taken again by
    // every other process, which is the overspend this replaced.
    console.warn('[budget] reserve failed —', error instanceof Error ? error.message : error);
    return false;
  }
  // Attribution only — never gates the turn, so a failure here costs a line in
  // the yearbook rather than a beat in the town.
  if (target) void bump(agent, target, 1);
  return true;
}

/** Give a reservation back when the turn provably never happened. */
export async function refundTurn(agent: string, target: string): Promise<void> {
  if (!isDatabaseConfigured()) {
    const l = roll();
    l.spent.set(agent, Math.max(0, (l.spent.get(agent) ?? 0) - 1));
    const per = l.onWhom.get(agent);
    if (per) per.set(target, Math.max(0, (per.get(target) ?? 0) - 1));
    return;
  }
  await bump(agent, TOTAL, -1);
  if (target) await bump(agent, target, -1);
}

/** Move one counter. `GREATEST` keeps the CHECK (turns >= 0) satisfied. */
async function bump(agent: string, target: string, by: number): Promise<void> {
  try {
    await database()`
      INSERT INTO virtual_n1.town_budget AS b (day, agent, target, turns)
      VALUES (CURRENT_DATE, ${agent}, ${target}, ${Math.max(0, by)})
      ON CONFLICT (day, agent, target) DO UPDATE
         SET turns = GREATEST(0, b.turns + ${by})
    `;
  } catch (error) {
    console.warn('[budget] bump failed —', error instanceof Error ? error.message : error);
  }
}

/** Where an agent's attention went today — feeds "who did they spend it on?" drama. */
export async function spentOn(agent: string): Promise<Array<{ target: string; turns: number }>> {
  if (!isDatabaseConfigured()) {
    const per = roll().onWhom.get(agent);
    if (!per) return [];
    return [...per.entries()]
      .map(([target, turns]) => ({ target, turns }))
      .sort((a, b) => b.turns - a.turns);
  }
  try {
    const rows = await database()`
      SELECT target, turns FROM virtual_n1.town_budget
       WHERE day = CURRENT_DATE AND agent = ${agent} AND target <> ${TOTAL} AND turns > 0
       ORDER BY turns DESC
    `;
    return rows.map((r) => ({ target: String(r.target), turns: Number(r.turns) }));
  } catch {
    return [];
  }
}

export async function budgetSnapshot(): Promise<Array<{ agent: string; used: number; left: number; top?: string }>> {
  if (!isDatabaseConfigured()) {
    const l = roll();
    return Promise.all(
      [...l.spent.entries()].map(async (entry) => ({
        agent: entry[0],
        used: entry[1],
        left: Math.max(0, config.dailyTurnBudget - entry[1]),
        top: (await spentOn(entry[0]))[0]?.target,
      }))
    );
  }
  try {
    // One query for both halves: the total row per agent, and that agent's
    // busiest target, ranked in SQL rather than by fetching every row.
    const rows = await database()`
      SELECT total.agent,
             total.turns AS used,
             (SELECT t.target FROM virtual_n1.town_budget t
               WHERE t.day = total.day AND t.agent = total.agent AND t.target <> ${TOTAL}
               ORDER BY t.turns DESC LIMIT 1) AS top
        FROM virtual_n1.town_budget total
       WHERE total.day = CURRENT_DATE AND total.target = ${TOTAL}
       ORDER BY total.turns DESC
    `;
    return rows.map((r) => ({
      agent: String(r.agent),
      used: Number(r.used),
      left: Math.max(0, config.dailyTurnBudget - Number(r.used)),
      top: r.top ? String(r.top) : undefined,
    }));
  } catch (error) {
    console.warn('[budget] snapshot failed —', error instanceof Error ? error.message : error);
    return [];
  }
}
