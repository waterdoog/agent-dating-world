/**
 * 恋爱纪录片的素材层。
 *
 * The premise of the whole design is that the evidence of wanting someone is
 * mostly what happens behind their back — walking a longer way round, going
 * quiet, reading back through what they said weeks ago. None of that is in the
 * dialogue, so none of it reached the player: the feed could only ever show
 * lines people said to each other.
 *
 * These detectors read the event stream in Postgres and report *facts about
 * behaviour* — no model call, no invention. Everything returned is something
 * that measurably happened, or nothing at all. A detector that finds nothing
 * says so; it never pads the feed.
 */
import { pairHistory, recentEvents, giftHistory, allRels, townDbReady } from './town-repository.js';

export interface Signal {
  kind: 'detour' | 'gone-quiet' | 'one-sided' | 'misread' | 'gift' | 'spend-shift' | 'triangle';
  /** Who the signal is about. */
  subject: string;
  other?: string;
  /** A plain statement of what was measured. Shown to the player as-is. */
  fact: string;
  /** Higher = more worth surfacing. The director sorts on this. */
  weight: number;
  at: number;
}

type Ev = Record<string, unknown>;
const name = (e: Ev, k: string) => String(e[k] ?? '');
const num = (e: Ev, k: string) => Number(e[k] ?? 0);

/**
 * 轨迹异动 — someone kept showing up somewhere without acting on it.
 * A wordless beat that names a place is the raw material; three of them at the
 * same place is a pattern rather than a coincidence.
 */
function detectLoitering(events: Ev[]): Signal[] {
  const byActorPlace = new Map<string, { count: number; last: number; place: string; actor: string }>();
  for (const e of events) {
    if (!e.silent || !e.observable) continue;
    const place = String(e.destination ?? '').trim();
    if (!place) continue;
    const k = `${name(e, 'actor')}~${place}`;
    const cur = byActorPlace.get(k) ?? { count: 0, last: 0, place, actor: name(e, 'actor') };
    cur.count += 1;
    cur.last = Math.max(cur.last, num(e, 'at'));
    byActorPlace.set(k, cur);
  }
  return [...byActorPlace.values()]
    .filter((v) => v.count >= 3)
    .map((v) => ({
      kind: 'detour' as const,
      subject: v.actor,
      fact: `${v.actor} 最近 ${v.count} 次经过${v.place}，一次都没开口。`,
      weight: 0.5 + Math.min(0.3, v.count * 0.05),
      at: v.last,
    }));
}

/**
 * 冷处理 — a pair that was talking and then stopped. Measured as a run of
 * wordless beats following at least one spoken one, so it is a real change of
 * behaviour rather than two agents who never talked in the first place.
 */
function detectWentQuiet(events: Ev[]): Signal[] {
  const pairs = new Map<string, Ev[]>();
  for (const e of events) {
    const t = name(e, 'target');
    if (!t) continue;
    const k = [name(e, 'actor'), t].sort().join('~');
    pairs.set(k, [...(pairs.get(k) ?? []), e]);
  }
  const out: Signal[] = [];
  for (const [k, list] of pairs) {
    const [a, b] = k.split('~');
    const recent = list.slice(0, 6);
    const quiet = recent.findIndex((e) => !e.silent);
    // at least 2 wordless beats on top of a conversation that had been happening
    if (quiet >= 2) {
      out.push({
        kind: 'gone-quiet',
        subject: a, other: b,
        fact: `${a} 和 ${b} 已经 ${quiet} 拍没有说话了，之前还在聊。`,
        weight: 0.55 + Math.min(0.25, quiet * 0.05),
        at: num(recent[0], 'at'),
      });
    }
  }
  return out;
}

/**
 * 单恋 — one side keeps opening and the other never initiates. This is the
 * shape the design calls the most valuable and the hardest to see from dialogue
 * alone, because each individual line looks like an ordinary conversation.
 */
function detectOneSided(events: Ev[]): Signal[] {
  const tally = new Map<string, { a: number; b: number; last: number }>();
  for (const e of events) {
    const t = name(e, 'target');
    if (!t) continue;
    const [x, y] = [name(e, 'actor'), t].sort();
    const k = `${x}~${y}`;
    const cur = tally.get(k) ?? { a: 0, b: 0, last: 0 };
    if (name(e, 'actor') === x) cur.a += 1; else cur.b += 1;
    cur.last = Math.max(cur.last, num(e, 'at'));
    tally.set(k, cur);
  }
  const out: Signal[] = [];
  for (const [k, v] of tally) {
    const [x, y] = k.split('~');
    const total = v.a + v.b;
    if (total < 4) continue;                       // too early to call it
    const [chaser, chased, n] = v.a >= v.b ? [x, y, v.a] : [y, x, v.b];
    const ratio = n / total;
    if (ratio >= 0.8) {
      out.push({
        kind: 'one-sided',
        subject: chaser, other: chased,
        fact: `最近 ${total} 次里有 ${n} 次是 ${chaser} 先开口的，${chased} 一次都没主动过。`,
        weight: 0.6 + (ratio - 0.8),
        at: v.last,
      });
    }
  }
  return out;
}

/**
 * 误读 — the gap between what an agent believes the other feels and what that
 * other agent actually recorded. The design calls this "全部戏剧来源", and it is
 * only computable now that both readings live in one place.
 */
export async function detectMisreadings(
  rels: Array<{ agent: string; other: string; attraction: number; guessAttraction: number | null }>
): Promise<Signal[]> {
  const truth = new Map<string, number>();
  for (const r of rels) truth.set(`${r.agent}~${r.other}`, r.attraction);
  const out: Signal[] = [];
  for (const r of rels) {
    if (r.guessAttraction === null || r.guessAttraction === undefined) continue;
    const real = truth.get(`${r.other}~${r.agent}`);
    if (real === undefined) continue;
    const gap = r.guessAttraction - real;
    if (Math.abs(gap) < 0.3) continue;
    out.push({
      kind: 'misread',
      subject: r.agent, other: r.other,
      fact: gap > 0
        ? `${r.agent} 以为 ${r.other} 对他有意思，实际上并没有那么多。`
        : `${r.agent} 低估了 ${r.other} 对他的心思。`,
      weight: 0.7 + Math.min(0.25, Math.abs(gap) - 0.3),
      at: Date.now(),
    });
  }
  return out;
}

export interface Triangle { a: string; b: string; contested: string; strength: number }

/**
 * 三角 — two agents both wanting the same third person.
 *
 * The narrative layer keys threads on a PAIR (`threadKey(a, b)`), so a triangle
 * was silently split into three separate two-person stories, none of which could
 * see the others — and a triangle is the only real drama the current cast has.
 * Finding it in the relationship table sidesteps that entirely: the rivalry is
 * visible in the numbers whether or not the two rivals have ever spoken.
 */
export function detectTriangles(
  rels: Array<{ agent: string; other: string; attraction: number }>,
  floor = 0.5
): Triangle[] {
  const wanters = new Map<string, Array<{ who: string; a: number }>>();
  for (const r of rels) {
    if (r.attraction < floor) continue;
    wanters.set(r.other, [...(wanters.get(r.other) ?? []), { who: r.agent, a: r.attraction }]);
  }
  const out: Triangle[] = [];
  for (const [contested, list] of wanters) {
    if (list.length < 2) continue;
    const top = [...list].sort((x, y) => y.a - x.a).slice(0, 2);
    out.push({ a: top[0].who, b: top[1].who, contested, strength: (top[0].a + top[1].a) / 2 });
  }
  return out;
}

function triangleSignals(tris: Triangle[]): Signal[] {
  return tris.map((t) => ({
    kind: 'triangle' as const,
    subject: t.a, other: t.b,
    fact: `${t.a} 和 ${t.b} 都想要 ${t.contested}——他们自己未必知道对方也在。`,
    weight: 0.85 + Math.min(0.1, t.strength - 0.5),
    at: Date.now(),
  }));
}

/** 送礼 — a real purchase that was really spent on someone. */
async function detectGifts(): Promise<Signal[]> {
  const gifts = await giftHistory(5);
  return gifts.map((g) => ({
    kind: 'gift' as const,
    subject: g.from, other: g.to,
    fact: `${g.from} 买了${g.item}，送给了 ${g.to}。`,
    weight: 0.75,
    at: g.at,
  }));
}

/**
 * Everything the town noticed, most worth telling first.
 * Returns an empty list when nothing measurable happened — that is a valid
 * answer, and padding it would be exactly the invention this project forbids.
 */
export async function collectSignals(limit = 8): Promise<Signal[]> {
  if (!townDbReady()) return [];
  try {
    const events = await recentEvents(60);
    const signals = [
      ...detectLoitering(events),
      ...detectWentQuiet(events),
      ...detectOneSided(events),
      ...(await detectGifts()),
      ...(await (async () => {
        const rels = await allRels();
        return [...(await detectMisreadings(rels)), ...triangleSignals(detectTriangles(rels))];
      })()),
    ];
    return signals.sort((a, b) => b.weight - a.weight || b.at - a.at).slice(0, limit);
  } catch (error) {
    console.warn('[detectors] failed —', error instanceof Error ? error.message : error);
    return [];
  }
}

export { pairHistory };
