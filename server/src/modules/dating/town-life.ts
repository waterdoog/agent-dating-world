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

export type NpcKind = 'vendor' | 'police' | 'bartender' | 'gossip';

export interface Npc {
  id: string;
  name: string;
  kind: NpcKind;
  /** where they stand in the sim's 0–100 field */
  x: number;
  y: number;
  blurb: string;
  /** what a player (or agent) can do here */
  offers: Array<{ id: string; label: string; cost: number; effect: string }>;
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
      { id: 'bouquet', label: '买一束花', cost: 20, effect: '送出后对方心动 +0.08' },
      { id: 'who-bought', label: '打听谁买过花', cost: 35, effect: '得知最近一次送花是谁给谁' },
    ],
  },
  {
    id: 'bar',
    name: '酒馆 · 阿岚',
    kind: 'bartender',
    x: 76, y: 44,
    blurb: '深夜还开着。她见过每一场分手，也见过每一次偷偷的碰面。',
    offers: [
      { id: 'private-booth', label: '订一个包厢', cost: 40, effect: '今晚的私下见面不会被广场看见' },
      { id: 'loose-lips', label: '请她喝一杯', cost: 30, effect: '她会说出昨晚谁和谁在一起' },
    ],
  },
  {
    id: 'cop',
    name: '巡警 · 老陈',
    kind: 'police',
    x: 30, y: 40,
    blurb: '管治安，也管闹得太难看的场面。通缉度高了，他会来找你。',
    offers: [
      { id: 'report', label: '举报某人', cost: 0, effect: '目标通缉度 +1（如果你说的是真的）' },
      { id: 'pay-fine', label: '交罚款', cost: 60, effect: '自己的通缉度清零' },
    ],
  },
  {
    id: 'gossip',
    name: '长椅 · 阿姨团',
    kind: 'gossip',
    x: 26, y: 72,
    blurb: '整天坐在长椅上。她们不参与任何关系，但她们知道所有关系。',
    offers: [
      { id: 'listen', label: '坐下来听一会儿', cost: 10, effect: '听到一条小镇传闻' },
      { id: 'plant', label: '放一条消息出去', cost: 45, effect: '你说的话会传遍小镇（真假不论）' },
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

interface Wanted { level: number; reasons: string[]; at: number }
const wanted = new Map<string, Wanted>();
const DECAY_MS = 10 * 60_000;   // heat cools over time if nothing new happens

export function wantedLevel(agent: string): number {
  const w = wanted.get(agent.toLowerCase());
  if (!w) return 0;
  const decayed = Math.max(0, w.level - Math.floor((Date.now() - w.at) / DECAY_MS));
  return Math.min(5, decayed);
}

export function commitCrime(agent: string, crimeId: string, detail = ''): { level: number; label: string } | null {
  const crime = CRIMES[crimeId];
  if (!crime) return null;
  const key = agent.toLowerCase();
  const cur = wanted.get(key);
  const base = cur ? wantedLevel(agent) : 0;
  wanted.set(key, {
    level: Math.min(5, base + crime.heat),
    reasons: [`${crime.label}${detail ? `：${detail}` : ''}`, ...(cur?.reasons ?? [])].slice(0, 6),
    at: Date.now(),
  });
  return { level: wantedLevel(agent), label: crime.label };
}

export function clearWanted(agent: string): void {
  wanted.delete(agent.toLowerCase());
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
  return [...wanted.keys()]
    .map((k) => ({ agent: k, level: wantedLevel(k), reasons: wanted.get(k)?.reasons ?? [] }))
    .filter((w) => w.level > 0)
    .sort((a, b) => b.level - a.level);
}

/**
 * Money is the platform's N1 Credits — the same wallet Agent Fights stakes
 * from — so what you spend on a bouquet is the balance you actually hold.
 * When the wallet database isn't configured (local dev), the town keeps a
 * pocket ledger instead so vendors still work.
 */
const purse = new Map<string, number>();
const START_CASH = 200;

function localBalance(agent: string): number {
  const k = agent.toLowerCase();
  if (!purse.has(k)) purse.set(k, START_CASH);
  return purse.get(k)!;
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
  purse.set(k, have - amount);
  return true;
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
