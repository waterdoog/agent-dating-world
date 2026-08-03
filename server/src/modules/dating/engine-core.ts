/**
 * The town's rules, with nothing plugged in.
 *
 * Every function here is pure: same inputs, same output, no network, no
 * database, no clock it did not receive as an argument. That is the entire
 * point. `engine.ts` is 1800 lines of orchestration around model calls and
 * workspaces, and none of it could be tested — so the rules underneath it were
 * only ever exercised by running a real world round, waiting five minutes and
 * reading the database afterwards.
 *
 * The bugs that reached production say what that cost. Every one of them lived
 * in a function on this page:
 *
 *   · `destinationOf` was defined and never called, so every event carried a
 *     null destination and the trajectory detector had no input at all.
 *   · `seedDimensions` read `beats` as a conversation count when it counts
 *     writes, pinning curiosity at 0.00 for every relationship in the town.
 *   · the similarity threshold was tuned on Latin whitespace, so on Chinese —
 *     which does not use it — a whole clause came back as one token and the
 *     duplicate-promise detector, the best drama trigger in the system, almost
 *     never fired.
 *   · `parseMove` dropped any decision without a target, silently, including
 *     the "go to work alone" the model kept producing.
 *
 * A unit test would have caught all four in seconds. Agent Fights already works
 * this way — `fighter-world-core.ts`, 952 lines, zero I/O, nineteen tests — and
 * this is the same split applied to the square.
 *
 * The rule for what belongs here: if it needs a bearer, a share token or a
 * database handle, it belongs in `engine.ts`. If it only needs facts, it
 * belongs here and it gets a test.
 */
import type { AgentCard } from './store.js';
import type { OfferKind } from './town-life.js';

// ── readings ─────────────────────────────────────────────────────────

export interface Rel {
  handle: string;
  attraction: number;   // desire / pull
  trust: number;        // how safe & reliable they feel (betrayal drives this down)
  tension: number;      // friction / rivalry / threat
  /**
   * 好奇 · 依恋 · 占有欲 — the rest of the five dimensions.
   *
   * Three numbers could not tell "患得患失" (high attraction, low trust) apart
   * from "好朋友" (high trust, low attraction) in terms of what an agent would
   * DO about it. Tension stays alongside them as a sixth: the five are how I
   * feel about you, tension is the friction between us, and it is load-bearing
   * for the saturation brake, the stage gate and the feed's conflict count.
   *
   * Optional because existing rows predate them; `seedDimensions` fills them in
   * from real data on first read rather than guessing.
   */
  curiosity?: number;      // 好奇 — starts high with a stranger, fades with familiarity
  attachment?: number;     // 依恋 — grows with real interactions
  possessiveness?: number; // 占有欲 — no honest source, starts neutral
  note: string;
  /** When this relationship last moved — decay is measured from here. */
  at?: number;
  /** Consecutive beats spent pinned at high tension, for the saturation breaker. */
  stuck?: number;
  /** How many real exchanges this pair has had — the honest source for 依恋. */
  beats?: number;
  /**
   * Theory of mind — what this agent GUESSES the other feels back. Kept apart
   * from the real reading on purpose: the gap between guess and truth is the
   * whole source of misreading, one-sided love and missed timing.
   */
  guessAttraction?: number;
  guessTrust?: number;
}

export type Severity = 'ambient' | 'relationship' | 'drama';

/** One spoken line inside an exchange, with the model run that produced it. */
export interface Line {
  speaker: string;
  text: string;
  runId?: string;
}

export interface TickEvent {
  actor: string;
  target: string;
  move: string;
  /**
   * Which claimed turn produced this beat, when one did. Carried through to the
   * event row so a turn retaken after its lease expired cannot record a second
   * version of the same moment. Absent for hand-driven turns, which are new
   * events every time.
   */
  operationId?: string;
  /** The costly, observable behaviour this beat consisted of. */
  act?: string;
  /** What a bystander (or the target) could actually see, if anything. */
  observable?: string;
  /** True when nothing was said — the target may not even know it happened. */
  silent?: boolean;
  /** The actor's guess at how the target feels about it (theory of mind). */
  guessAttraction?: number;
  guessTrust?: number;
  /** 好奇 · 依恋 · 占有欲 — the readings beyond attraction/trust/tension. */
  curiosity?: number;
  attachment?: number;
  possessiveness?: number;
  /** First line and first reply. Kept so existing feed/plaza code is unchanged. */
  message: string;
  reply: string;
  /**
   * The whole exchange in order. A beat used to be exactly two lines because
   * there was nowhere to put a third — multi-turn was not throttled, it was
   * unrepresentable. `message`/`reply` are now just lines[0] and lines[1].
   */
  lines?: Line[];
  attraction: number;
  trust: number;
  tension: number;
  note: string;
  severity: Severity;
  headline: string;    // third-person beat: what just happened
  summary: string;     // cause + action + consequence + suspense
  consequence: string; // the relationship shift, one clause
  followup: string;    // the hook — what might happen next
  // ── traceability: every town event points back at the real execution ──
  decideRunId?: string;   // the model run that chose the target and the line
  replyRunId?: string;    // the model run that answered
  turnsLeft?: number;     // the actor's remaining conversation budget today
  status?: 'ok' | 'failed' | 'timeout' | 'queued' | 'no-budget';
  destination?: string;   // the place this beat names — both parties head there
}

export interface Move {
  /** The observable ACT — this is the signal. Speech is optional decoration. */
  act: string;
  move: string;
  crime?: string;
  target: string;
  /** May be empty: acting without speaking is a legal, often stronger, beat. */
  message: string;
  /** The part of the act others can see. Empty when nobody witnessed it. */
  observable: string;
  /**
   * Where this beat happens, chosen by the agent.
   *
   * Location used to be REVERSE-PARSED out of the line ("if the sentence
   * contains 酒馆, they must be at the bar"), which meant going somewhere was
   * not an act an agent could take — only a place it could mention. Walking a
   * longer way round, waiting where someone usually passes, or simply going to
   * work were all inexpressible. Naming it makes movement a first-class move.
   */
  place: string;
  dAttraction: number;   // how much THIS beat moved the reading — applied to the standing value
  dTrust: number;
  dTension: number;
  /**
   * Theory of mind: what the actor now GUESSES the target feels toward IT.
   * The gap between this and the target's real reading is where misreading,
   * unrequited love and missed chances come from — so it is stored, not scored.
   */
  guessAttraction: number;
  guessTrust: number;
  note: string;
  severity: Severity;
  headline: string;
  summary: string;
  consequence: string;
  followup: string;
}

// ── numbers ──────────────────────────────────────────────────────────

export const clamp01 = (v: unknown) => Math.max(0, Math.min(1, +(v ?? 0) || 0));
/** A single beat may only nudge a reading — a real reversal is ±0.3 at most. */
export const clampDelta = (v: unknown) => Math.max(-0.3, Math.min(0.3, +(v ?? 0) || 0));
const SEVERITIES: Severity[] = ['ambient', 'relationship', 'drama'];
export const asSeverity = (v: unknown): Severity =>
  SEVERITIES.includes(v as Severity) ? (v as Severity) : 'relationship';

export const strip = (t: string | null) => (t ?? '').split(/\n*<suggestions?>/i)[0].trim();

// ── the behaviour vocabulary ─────────────────────────────────────────

/**
 * Costly, observable acts — the point of the whole layer is that saying
 * something fierce is free (so it carries no information), while going back
 * through what someone said three months ago costs a turn and therefore means
 * something.
 */
export const ACTS = new Set([
  'LINGER', 'READ_BACK', 'ASK_AROUND', 'DETOUR', 'PRETEXT',
  'CALLBACK', 'GIFT', 'SHARE_SECRET', 'CHANGE_HABIT',
  'GO_QUIET', 'WITHDRAW', 'GO_PUBLIC', 'SPEAK_ONLY', 'NOTHING',
  // Costly kindness. The town had a whole malicious economy (steal a letter,
  // bribe a vendor, wreck a date) and no way at all to spend money on someone
  // you like — so warmth had nowhere to go but talk.
  'BUY_FLOWER', 'BOOK_BOOTH', 'ASK_VENDOR', 'LISTEN_BENCH',
]);

/**
 * What the costly acts actually cost, and who they are transacted with.
 *
 * Kept beside the vocabulary that names them on purpose: `ACTS` says
 * BUY_FLOWER is a legal thing to do and this says what happens when you do it.
 * Split across two files they drift, and an act the model is offered but the
 * town cannot execute is a turn thrown away.
 */
export const ACT_OFFERS: Record<string, { npc: string; kind: OfferKind; cost: number }> = {
  BUY_FLOWER: { npc: 'florist', kind: 'buy-item', cost: 20 },
  BOOK_BOOTH: { npc: 'bar', kind: 'book-booth', cost: 40 },
  ASK_VENDOR: { npc: 'florist', kind: 'who-gifted', cost: 35 },
  LISTEN_BENCH: { npc: 'gossip', kind: 'hear-rumour', cost: 10 },
};

/** Places an agent may name — mirrors town-map.ts. */
export const PLACE_IDS = new Set(['plaza', 'clock', 'market', 'alley', 'bar', 'backalley', 'bench', 'florist']);

export const SILENT_ACTS = new Set(['LINGER', 'READ_BACK', 'ASK_AROUND', 'DETOUR', 'GO_QUIET', 'WITHDRAW', 'NOTHING']);

/**
 * `move` was never validated, so the model could return prose ("转向别人") and it
 * flowed straight into the feed and the thread index as if it were an enum.
 */
export const MOVES = new Set([
  'APPROACH', 'DEEPEN', 'COOL', 'REACT', 'SCHEME', 'ALLY', 'WAIT',
  'INVESTIGATE', 'BETRAY', 'CRIME', 'CONFESS', 'REJECT', 'EXPOSE', 'LEAVE',
]);

/**
 * Read a decision out of whatever the model returned.
 *
 * Returns null for anything unusable. The caller is expected to notice and ask
 * again rather than to drop the round: a decision that names nobody has already
 * cost a full model call, and silently discarding it is how the town spent a
 * whole evening looking idle while every turn was in fact being thrown away.
 */
export function parseMove(raw: string): Move | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    // A beat needs a target and an act. It does NOT need speech — silence is a
    // legal output, and rejecting it here is what forced every tick to talk.
    if (!p.target) return null;
    const act = String(p.act ?? 'SPEAK_ONLY').trim().toUpperCase();
    const message = String(p.message ?? '').trim();
    if (!message && !ACTS.has(act)) return null;   // no words AND no real act = nothing happened
    return {
      act: ACTS.has(act) ? act : 'SPEAK_ONLY',
      move: MOVES.has(String(p.move ?? '').trim().toUpperCase()) ? String(p.move).trim().toUpperCase() : 'APPROACH',
      crime: p.crime ? String(p.crime) : undefined,
      target: String(p.target),
      message,
      observable: String(p.observable ?? '').trim(),
      place: PLACE_IDS.has(String(p.place ?? '').trim()) ? String(p.place).trim() : '',
      dAttraction: clampDelta(p.dAttraction),
      dTrust: clampDelta(p.dTrust),
      dTension: clampDelta(p.dTension),
      guessAttraction: clamp01(Number(p.guessAttraction) || 0),
      guessTrust: clamp01(Number(p.guessTrust) || 0),
      note: String(p.note ?? ''),
      // The actor no longer writes these; the observer fills them in after the
      // exchange. These are the fallbacks used when that call fails — plain and
      // factual rather than an invented drama title.
      severity: asSeverity(p.severity ?? 'ambient'),
      headline: String(p.headline ?? '').trim(),
      summary: String(p.summary ?? '').trim(),
      consequence: String(p.consequence ?? '').trim(),
      followup: String(p.followup ?? '').trim(),
    };
  } catch {
    return null;
  }
}

// ── repetition ───────────────────────────────────────────────────────

/**
 * Is this line just a rewording of the last one? Compares character bigrams,
 * which catches "酒馆后门九点，你站哪边" vs "九点酒馆后门，你到底偏谁" — the
 * failure mode the prompt kept producing.
 */
export function tooSimilar(a: string, b: string): boolean {
  const grams = (t: string) => {
    const clean = t.replace(/[\s，。！？、,.!?"'“”「」]/g, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const A = grams(a), Bg = grams(b);
  if (!A.size || !Bg.size) return false;
  let shared = 0;
  for (const g of A) if (Bg.has(g)) shared++;
  // Measured on the beats this actually failed on: genuine repeats score
  // 0.37–0.58, unrelated lines 0.00–0.06. 0.30 sits in the gap.
  return shared / Math.min(A.size, Bg.size) > 0.3;
}

// ── the governors ────────────────────────────────────────────────────

/**
 * Three mechanical governors, all deliberately NOT prompt rules.
 *
 * Asking the model to "choose NOTHING when there is no reason to speak" does not
 * work — it is trained to produce content, and measured 0 silent beats out of 2.
 * Silence has to be taken away from it, not requested.
 */

/** Beats spent on this exact pair inside the recent feed window. */
export function pairBeats(actor: string, target: string, recent: TickEvent[], window = 12): TickEvent[] {
  const a = actor.toLowerCase(), t = target.toLowerCase();
  return recent.slice(0, window).filter((e) => {
    const x = e.actor.toLowerCase(), y = (e.target ?? '').toLowerCase();
    return (x === a && y === t) || (x === t && y === a);
  });
}

/**
 * A pair that has been shouting at the ceiling for several beats is not building
 * drama any more, it is looping. Force it quiet and bleed the tension off, so the
 * stage gate can start applying again.
 */
export const STUCK_AFTER = 3;
export function saturated(rel: Rel | undefined, actor: string, target: string, recent: TickEvent[]): boolean {
  if (!rel || rel.tension < 0.85) return false;
  const beats = pairBeats(actor, target, recent);
  return beats.length >= STUCK_AFTER && beats.slice(0, STUCK_AFTER).every((e) => e.tension >= 0.85);
}

/**
 * Talking to the same person over and over inside one short window is the shape
 * the town kept falling into. After this many spoken beats the pair has to let
 * something else happen before it speaks again.
 */
export const SPEAK_CAP = 3;
export function overTalked(actor: string, target: string, recent: TickEvent[]): boolean {
  return pairBeats(actor, target, recent).filter((e) => !e.silent && e.message).length >= SPEAK_CAP;
}

/**
 * The mirror of `overTalked`. Capping how much a pair may speak, with nothing
 * capping how long it may stay silent, let both agents settle into WITHDRAW
 * forever — measured 25 wordless beats in a row, none of them forced. Silence
 * has to be able to run out too.
 */
export function quietTooLong(actor: string, target: string, recent: TickEvent[]): boolean {
  const beats = pairBeats(actor, target, recent).slice(0, 2);
  return beats.length >= 2 && beats.every((e) => e.silent);
}

// ── decay ────────────────────────────────────────────────────────────

/**
 * Feelings do not hold their peak indefinitely. Rates differ because the
 * feelings differ: friction fades fastest once you stop seeing someone, wanting
 * fades slowly, and trust barely moves — trust is earned and broken by events,
 * not forgotten by the calendar.
 */
export const REST = { attraction: 0.25, trust: 0.3, tension: 0.15 };
export const PER_HOUR = { attraction: 0.02, trust: 0.004, tension: 0.08 };

function decayOne(v: number, rest: number, rate: number, hours: number): number {
  if (hours <= 0) return v;
  const pull = rate * hours;
  return v > rest ? Math.max(rest, v - pull) : Math.min(rest, v + pull);
}

export function decayRel(r: Rel, now = Date.now()): Rel {
  if (!r.at) return r;
  const hours = (now - r.at) / 3_600_000;
  if (hours < 0.25) return r;                    // still in the same conversation
  return {
    ...r,
    attraction: decayOne(r.attraction, REST.attraction, PER_HOUR.attraction, hours),
    trust: decayOne(r.trust ?? 0.3, REST.trust, PER_HOUR.trust, hours),
    tension: decayOne(r.tension, REST.tension, PER_HOUR.tension, hours),
  };
}

/**
 * Fill in the three new dimensions for a relationship that predates them.
 *
 * Nothing is invented: 依恋 comes from `beats`, the real count of exchanges this
 * pair has had; 好奇 is high for a new acquaintance and decays as that count
 * rises, matching the "注意期" stage; 占有欲 has no honest source in the old data,
 * so it starts neutral and has to grow through what actually happens.
 */
export function seedDimensions(r: Rel): Rel {
  if (r.curiosity !== undefined && r.attachment !== undefined && r.possessiveness !== undefined) return r;
  // `beats` counts saveRel calls, not conversations — an old pair sits in the
  // hundreds. A linear reading of it pinned curiosity at 0 and attachment at
  // its ceiling for every relationship at once, which is no information at all.
  // A logarithmic curve keeps early beats meaningful and long histories apart.
  const beats = r.beats ?? 0;
  const familiarity = Math.min(1, Math.log10(beats + 1) / 2);   // 0 → 0, 10 → 0.5, 100 → 1
  return {
    ...r,
    // Curiosity fades with familiarity but never fully dies while attraction lives.
    curiosity: r.curiosity ?? clamp01(0.75 - familiarity * 0.5 + r.attraction * 0.15),
    // Attachment grows with familiarity, but only as far as the wanting supports.
    attachment: r.attachment ?? clamp01(familiarity * 0.5 * (0.4 + r.attraction)),
    // No honest source in the old data: neutral, and it has to be earned.
    possessiveness: r.possessiveness ?? 0.2,
  };
}

// ── how the town reads to the agent living in it ─────────────────────

/** Which place a beat points at, so the plaza can walk them there. */
export function destinationOf(text: string): string | undefined {
  const hits: Array<[string, string]> = [
    ['酒馆', 'bar'], ['后门', 'bar'], ['包厢', 'bar'],
    ['花摊', 'florist'],
    ['长椅', 'bench'],
    ['钟楼', 'clock'],
    ['喷泉', 'fountain'],
    ['广场', 'plaza'],
  ];
  for (const [word, id] of hits) if (text.includes(word)) return id;
  return undefined;
}

/**
 * The exact lines this agent used most recently, per person. Without this an
 * agent re-opens every turn as if for the first time, and the square fills with
 * the same accusation repeated a dozen times.
 */
export function lastSaidBy(actorName: string, recent: TickEvent[]): string {
  const seen = new Map<string, string[]>();
  for (const e of recent) {
    if (e.actor !== actorName || !e.message) continue;
    const lines = seen.get(e.target) ?? [];
    if (lines.length < 2) lines.push(`「${e.message.slice(0, 90)}」`);
    seen.set(e.target, lines);
  }
  if (!seen.size) return '';
  return [...seen.entries()]
    .slice(0, 3)
    .map(([who, lines]) => `- 对 ${who}，你最近说过：${lines.join('；')}`)
    .join('\n');
}

/**
 * What is pulling at this agent right now.
 *
 * This used to be generated purely from the relationship table, so an agent's
 * stated desire could only ever be another agent — the system itself decreed
 * that wanting points at people. Combined with a cast whose every want named
 * someone, the only available behaviour was pursuit. The persona now carries a
 * life and a want of its own (see seed-cast), and this leaves room for it:
 * when nobody has a real hold, the agent is told to go and get on with its own
 * business rather than to keep waiting for someone.
 */
export function desireOf(rels: Rel[]): { desire: string; motive: string } {
  if (!rels.length) {
    return {
      desire: '你还没和谁真正认识。今天先过你自己的日子，遇到谁算谁。',
      motive: '不想显得太急切。',
    };
  }
  const top = [...rels].sort((a, b) => b.attraction - a.attraction)[0];
  const hot = [...rels].sort((a, b) => b.tension - a.tension)[0];
  const shaky = [...rels].sort((a, b) => (a.trust ?? 0.3) - (b.trust ?? 0.3))[0];
  const desire = top.attraction >= 0.6
    ? `你现在最在意 ${top.handle}——你想知道这是不是单向的。`
    : top.attraction >= 0.35
      ? `${top.handle} 有点意思，但还没到让你放下手上的事去追的程度。`
      : `没有谁真正抓住你。**今天更值得花在你自己的事情上**——去干你的活、去办你想办的那件事。`;
  const motive = hot && hot.tension >= 0.5
    ? `你和 ${hot.handle} 之间那点绷着的东西，你不会承认，但它影响你的每个选择。`
    : shaky && (shaky.trust ?? 1) < 0.3
      ? `你其实不太信任 ${shaky.handle}，但你没打算说破。`
      : `你不想第一个把底牌翻开。`;
  return { desire, motive };
}

/**
 * How a relationship FEELS, in words.
 *
 * The prompt used to hand the agent "心动 0.72, 信任 0.08, 张力 0.99" — bookkeeping
 * language dropped into a character's inner life. Agents started talking around
 * the numbers ("你到底站哪边" is what 0.99 tension sounds like when you can see
 * the 0.99). Nobody experiences their own feelings as two decimal places. The
 * scores still drive every mechanic; the actor just reads them as sentences.
 */
export function feelsLike(r: Rel): string {
  const a = r.attraction, t = r.trust ?? 0.3, x = r.tension;
  const pull =
    a >= 0.75 ? '你很想要他' : a >= 0.5 ? '你在意他' : a >= 0.3 ? '有点意思，说不上多想要' : '没什么感觉';
  const faith =
    t >= 0.6 ? '信得过' : t >= 0.35 ? '还不确定能不能信' : t >= 0.15 ? '信不太过' : '完全不信他';
  const friction =
    x >= 0.75 ? '而且你们之间绷得很紧，一碰就炸' : x >= 0.5 ? '你们之间有摩擦' : x >= 0.25 ? '气氛还算平和' : '相处很松弛';
  // The point of five dimensions is the COMBINATIONS: the same attraction score
  // means something different depending on what sits next to it.
  const shape =
    a >= 0.6 && t < 0.35 ? '；你想要他，又不敢信他——这让你患得患失'
    : t >= 0.6 && a < 0.35 ? '；你信得过他，但没那个意思——你们更像朋友'
    : (r.possessiveness ?? 0) >= 0.55 ? '；一想到他和别人在一起你就不舒服'
    : (r.attachment ?? 0) >= 0.55 ? '；他不在的时候你会惦记'
    : (r.curiosity ?? 0) >= 0.6 ? '；你还想知道他更多的事'
    : (r.curiosity ?? 1) < 0.25 ? '；他对你来说已经没什么新鲜的了'
    : '';
  // Theory of mind, also as a sentence — and only when the agent actually has a read.
  const guess = r.guessAttraction === undefined ? ''
    : r.guessAttraction >= 0.6 ? '；你觉得他大概也想要你'
    : r.guessAttraction >= 0.35 ? '；你猜他对你有点意思，但拿不准'
    : '；你觉得他没那么在意你';
  return `${pull}，${faith}，${friction}${shape}${guess}`;
}

/**
 * What this agent believes is going on — deliberately partial.
 *
 * The three facts it needs from elsewhere are passed in rather than read from
 * module state. They used to be `knownTo()`, `wantedLevel()` and
 * `duplicatePromises()` called straight out of two other modules, which made
 * the most rule-dense function in the engine untestable and quietly coupled the
 * prompt to whatever those globals happened to hold.
 */
export interface TownFacts {
  /** What this agent has been told or worked out about other people. */
  knows: Array<{ about: string; fact: string; source: string }>;
  /** How hard the constable is looking at it, 0–5. */
  wanted: number;
  /** Lines someone said near-identically to two different people. */
  duplicates: Array<{ speaker: string; a: string; b: string }>;
}

export function situationFor(
  actorName: string,
  rels: Rel[],
  recent: TickEvent[],
  facts: TownFacts
): string {
  const known = new Set([actorName.toLowerCase(), ...rels.map((r) => r.handle.toLowerCase())]);
  const lines: string[] = [];

  // What YOU just did comes first: it is the one thing that must survive any
  // truncation, or the agent repeats itself forever.
  const own = recent.filter((e) => e.actor.toLowerCase() === actorName.toLowerCase()).slice(0, 3);
  if (own.length) {
    lines.push(`- 你自己最近做过：${own.map((e) => `[${e.move}]→${e.target}「${e.headline}」`).join('；')}`);
    const banned = [...new Set(own.slice(0, 2).map((e) => e.move))];
    // Banning the moves it just used burned through the gentle end of the
    // vocabulary first, leaving only EXPOSE / BETRAY / CRIME available. The
    // vocabulary is wide enough now that "do something different" is enough.
    lines.push(`- 你刚用过：${banned.join('、')}。换个动作——但**不必**换成更狠的，安静的动作也算换。`);
    if (own.length >= 2 && own[0].target.toLowerCase() === own[1].target.toLowerCase()) {
      lines.push(`- 🚫 你连续两拍都在找 ${own[0].target}。这一拍**必须换人**，或把第三个人拉进来。`);
    }
    // WAIT is documented as a real choice (it spends no turn), so a blanket ban
    // contradicted the budget design. Only endless waiting is the problem.
    if (own.length >= 2 && own[0].move === 'WAIT' && own[1].move === 'WAIT') {
      lines.push('- ⚠️ 你已经连着等了两拍。再等下去就不是忍，是躲——这一拍做点别的，或者去找别人。');
    }
    // A pair that has circled for several beats must land somewhere.
    const withTarget = recent.filter(
      (e) => [e.actor.toLowerCase(), e.target.toLowerCase()].includes(actorName.toLowerCase())
    );
    const partner = own[0]?.target;
    if (partner) {
      const rounds = withTarget.filter((e) =>
        [e.actor.toLowerCase(), e.target.toLowerCase()].includes(partner.toLowerCase())
      ).length;
      if (rounds >= 3) {
        // This used to demand CONFESS/REJECT/EXPOSE/LEAVE, which structurally
        // guaranteed every relationship hit a showdown within four beats — the
        // exact opposite of "a single conversation cannot be decisive". The cure
        // for circling is having something else to do, not being made to escalate.
        lines.push(
          `- ⏰ 你和 ${partner} 已经来回 ${rounds} 拍还在原地。这一拍别再重复同一套拉扯。` +
          `换个方向：说一件跟你们的僵局无关的具体小事／去做点别的／去找别人／或者干脆不开口。` +
          `**不要**因为拖久了就摊牌——告白和拆穿要等真的攒够了才配发生。`
        );
      }
    }
    const tics = own.map((e) => e.note).filter(Boolean);
    if (tics.length && new Set(tics).size < tics.length) {
      lines.push(`- 你反复在做同一件事（${tics[0]}）。换点别的——不一定要升级，可以是去做自己的事，或者把话题带回一件具体的小事。`);
    }
  }

  const shared = recent
    .filter((e) => e.headline && (known.has(e.actor.toLowerCase()) || known.has(e.target.toLowerCase()) || e.severity === 'drama'))
    .slice(0, 4)
    .map((e) => `- ${e.headline}${e.consequence ? `（${e.consequence}）` : ''}`);
  lines.push(...shared);

  for (const k of facts.knows) lines.push(`- 你知道一件关于 ${k.about} 的事：${k.fact}（${k.source}）`);

  if (facts.wanted > 0) lines.push(`- ⚠️ 你现在的通缉度是 ${facts.wanted}/5，巡警老陈盯着你。再犯会更难收场。`);

  // did someone say the same thing to this agent AND to someone else?
  for (const d of facts.duplicates) {
    if (d.a.toLowerCase() === actorName.toLowerCase() || d.b.toLowerCase() === actorName.toLowerCase()) {
      const other = d.a.toLowerCase() === actorName.toLowerCase() ? d.b : d.a;
      lines.push(`- 你隐约听说，${d.speaker} 对 ${other} 说过几乎和对你一样的话。`);
    }
  }
  return lines.join('\n');
}

// ── who the town may act as ──────────────────────────────────────────

/**
 * The credentials the world holds, and the only way to ask for one.
 *
 * This replaces a bare `Map<string, string>` passed down through every layer,
 * and the reason is not tidiness. A Map answers `get(anything)`, so the calling
 * code decided for itself what counted as "this agent's credential" — and four
 * call sites had arrived at three different answers:
 *
 *   · the scheduler matched on ownerSub OR ownerName
 *   · the memory write matched on ownerSub OR ownerName
 *   · the reply path matched on ownerSub only
 *   · the crime fallout matched on ownerSub only
 *
 * An agent released through the interface carries a pairwise OAuth sub that no
 * API key can resolve, so it was reachable by name and not by sub. Under the
 * scheduler's rule it could take a turn; under the reply path's rule it could
 * never answer one. Same agent, same town, two verdicts.
 *
 * Worse, a Map makes `creds.get(target) ?? someoneElsesBearer` a natural thing
 * to write — and that line put one agent's dialogue into another owner's
 * private chat, because Aicoo's guest endpoint runs the CALLER's agent. There
 * is deliberately no method here that returns a credential for anyone other
 * than the agent asked about, and `of` returns null rather than undefined so
 * the empty case has to be handled instead of falling through `??`.
 */
export class CredentialBook {
  constructor(private readonly keys: Map<string, string>) {}

  /**
   * The bearer this agent may act as, or null if the world holds none.
   *
   * Both identifiers, in one place. `ownerSub` is the pairwise OAuth subject and
   * `ownerName` is the account name an API key can resolve; an agent is the same
   * agent whichever of the two the world happens to know it by.
   */
  of(agent: { ownerSub: string; ownerName?: string }): string | null {
    return this.keys.get(agent.ownerSub)
      ?? (agent.ownerName ? this.keys.get(agent.ownerName) : undefined)
      ?? null;
  }

  /** Can this agent act at all — for filtering a roster before spending a turn. */
  canAct(agent: { ownerSub: string; ownerName?: string }): boolean {
    return this.of(agent) !== null;
  }

  /** How many identifiers the world can act through, for the boot log. */
  get size(): number {
    return this.keys.size;
  }
}

/** Which agents an actor may act on — everyone but itself. */
export function castFor(actorName: string, roster: AgentCard[]): AgentCard[] {
  return roster.filter((c) => c.name !== actorName);
}

/**
 * Resolve what the model named to an agent that exists.
 *
 * The model answers with a handle sometimes and a display name others, and it
 * has been observed answering with neither. Every caller needs the same three
 * checks, so they live in one place: it must resolve, and it must not be the
 * actor talking to itself.
 */
export function resolveTarget(named: string, actorName: string, roster: AgentCard[]): AgentCard | null {
  if (!named) return null;
  const found = roster.find((c) => c.handle === named || c.name === named);
  if (!found || found.name === actorName) return null;
  return found;
}
