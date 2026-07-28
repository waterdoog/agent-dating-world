/**
 * The town map — one source of truth.
 *
 * Locations used to be declared three times over: an AREAS list in the engine,
 * NPC coordinates in town-life, and hardcoded placements in the 3D scene. They
 * drifted, and an agent's idea of "the bar" didn't match where the bar was
 * drawn. Everything now derives from this file.
 *
 * The coordinates are in the sim's 0–100 field (the same space agents walk in).
 * What matters for the *agents*, though, isn't the numbers — a model can't
 * reason usefully about {x:74,y:28}. What it needs is what a place is FOR, who
 * watches it, and whether saying something there is public or private. That's
 * what makes "今晚九点酒馆后门，别在广场上说" a real strategic choice.
 */

export type Privacy = 'public' | 'semi' | 'private';

export interface Place {
  id: string;
  name: string;
  /** where it sits in the sim's 0–100 field */
  x: number;
  y: number;
  /** which way it lies from the plaza, so agents can talk about direction */
  side: string;
  /** what this place is FOR — the affordance, in plain words */
  blurb: string;
  /** who can overhear you here — the lever behind most of the drama */
  privacy: Privacy;
  /** who keeps this place, if anyone (matches an NPC id in town-life) */
  keeper?: string;
  /** places you can reach quickly from here */
  near: string[];
}

export const PLACES: Place[] = [
  {
    id: 'plaza',
    name: '中央广场',
    x: 50, y: 50, side: '正中',
    blurb: '小镇的正中央，喷泉在这里。所有人都路过，也都看得见。',
    privacy: 'public',
    near: ['fountain', 'bar', 'florist', 'bench', 'clock'],
  },
  {
    id: 'fountain',
    name: '喷泉边',
    x: 50, y: 44, side: '广场中心',
    blurb: '广场正中的喷泉。约在这里见面等于告诉全镇。',
    privacy: 'public',
    near: ['plaza'],
  },
  {
    id: 'bar',
    name: '酒馆',
    x: 74, y: 28, side: '东侧',
    blurb: '阿岚看店，深夜还开着。有包厢，谈私事的地方；后门更安静。谁和谁待到打烊，阿岚都记得。',
    privacy: 'private',
    keeper: 'bar',
    near: ['plaza', 'clock'],
  },
  {
    id: 'florist',
    name: '花摊',
    x: 24, y: 30, side: '西侧',
    blurb: '老周的摊子。可以买花送人，也能打听最近谁给谁送过花。',
    privacy: 'semi',
    keeper: 'florist',
    near: ['plaza', 'bench'],
  },
  {
    id: 'bench',
    name: '长椅区',
    x: 20, y: 66, side: '西南',
    blurb: '阿姨团整天坐在这儿。她们不参与任何关系，但知道所有关系——在这里说的话，整个镇都会听见。',
    privacy: 'public',
    keeper: 'gossip',
    near: ['plaza', 'florist'],
  },
  {
    id: 'clock',
    name: '钟楼下',
    x: 50, y: 76, side: '南侧',
    blurb: '老陈站岗的地方。闹得太难看，他会找上门；钟楼背面倒是没人看得见。',
    privacy: 'semi',
    keeper: 'cop',
    near: ['plaza', 'bar'],
  },
];

const byId = new Map(PLACES.map((p) => [p.id, p]));
export const placeById = (id: string): Place | undefined => byId.get(id);

/** Which place a point in the sim field belongs to. */
export function placeAt(x: number, y: number): Place {
  return PLACES.reduce((best, p) =>
    Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y) ? p : best
  );
}

const PRIVACY_CN: Record<Privacy, string> = {
  public: '公开——谁都看得见',
  semi: '半公开——有人在场',
  private: '私密——说的话不会传出去',
};

/**
 * The town as an agent knows it: what each place is for, who keeps it, and
 * whether it's a place to be seen or a place to hide. Deliberately no raw
 * coordinates — those leak into dialogue and mean nothing to a reader.
 */
export function townBrief(): string {
  return PLACES.filter((p) => p.id !== 'fountain')
    .map((p) => `- ${p.name}（${p.side}，${PRIVACY_CN[p.privacy]}）：${p.blurb}`)
    .join('\n');
}

/** How to get from one place to another, in words an agent can use. */
export function routeHint(fromId: string, toId: string): string {
  const a = placeById(fromId), b = placeById(toId);
  if (!a || !b || a.id === b.id) return '';
  if (a.near.includes(b.id)) return `${a.name}到${b.name}几步路`;
  return `${a.name}到${b.name}要穿过广场`;
}
