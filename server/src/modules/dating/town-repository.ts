/**
 * The town's durable state, in Postgres.
 *
 * This replaces two earlier stopgaps: module-level Maps (wiped on every restart,
 * and `tsx watch` restarts constantly) and Aicoo notes (a document store standing
 * in for a database). Money, wanted levels, who-knows-what, relationship readings
 * and the event stream all need querying by person, by pair and by time — that is
 * what SQL is for, and the project already runs a Supabase Postgres with a
 * `virtual_n1` schema.
 *
 * Two rules:
 *
 *  1. **Spending is a single guarded UPDATE.** `UPDATE … WHERE purse >= $n`
 *     returns zero rows when the money is not there, so two concurrent purchases
 *     cannot both succeed. The old read-then-write had a genuine race.
 *  2. **No database is not an error.** `isDatabaseConfigured()` gates every call;
 *     without one the callers fall back to their in-memory behaviour, exactly as
 *     Agent Fights' wallet already does. A local checkout still runs.
 */
import { database, isDatabaseConfigured } from '../../database/client.js';

export const townDbReady = (): boolean => isDatabaseConfigured();

const key = (name: string) => name.trim().toLowerCase();

// ── money & heat ─────────────────────────────────────────────────────

export interface TownAgentRow {
  agent: string;
  purse: number;
  wantedLevel: number;
  wantedAt: number | null;
  wantedReasons: string[];
}

/** Read (creating the row with the starting purse if this is a new arrival). */
export async function loadAgent(name: string, startCash = 200): Promise<TownAgentRow> {
  const sql = database();
  const [row] = await sql`
    INSERT INTO virtual_n1.town_agents (agent, purse)
    VALUES (${key(name)}, ${startCash})
    ON CONFLICT (agent) DO UPDATE SET updated_at = now()
    RETURNING agent, purse, wanted_level, wanted_at, wanted_reasons
  `;
  return {
    agent: row.agent,
    purse: row.purse,
    wantedLevel: row.wanted_level,
    wantedAt: row.wanted_at ? new Date(row.wanted_at).getTime() : null,
    wantedReasons: (row.wanted_reasons ?? []) as string[],
  };
}

/** Take money. Returns the new balance, or null when it could not be afforded. */
export async function debit(name: string, amount: number): Promise<number | null> {
  const sql = database();
  const rows = await sql`
    UPDATE virtual_n1.town_agents
       SET purse = purse - ${amount}, updated_at = now()
     WHERE agent = ${key(name)} AND purse >= ${amount}
     RETURNING purse
  `;
  return rows.length ? rows[0].purse : null;
}

/** Money moves rather than evaporating — the other half of a real transaction. */
export async function credit(name: string, amount: number): Promise<number> {
  const sql = database();
  const [row] = await sql`
    INSERT INTO virtual_n1.town_agents (agent, purse) VALUES (${key(name)}, ${200 + amount})
    ON CONFLICT (agent) DO UPDATE SET purse = virtual_n1.town_agents.purse + ${amount}, updated_at = now()
    RETURNING purse
  `;
  return row.purse;
}

export async function setWanted(name: string, level: number, reasons: string[]): Promise<void> {
  const sql = database();
  await sql`
    INSERT INTO virtual_n1.town_agents (agent, wanted_level, wanted_at, wanted_reasons)
    VALUES (${key(name)}, ${level}, now(), ${sql.json(reasons)})
    ON CONFLICT (agent) DO UPDATE
      SET wanted_level = ${level}, wanted_at = now(),
          wanted_reasons = ${sql.json(reasons)}, updated_at = now()
  `;
}

export async function clearWantedRow(name: string): Promise<void> {
  const sql = database();
  await sql`
    UPDATE virtual_n1.town_agents
       SET wanted_level = 0, wanted_at = NULL, wanted_reasons = '[]'::jsonb, updated_at = now()
     WHERE agent = ${key(name)}
  `;
}

export async function wantedRows(): Promise<TownAgentRow[]> {
  const sql = database();
  const rows = await sql`
    SELECT agent, purse, wanted_level, wanted_at, wanted_reasons
      FROM virtual_n1.town_agents WHERE wanted_level > 0 ORDER BY wanted_level DESC
  `;
  return rows.map((r) => ({
    agent: r.agent, purse: r.purse, wantedLevel: r.wanted_level,
    wantedAt: r.wanted_at ? new Date(r.wanted_at).getTime() : null,
    wantedReasons: (r.wanted_reasons ?? []) as string[],
  }));
}

// ── carried items ────────────────────────────────────────────────────

export async function addItem(name: string, item: string): Promise<void> {
  const sql = database();
  await sql`INSERT INTO virtual_n1.town_items (agent, item) VALUES (${key(name)}, ${item})`;
}

export async function heldItems(name: string): Promise<string[]> {
  const sql = database();
  const rows = await sql`
    SELECT item FROM virtual_n1.town_items
     WHERE agent = ${key(name)} AND spent_at IS NULL ORDER BY bought_at
  `;
  return rows.map((r) => r.item as string);
}

/** Spend one held item on someone. False when they are not carrying it. */
export async function spendItem(name: string, item: string, on: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`
    UPDATE virtual_n1.town_items SET spent_on = ${key(on)}, spent_at = now()
     WHERE id = (
       SELECT id FROM virtual_n1.town_items
        WHERE agent = ${key(name)} AND item = ${item} AND spent_at IS NULL
        ORDER BY bought_at LIMIT 1
     )
     RETURNING id
  `;
  return rows.length > 0;
}

/** Real gift history — what the florist genuinely remembers. */
export async function giftHistory(limit = 5): Promise<Array<{ from: string; to: string; item: string; at: number }>> {
  const sql = database();
  const rows = await sql`
    SELECT agent, spent_on, item, spent_at FROM virtual_n1.town_items
     WHERE spent_at IS NOT NULL ORDER BY spent_at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ from: r.agent, to: r.spent_on, item: r.item, at: new Date(r.spent_at).getTime() }));
}

// ── knowledge ────────────────────────────────────────────────────────

export async function addKnowledge(k: { holder: string; about: string; fact: string; source: string }): Promise<void> {
  const sql = database();
  await sql`
    INSERT INTO virtual_n1.town_knowledge (holder, about, fact, source)
    VALUES (${key(k.holder)}, ${k.about}, ${k.fact}, ${k.source})
  `;
}

export async function knowledgeOf(holder: string, limit = 8): Promise<Array<{ about: string; fact: string; source: string; at: number }>> {
  const sql = database();
  const rows = await sql`
    SELECT about, fact, source, at FROM virtual_n1.town_knowledge
     WHERE holder = ${key(holder)} ORDER BY at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ about: r.about, fact: r.fact, source: r.source, at: new Date(r.at).getTime() }));
}

// ── relationships (directed) ─────────────────────────────────────────

export interface RelRow {
  handle: string;
  attraction: number;
  trust: number;
  tension: number;
  /** 好奇 · 依恋 · 占有欲 — the three dimensions beyond the original three. */
  curiosity?: number;
  attachment?: number;
  possessiveness?: number;
  note: string;
  at?: number;
  beats?: number;
  guessAttraction?: number;
  guessTrust?: number;
}

export async function loadRels(agent: string): Promise<RelRow[]> {
  const sql = database();
  const rows = await sql`
    SELECT other, attraction, trust, tension, curiosity, attachment, possessiveness,
           note, at, beats, guess_attraction, guess_trust
      FROM virtual_n1.town_relationships WHERE agent = ${key(agent)}
  `;
  return rows.map((r) => ({
    handle: r.other,
    attraction: r.attraction, trust: r.trust, tension: r.tension,
    curiosity: r.curiosity ?? undefined,
    attachment: r.attachment ?? undefined,
    possessiveness: r.possessiveness ?? undefined,
    note: r.note ?? '',
    at: r.at ? new Date(r.at).getTime() : undefined,
    beats: r.beats,
    guessAttraction: r.guess_attraction ?? undefined,
    guessTrust: r.guess_trust ?? undefined,
  }));
}

/** Upsert one directed reading. `beats` counts real exchanges, for 依恋. */
export async function saveRel(agent: string, rel: RelRow): Promise<void> {
  const sql = database();
  await sql`
    INSERT INTO virtual_n1.town_relationships
      (agent, other, attraction, trust, tension, curiosity, attachment, possessiveness,
       note, at, beats, guess_attraction, guess_trust)
    VALUES (
      ${key(agent)}, ${key(rel.handle)}, ${rel.attraction}, ${rel.trust}, ${rel.tension},
      ${rel.curiosity ?? null}, ${rel.attachment ?? null}, ${rel.possessiveness ?? null},
      ${rel.note ?? ''}, now(), 1, ${rel.guessAttraction ?? null}, ${rel.guessTrust ?? null}
    )
    ON CONFLICT (agent, other) DO UPDATE SET
      attraction = ${rel.attraction}, trust = ${rel.trust}, tension = ${rel.tension},
      curiosity = ${rel.curiosity ?? null},
      attachment = ${rel.attachment ?? null},
      possessiveness = ${rel.possessiveness ?? null},
      note = ${rel.note ?? ''}, at = now(),
      beats = virtual_n1.town_relationships.beats + 1,
      guess_attraction = ${rel.guessAttraction ?? null},
      guess_trust = ${rel.guessTrust ?? null}
  `;
}

/**
 * Every directed reading in one query — what makes cross-agent analysis possible
 * at all. While these lived in per-owner Aicoo notes, "who is misreading whom"
 * could not be asked without walking every workspace.
 */
export async function allRels(): Promise<Array<{ agent: string; other: string; attraction: number; guessAttraction: number | null }>> {
  const sql = database();
  const rows = await sql`SELECT agent, other, attraction, guess_attraction FROM virtual_n1.town_relationships`;
  return rows.map((r) => ({
    agent: r.agent, other: r.other,
    attraction: Number(r.attraction),
    guessAttraction: r.guess_attraction === null ? null : Number(r.guess_attraction),
  }));
}

// ── events ───────────────────────────────────────────────────────────

export async function saveEvent(e: Record<string, unknown>): Promise<void> {
  const sql = database();
  await sql`
    INSERT INTO virtual_n1.town_events (
      actor, target, act, move, silent, message, reply, lines, observable,
      attraction, trust, tension, guess_attraction, guess_trust,
      severity, headline, summary, consequence, followup, destination,
      decide_run_id, reply_run_id, status
    ) VALUES (
      ${String(e.actor ?? '')}, ${(e.target as string) ?? null}, ${(e.act as string) ?? null},
      ${(e.move as string) ?? null}, ${Boolean(e.silent)}, ${(e.message as string) ?? null},
      ${(e.reply as string) ?? null}, ${e.lines ? sql.json(e.lines as never) : null},
      ${(e.observable as string) ?? null},
      ${(e.attraction as number) ?? null}, ${(e.trust as number) ?? null}, ${(e.tension as number) ?? null},
      ${(e.guessAttraction as number) ?? null}, ${(e.guessTrust as number) ?? null},
      ${(e.severity as string) ?? null}, ${(e.headline as string) ?? null},
      ${(e.summary as string) ?? null}, ${(e.consequence as string) ?? null},
      ${(e.followup as string) ?? null}, ${(e.destination as string) ?? null},
      ${(e.decideRunId as string) ?? null}, ${(e.replyRunId as string) ?? null},
      ${(e.status as string) ?? null}
    )
  `;
}

export async function recentEvents(limit = 40): Promise<Record<string, unknown>[]> {
  const sql = database();
  const rows = await sql`
    SELECT * FROM virtual_n1.town_events ORDER BY at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({
    actor: r.actor, target: r.target, act: r.act, move: r.move, silent: r.silent,
    message: r.message ?? '', reply: r.reply ?? '', lines: r.lines, observable: r.observable,
    attraction: r.attraction, trust: r.trust, tension: r.tension,
    guessAttraction: r.guess_attraction, guessTrust: r.guess_trust,
    severity: r.severity, headline: r.headline, summary: r.summary,
    consequence: r.consequence, followup: r.followup, destination: r.destination,
    decideRunId: r.decide_run_id, replyRunId: r.reply_run_id, status: r.status,
    at: new Date(r.at).getTime(),
  }));
}

/**
 * Where this agent habitually goes.
 *
 * A "routine" is not something to configure — it is what the agent has actually
 * been doing, read back out of the event stream. That makes a deviation from it
 * measurable rather than asserted: "Kehan 改了路线，经过东广场两次" is only a
 * story if there is a route it normally takes.
 */
export async function habitOf(agent: string, since = 7 * 24 * 3600_000): Promise<Array<{ place: string; visits: number }>> {
  const sql = database();
  const rows = await sql`
    SELECT destination AS place, count(*)::int AS visits
      FROM virtual_n1.town_events
     WHERE actor = ${agent} AND destination IS NOT NULL
       AND at > now() - ${`${Math.round(since / 1000)} seconds`}::interval
     GROUP BY destination ORDER BY visits DESC
  `;
  return rows.map((r) => ({ place: r.place as string, visits: r.visits as number }));
}

/** Who else was recorded at a place recently — the basis for a real run-in. */
export async function whoWasAt(place: string, withinMs = 20 * 60_000): Promise<string[]> {
  const sql = database();
  const rows = await sql`
    SELECT DISTINCT actor FROM virtual_n1.town_events
     WHERE destination = ${place} AND at > now() - ${`${Math.round(withinMs / 1000)} seconds`}::interval
  `;
  return rows.map((r) => r.actor as string);
}

/** Beats between one pair, newest first — what the trajectory detectors read. */
export async function pairHistory(a: string, b: string, limit = 20): Promise<Record<string, unknown>[]> {
  const sql = database();
  const rows = await sql`
    SELECT actor, target, act, move, silent, observable, headline, tension, attraction, at
      FROM virtual_n1.town_events
     WHERE (actor = ${a} AND target = ${b}) OR (actor = ${b} AND target = ${a})
     ORDER BY at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, at: new Date(r.at as string).getTime() }));
}
