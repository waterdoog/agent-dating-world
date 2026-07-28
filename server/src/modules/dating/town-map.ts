/**
 * The town map — one source of truth.
 *
 * Locations used to be declared three times over: an AREAS list in the engine,
 * NPC coordinates in town-life, and hardcoded placements in the 3D scene. They
 * drifted, and an agent's idea of "the bar" didn't match where the bar was
 * drawn. Everything now derives from this file.
 *
 * The layout is a town, not a ring of boxes around a courtyard: three streets
 * meet off-centre, the plaza opens south into a park instead of being walled
 * in, and blocks vary in depth and orientation.
 *
 * Coordinates are in the sim's 0–100 field (the same space agents walk in).
 * What matters for the *agents*, though, isn't the numbers — a model can't
 * reason usefully about {x:74,y:28}. What it needs is what a place is FOR, who
 * watches it, and whether saying something there is public or private. That's
 * what makes "今晚九点酒馆后巷，别在广场上说" a real strategic choice.
 */

export type Privacy = 'public' | 'semi' | 'private';

export interface Place {
  id: string;
  name: string;
  /** where it sits in the sim's 0–100 field */
  x: number;
  y: number;
  /** how far from (x,y) still counts as being "here" */
  radius: number;
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
    x: 52, y: 46, radius: 16,
    side: '正中',
    blurb: '喷泉和公告板都在这儿，三条路在东北角交汇。人人路过，人人看得见——公开表白、当众翻脸都发生在这里。',
    privacy: 'public',
    near: ['clock', 'tavern', 'market', 'park'],
  },
  {
    id: 'clock',
    name: '钟楼',
    x: 30, y: 40, radius: 7,
    side: '广场西缘',
    blurb: '主路尽头那座高塔，全镇最远都能看见。约在钟楼下就等于约在所有人的视线里；塔身背面倒是有个没人走的角。',
    privacy: 'semi',
    keeper: 'cop',
    near: ['plaza', 'market', 'park'],
  },
  {
    id: 'market',
    name: '商业街',
    x: 34, y: 18, radius: 13,
    side: '西北',
    blurb: '花摊、咖啡座、杂货铺沿街排开，遮阳棚下有桌椅。买花送人、边走边打听，都在这条街上。',
    privacy: 'semi',
    keeper: 'florist',
    near: ['alley', 'plaza', 'clock'],
  },
  {
    id: 'alley',
    name: '暗巷',
    x: 47, y: 22, radius: 5,
    side: '商业街中段',
    blurb: '两排店铺之间的窄缝，堆着货箱。站在这里能听见街上说话，街上却看不见你。',
    privacy: 'private',
    near: ['market', 'plaza'],
  },
  {
    id: 'tavern',
    name: '酒馆',
    x: 76, y: 44, radius: 8,
    side: '东侧',
    blurb: '阿岚看店，门口几级台阶总有人站着抽烟。里面有包厢，深夜才打烊——谁和谁待到最后，她都记得。',
    privacy: 'semi',
    keeper: 'bar',
    near: ['backalley', 'plaza'],
  },
  {
    id: 'backalley',
    name: '酒馆后巷',
    x: 84, y: 58, radius: 6,
    side: '酒馆背面',
    blurb: '围墙、垃圾桶、一扇后门。要说不能被人听见的话，要交不能被人看见的东西，都来这儿。',
    privacy: 'private',
    near: ['tavern'],
  },
  {
    id: 'park',
    name: '长椅公园',
    x: 26, y: 72, radius: 12,
    side: '西南',
    blurb: '树、长椅、几条碎石小路。离广场最远的角落，说话不必压着嗓子——约会和摊牌都在这里发生。',
    privacy: 'private',
    keeper: 'gossip',
    near: ['plaza', 'clock'],
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
  return PLACES.map((p) => `- ${p.name}（${p.side}，${PRIVACY_CN[p.privacy]}）：${p.blurb}`).join('\n');
}

/** How to get from one place to another, in words an agent can use. */
export function routeHint(fromId: string, toId: string): string {
  const a = placeById(fromId), b = placeById(toId);
  if (!a || !b || a.id === b.id) return '';
  if (a.near.includes(b.id)) return `${a.name}到${b.name}几步路`;
  return `${a.name}到${b.name}要穿过广场`;
}

/**
 * Where an agent should stand given what it's trying to do. Intent drives
 * footfall, so the town has traffic instead of everyone milling in the middle.
 */
export function placeForIntent(move: string): Place {
  switch (move) {
    case 'INVESTIGATE': return placeById('market')!;
    case 'BETRAY':
    case 'SCHEME': return placeById('alley')!;
    case 'ALLY': return placeById('backalley')!;
    case 'DEEPEN': return placeById('park')!;
    case 'CONFESS':
    case 'REJECT':
    case 'EXPOSE': return placeById('plaza')!;
    case 'WAIT': return placeById('clock')!;
    case 'COOL':
    case 'LEAVE': return placeById('park')!;
    default: return placeById('tavern')!;
  }
}
