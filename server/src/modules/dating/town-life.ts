/**
 * Town life beyond romance — the GTA layer.
 *
 * The square is still only about intimacy, but a town needs a town: vendors who
 * sell things an agent can use on someone else, police who care when it goes
 * too far, and a wanted level that makes a betrayal cost something in public.
 *
 * Crime here is romantic crime. Stealing a love letter, bribing a vendor for
 * someone's whereabouts, staging a scene in the plaza — the police react to the
 * *social* damage, which feeds straight back into the drama.
 */

import { townState, markTownDirty } from './town-state.js';
import * as db from './town-repository.js';

export type NpcKind = 'vendor' | 'police' | 'bartender' | 'gossip';

/** How an offer resolves — see `resolveOffer` for what each one really does. */
export type OfferKind =
  | 'who-gifted'      // read real gift/approach history
  | 'who-was-at-bar'  // read who really met at the bar
  | 'book-booth'      // real mechanic: the next beat there stays out of the feed
  | 'buy-item'        // a real item held until it is spent on someone
  | 'hear-rumour'     // read a real fact out of the town knowledge store
  | 'plant-rumour'    // write a fact other agents will really read
  | 'report'          // true report raises theirs; false report raises yours
  | 'pay-fine';

export interface Npc {
  id: string;
  name: string;
  kind: NpcKind;
  /** where they stand in the sim's 0–100 field */
  x: number;
  y: number;
  blurb: string;
  /**
   * What a player (or agent) can do here.
   *
   * `effect` used to be the WHOLE implementation: a sentence describing what
   * would happen, returned to the browser and displayed as if it had. Buying a
   * bouquet changed nothing; asking the bartender who was with whom returned the
   * words "she'll tell you who was with whom". Only `pay-fine` did anything.
   *
   * `effect` is now just the label shown before you buy. `resolve` is what
   * actually happens, and it must either report a REAL fact drawn from world
   * state or make a REAL change another agent will run into. When there is
   * nothing to report it says so — it never invents a name.
   */
  offers: Array<{ id: string; label: string; cost: number; effect: string; kind: OfferKind }>;
}

/** Fixed cast of the town — placed around the plaza ring. */
export const NPCS: Npc[] = [
  {
    id: 'florist',
    name: '花摊 · 老周',
    kind: 'vendor',
    x: 34, y: 18,
    blurb: '卖花，也卖消息。谁最近给谁送过花，他记得一清二楚。',
    offers: [
      { id: 'bouquet', label: '买一束花', cost: 20, effect: '拿在手里，下次见到人可以送出去', kind: 'buy-item' },
      { id: 'who-bought', label: '打听谁买过花', cost: 35, effect: '最近一次送花是谁给谁', kind: 'who-gifted' },
    ],
  },
  {
    id: 'bar',
    name: '酒馆 · 阿岚',
    kind: 'bartender',
    x: 76, y: 44,
    blurb: '深夜还开着。她见过每一场分手，也见过每一次偷偷的碰面。',
    offers: [
      { id: 'private-booth', label: '订一个包厢', cost: 40, effect: '你在酒馆的下一拍不会进世界动态', kind: 'book-booth' },
      { id: 'loose-lips', label: '请她喝一杯', cost: 30, effect: '昨晚谁和谁在酒馆', kind: 'who-was-at-bar' },
    ],
  },
  {
    id: 'cop',
    name: '巡警 · 老陈',
    kind: 'police',
    x: 30, y: 40,
    blurb: '管治安，也管闹得太难看的场面。通缉度高了，他会来找你。',
    offers: [
      { id: 'report', label: '举报某人', cost: 0, effect: '属实则对方通缉 +1；不属实你自己 +1', kind: 'report' },
      { id: 'pay-fine', label: '交罚款', cost: 60, effect: '自己的通缉度清零', kind: 'pay-fine' },
    ],
  },
  {
    id: 'gossip',
    name: '长椅 · 阿姨团',
    kind: 'gossip',
    x: 26, y: 72,
    blurb: '整天坐在长椅上。她们不参与任何关系，但她们知道所有关系。',
    offers: [
      { id: 'listen', label: '坐下来听一会儿', cost: 10, effect: '听一条镇上真在传的事', kind: 'hear-rumour' },
      { id: 'plant', label: '放一条消息出去', cost: 45, effect: '别的 agent 下一拍真的会读到（真假不论）', kind: 'plant-rumour' },
    ],
  },
];

/** Romantic crimes — the things police actually care about. */
export const CRIMES: Record<string, { label: string; heat: number; blurb: string }> = {
  'steal-letter': { label: '偷走一封情书', heat: 2, blurb: '把别人写给别人的话拿走' },
  'stage-scene': { label: '在广场上演一出戏', heat: 2, blurb: '故意让某人撞见你和别人' },
  'bribe-vendor': { label: '收买摊主', heat: 1, blurb: '花钱买某人的行踪' },
  'spread-lie': { label: '散播假消息', heat: 3, blurb: '让小镇相信一件没发生的事' },
  'break-in': { label: '闯进别人的私下见面', heat: 3, blurb: '把一场约会砸掉' },
};

const DECAY_MS = 10 * 60_000;   // heat cools over time if nothing new happens

export function wantedLevel(agent: string): number {
  const w = townState().wanted[agent.toLowerCase()];
  if (!w) return 0;
  const decayed = Math.max(0, w.level - Math.floor((Date.now() - w.at) / DECAY_MS));
  return Math.min(5, decayed);
}

export function commitCrime(agent: string, crimeId: string, detail = ''): { level: number; label: string } | null {
  const crime = CRIMES[crimeId];
  if (!crime) return null;
  const key = agent.toLowerCase();
  const cur = townState().wanted[key];
  const base = cur ? wantedLevel(agent) : 0;
  townState().wanted[key] = {
    level: Math.min(5, base + crime.heat),
    reasons: [`${crime.label}${detail ? `：${detail}` : ''}`, ...(cur?.reasons ?? [])].slice(0, 6),
    at: Date.now(),
  };
  markTownDirty();
  const w = townState().wanted[key];
  if (db.townDbReady()) void db.setWanted(agent, w.level, w.reasons).catch((e) => console.warn('[town] setWanted:', e?.message));
  return { level: wantedLevel(agent), label: crime.label };
}

export function clearWanted(agent: string): void {
  delete townState().wanted[agent.toLowerCase()];
  markTownDirty();
  if (db.townDbReady()) void db.clearWantedRow(agent).catch((e) => console.warn('[town] clearWanted:', e?.message));
}

/**
 * What a crime costs socially. A crime is only interesting if it lands on
 * someone's feelings, so each one carries a relationship delta against the
 * victim, plus the rumour the town will hear about it.
 */
export interface CrimeFallout {
  victim: string;
  trustDelta: number;
  tensionDelta: number;
  attractionDelta: number;
  rumour: string;
}
const CRIME_FALLOUT: Record<string, (actor: string, victim: string) => CrimeFallout> = {
  'steal-letter': (a, v) => ({ victim: v, trustDelta: -0.35, tensionDelta: +0.25, attractionDelta: 0,
    rumour: `${a} 拿走了写给 ${v} 的那封信` }),
  'stage-scene': (a, v) => ({ victim: v, trustDelta: -0.25, tensionDelta: +0.35, attractionDelta: -0.05,
    rumour: `${a} 故意让 ${v} 撞见了不该看见的一幕` }),
  'bribe-vendor': (a, v) => ({ victim: v, trustDelta: -0.2, tensionDelta: +0.15, attractionDelta: 0,
    rumour: `${a} 花钱买了 ${v} 的行踪` }),
  'spread-lie': (a, v) => ({ victim: v, trustDelta: -0.45, tensionDelta: +0.3, attractionDelta: -0.1,
    rumour: `${a} 让整个小镇相信了一件关于 ${v} 的假事` }),
  'break-in': (a, v) => ({ victim: v, trustDelta: -0.3, tensionDelta: +0.4, attractionDelta: 0,
    rumour: `${a} 闯进了 ${v} 的私下见面` }),
};

/**
 * NPCs keep hours. The town clock runs 1 real day = 1 world year, but a
 * townsperson's day is simpler: they move between a few posts so the square
 * looks lived-in, and so "who was at the bar last night" means something.
 */
const SCHEDULE: Record<string, Array<{ x: number; y: number; doing: string }>> = {
  florist: [
    { x: 34, y: 18, doing: '摆摊' },
    { x: 44, y: 20, doing: '推着花车走过步行街' },
    { x: 34, y: 18, doing: '收摊前最后一轮' },
    { x: 70, y: 42, doing: '给酒馆送花' },
  ],
  bar: [
    { x: 76, y: 44, doing: '擦杯子' },
    { x: 74, y: 40, doing: '在门口台阶上迎客' },
    { x: 84, y: 58, doing: '去后巷倒垃圾' },
    { x: 76, y: 44, doing: '守着深夜的最后一桌' },
  ],
  cop: [
    { x: 30, y: 40, doing: '在钟楼下站岗' },
    { x: 46, y: 30, doing: '巡逻主路' },
    { x: 47, y: 22, doing: '往暗巷里看了一眼' },
    { x: 52, y: 46, doing: '穿过广场' },
  ],
  gossip: [
    { x: 26, y: 72, doing: '坐在长椅上看' },
    { x: 26, y: 72, doing: '交换今天的消息' },
    { x: 36, y: 60, doing: '挪到看得见广场的位置' },
    { x: 26, y: 72, doing: '收工前再看一眼' },
  ],
};

/** Where an NPC is right now, and what it's doing — a real-time function. */
export function npcNow(id: string): { x: number; y: number; doing: string } | null {
  const posts = SCHEDULE[id];
  if (!posts) return null;
  // one town "shift" every 4 real minutes, so the square visibly changes
  const shift = Math.floor(Date.now() / (4 * 60_000)) % posts.length;
  return posts[shift];
}

export function falloutOf(crimeId: string, actor: string, victim: string): CrimeFallout | null {
  const f = CRIME_FALLOUT[crimeId];
  return f ? f(actor, victim) : null;
}

export function wantedBoard(): Array<{ agent: string; level: number; reasons: string[] }> {
  return Object.keys(townState().wanted)
    .map((k) => ({ agent: k, level: wantedLevel(k), reasons: townState().wanted[k]?.reasons ?? [] }))
    .filter((w) => w.level > 0)
    .sort((a, b) => b.level - a.level);
}

/**
 * Money is the platform's N1 Credits — the same wallet Agent Fights stakes
 * from — so what you spend on a bouquet is the balance you actually hold.
 * When the wallet database isn't configured (local dev), the town keeps a
 * pocket ledger instead so vendors still work.
 */
const START_CASH = 200;

function localBalance(agent: string): number {
  const k = agent.toLowerCase();
  const p = townState().purse;
  if (p[k] === undefined) { p[k] = START_CASH; markTownDirty(); }
  return p[k];
}

/**
 * The town shows the platform's N1 Credit balance when the wallet database is
 * reachable, so the number in the HUD is the one the player actually holds.
 * Town spending itself stays on the town ledger — Agent Fights owns the credit
 * ledger and the town must not silently drain a player's stake.
 */
export async function walletBalance(fighterId: string | undefined, agent: string): Promise<number> {
  if (fighterId) {
    try {
      const { readFighterCreditBalance } = await import('../../database/repository.js');
      return await readFighterCreditBalance(fighterId);
    } catch {
      /* no wallet configured — use the town's own ledger */
    }
  }
  return localBalance(agent);
}

/** Synchronous view used where an await isn't available. */
export function balance(agent: string): number {
  return localBalance(agent);
}
export function spend(agent: string, amount: number): boolean {
  const k = agent.toLowerCase();
  const have = localBalance(agent);
  if (have < amount) return false;
  townState().purse[k] = have - amount;
  markTownDirty();
  if (db.townDbReady()) void db.debit(agent, amount).catch((e) => console.warn('[town] debit:', e?.message));
  return true;
}

/** Money moves rather than evaporating — the other half of a real transaction. */
export function credit(agent: string, amount: number): void {
  const k = agent.toLowerCase();
  townState().purse[k] = localBalance(agent) + amount;
  markTownDirty();
  if (db.townDbReady()) void db.credit(agent, amount).catch((e) => console.warn('[town] credit:', e?.message));
}

/**
 * Where each agent currently stands, reported by the plaza simulation. Agents
 * use this to know who is within earshot — the difference between "I heard"
 * and "I can see you from here".
 */
const positions = new Map<string, { x: number; y: number; at: number }>();
export function reportPositions(list: Array<{ name: string; x: number; y: number }>): void {
  const at = Date.now();
  for (const p of list) positions.set(p.name.toLowerCase(), { x: p.x, y: p.y, at });
}
export function livePositions(): Map<string, { x: number; y: number }> {
  const fresh = new Map<string, { x: number; y: number }>();
  const cutoff = Date.now() - 120_000;   // ignore stale reports
  for (const [k, v] of positions) if (v.at > cutoff) fresh.set(k, { x: v.x, y: v.y });
  return fresh;
}

/**
 * What each NPC has actually noticed.
 *
 * The florist's blurb promises "谁最近给谁送过花，他记得一清二楚" — a promise the
 * town could never keep, because nothing recorded purchases and `npcNow` fed the
 * prompt one line of scenery. Now that `town_items` holds a real ledger, the
 * NPCs can remember out loud.
 *
 * Rule-driven on purpose: no model call, no budget. An NPC is a social echo, not
 * a character — it repeats what the world already recorded, or says nothing.
 */
export async function npcRecalls(id: string): Promise<string> {
  if (!db.townDbReady()) return '';
  try {
    if (id === 'florist') {
      const gifts = await db.giftHistory(2);
      if (!gifts.length) return '';
      return gifts.map((g) => `${g.from} 买了${g.item}送给 ${g.to}`).join('；');
    }
    if (id === 'cop') {
      const wanted = (await db.wantedRows()).slice(0, 2);
      if (!wanted.length) return '';
      return wanted.map((w) => `${w.agent} 通缉度 ${w.wantedLevel}（${w.wantedReasons[0] ?? ''}）`).join('；');
    }
    return '';
  } catch {
    return '';   // an NPC that cannot remember simply says nothing
  }
}

// ── offers that actually do something ────────────────────────────────

/**
 * Items an agent is holding. A bouquet bought today is spent on someone later —
 * price is not the signal, aim is, so what matters is who it eventually goes to.
 */
const carried = new Map<string, string[]>();
export function carrying(agent: string): string[] { return carried.get(agent.toLowerCase()) ?? []; }
/**
 * Hand an item to someone. Awaited, because the ledger row IS the gift.
 *
 * This used to check the in-memory list, return true, and fire the database
 * write off into the background — so a purchase that had not finished committing
 * yet produced a "successful" gift with no ledger entry, and the florist could
 * never recall it. The write is now the thing that decides.
 */
export async function give(agent: string, item: string, to: string): Promise<boolean> {
  const k = agent.toLowerCase();
  if (db.townDbReady()) {
    const done = await db.spendItem(agent, item, to).catch((e) => {
      console.warn('[town] spendItem:', e?.message);
      return false;
    });
    if (!done) return false;
  } else {
    const held = carried.get(k) ?? [];
    const i = held.indexOf(item);
    if (i < 0) return false;
  }
  const held = carried.get(k) ?? [];
  const i = held.indexOf(item);
  if (i >= 0) { held.splice(i, 1); carried.set(k, held); }
  return true;
}

/** Rehydrate an agent's purse and carried items from Postgres. */
export async function hydrateAgent(agent: string): Promise<void> {
  if (!db.townDbReady()) return;
  try {
    const row = await db.loadAgent(agent, START_CASH);
    townState().purse[agent.toLowerCase()] = row.purse;
    carried.set(agent.toLowerCase(), await db.heldItems(agent));
  } catch (error) {
    console.warn('[town] hydrate failed:', error instanceof Error ? error.message : error);
  }
}

/** Beats booked out of public view — the bar booth, keyed by agent. */
const booths = new Map<string, number>();
const BOOTH_MS = 30 * 60_000;
export function inPrivateBooth(agent: string): boolean {
  const until = booths.get(agent.toLowerCase()) ?? 0;
  return until > Date.now();
}

export interface OfferResult {
  ok: boolean;
  /** A real fact read out of world state, or an explicit "nothing to report". */
  fact?: string;
  /** A real change that was applied. */
  applied?: string;
}

/**
 * Resolve an offer against the world. Every branch either reports something that
 * genuinely happened or states plainly that there is nothing — it never invents a
 * name, a pairing or a rumour to fill the silence.
 */
export async function resolveOffer(
  kind: OfferKind,
  buyer: string,
  ctx: { events: Array<{ actor: string; target: string; move?: string; act?: string; destination?: string; headline?: string; at?: number }>; knownToBuyer: Array<{ about: string; fact: string; source: string }>; subject?: string }
): Promise<OfferResult> {
  switch (kind) {
    case 'buy-item': {
      const k = buyer.toLowerCase();
      carried.set(k, [...(carried.get(k) ?? []), '花']);
      if (db.townDbReady()) await db.addItem(buyer, '花').catch((e) => console.warn('[town] addItem:', e?.message));
      return { ok: true, applied: `你拿着一束花。下次见到人时可以送出去。` };
    }
    case 'book-booth': {
      booths.set(buyer.toLowerCase(), Date.now() + BOOTH_MS);
      return { ok: true, applied: `包厢订下了。接下来半小时你在酒馆说的话不会进世界动态。` };
    }
    case 'who-gifted': {
      const hit = ctx.events.find((e) => e.act === 'GIFT');
      return hit
        ? { ok: true, fact: `${hit.actor} 送了东西给 ${hit.target}。` }
        : { ok: true, fact: '最近没人送过花。老周摇摇头。' };
    }
    case 'who-was-at-bar': {
      const hit = ctx.events.find((e) => e.destination === 'bar');
      return hit
        ? { ok: true, fact: `${hit.actor} 和 ${hit.target} 在酒馆碰过面。${hit.headline ? `（${hit.headline}）` : ''}` }
        : { ok: true, fact: '昨晚酒馆没什么人。她擦着杯子没抬头。' };
    }
    case 'hear-rumour': {
      const k = ctx.knownToBuyer[0];
      return k
        ? { ok: true, fact: `关于 ${k.about}：${k.fact}（${k.source}）` }
        : { ok: true, fact: '今天没什么可说的。阿姨们在聊天气。' };
    }
    case 'plant-rumour':
      return { ok: true, applied: '消息放出去了。别的 agent 下一拍会读到它——不管它是不是真的。' };
    case 'report': {
      if (!ctx.subject) return { ok: false };
      const real = wantedLevel(ctx.subject) > 0;
      if (real) {
        const done = commitCrime(ctx.subject, 'spread-lie', `${buyer} 举报的`);
        return { ok: true, applied: `老陈记下了。${ctx.subject} 的通缉度现在是 ${done?.level ?? wantedLevel(ctx.subject)}。` };
      }
      const back = commitCrime(buyer, 'spread-lie', `诬告 ${ctx.subject}`);
      return { ok: true, applied: `老陈查过了，${ctx.subject} 名下没有案底。诬告要算你的——你的通缉度是 ${back?.level ?? wantedLevel(buyer)}。` };
    }
    case 'pay-fine':
      clearWanted(buyer);
      return { ok: true, applied: '罚款交了，你的通缉度清零。' };
  }
}
