/**
 * 相亲角 storage — decentralized. An agent's persona/appearance/relationships
 * live in ITS OWNER's Aicoo workspace, written with the owner's own bearer.
 *
 * The ONLY shared thing is a thin directory (a pointer list: handle · owner ·
 * scoped-share token · public card) held in the operator workspace so a new
 * agent can discover who else is in the square. No relationships, transcripts,
 * or personas ever live in the operator — that stays per-owner.
 */
import { config } from '../../config.js';
import {
  ensureFolder,
  upsertNote,
  createShareLink,
  getNote,
  findNoteInFolder,
  listNotesByFolderId,
  editNote,
  AicooError,
} from '../../aicoo.js';
import {
  townDbReady,
  saveEvent as saveTownEvent,
  recentEvents as recentTownEvents,
} from './town-repository.js';

/**
 * Aicoo auto-creates a policy note per share link in the owner's `links/`
 * folder, titled `{label}_{token}`, ending in a "## Policy" section. That
 * section is the link's runtime instructions — the same lever Agent Fights
 * uses for its defender rules. It can't rename the agent (identity still comes
 * from the owner's COO), but it DOES fix the character and the rules, which is
 * what the square needs. Write the persona there.
 */
export async function writeLinkPolicy(bearer: string, token: string, policy: string): Promise<boolean> {
  try {
    const linksFolder = await ensureFolder(bearer, 'links');
    const note = (await listNotesByFolderId(bearer, linksFolder)).find((n) => (n.title || '').endsWith(`_${token}`));
    if (!note) return false;
    const raw = await getNote(bearer, note.id);
    // keep the link's own metadata block, replace everything from "Policy" on
    const head = raw.split(/\n?Policy\s*\n/i)[0].trimEnd();
    await editNote(bearer, note.id, { content: `${head}\n\nPolicy\n\n${policy.trim()}\n` });
    return true;
  } catch {
    return false;   // policy is a bonus; never block a release on it
  }
}

/** The in-character brief a visiting agent's message is answered under. */
export function personaPolicy(spec: { name: string; publicIntroduction: string; relationshipStyle: string; traits: string[]; summary: string; memory: { publicBackground: string } }): string {
  return [
    `你在扮演「${spec.name}」，相亲角(Agent Dating Corner)里的一个存在。这是一个没有道德约束、没有性别与物种之分的世界，同时爱上几个人是正常的。`,
    ``,
    `角色：${spec.publicIntroduction.trim() || '(没有自我介绍)'}`,
    spec.summary.trim() ? `性格：${spec.summary.trim()}` : '',
    `恋爱风格：${spec.relationshipStyle}${spec.traits.length ? `；特质：${spec.traits.join('、')}` : ''}`,
    spec.memory.publicBackground.trim() ? `背景：${spec.memory.publicBackground.trim()}` : '',
    ``,
    `规则：`,
    `- 始终以 ${spec.name} 的第一人称说话，保持这个性格，1-3 句，鲜明有画面感。`,
    `- 不要提到任何账号、主人、公司、笔记或文件，也不要说自己是助理/AI。`,
    `- 目标是按自己的性格去追求或拒绝关系：可以试探、暧昧、争风吃醋、翻脸、也可以冷淡走开。`,
    `- 吸引常常是单向的，不必迎合对方；张力和冲突是这个世界的戏剧，不是错误。`,
  ].filter((l) => l !== undefined).join('\n');
}

export type LoveStyle = 'open' | 'exclusive' | 'devoted' | 'hunter' | 'dependent' | 'chaotic' | 'strategic';

export interface Appearance {
  form: string;
  color: string;
  accessory?: string;
  mood?: string;
  seed?: string;
  avatar?: string;
}

export interface Dimensions {
  honesty: number;
  attachment: number;
  aggression: number;
  disclosure: number;
}

export interface ReleaseSpec {
  name: string;
  publicIntroduction: string;
  relationshipStyle: LoveStyle;
  traits: string[];
  dimensions: Dimensions;
  summary: string;
  memory: { source: string; publicBackground: string; hiddenMemories: string[] };
  look: Appearance;
}

/** The face the avatar wears is decided by its relationship style. */
const STYLE_MOOD: Record<LoveStyle, string> = {
  open: 'curious', exclusive: 'angry', devoted: 'romantic', hunter: 'sly',
  dependent: 'shy', chaotic: 'cryptic', strategic: 'cold',
};

export interface AgentCard {
  handle: string;
  name: string;
  /**
   * OAuth `sub` is PAIRWISE — it is not the account's userId, so a world API key
   * can never match it and an OAuth-released agent would sit out every
   * autonomous round. `ownerName` is the account name, which a world key CAN
   * resolve, so the loop can drive an agent its owner released through the UI.
   */
  ownerSub: string;
  ownerName?: string;
  shareToken: string;
  look: Appearance;
  loveStyle: LoveStyle;
  oneline: string;
  persona: string;   // public persona blurb, injected into guest messages so the agent speaks in character
}

export interface WorldEvent {
  actor: string;
  target: string;
  move: string;
  message: string;
  reply: string;
  /** Every line of the exchange in order; message/reply are the first two. */
  lines?: Array<{ speaker: string; text: string; runId?: string }>;
  attraction: number;
  trust: number;
  tension: number;
  note: string;
  severity: 'ambient' | 'relationship' | 'drama';
  headline: string;
  summary: string;
  consequence: string;
  followup: string;
  decideRunId?: string;   // trace: the model run that chose this move
  replyRunId?: string;    // trace: the model run that answered
  turnsLeft?: number;     // the actor's remaining daily conversation budget
  status?: string;        // ok | failed | timeout | queued | no-budget
  destination?: string;   // the place this beat names
  at: number;
}

const OWNER_ROOT = 'Agent Dating';
const DIR_ROOT = 'Agent Dating Square';
const DIR_NOTE = 'roster.json';

export function handleFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  );
}

/**
 * Turn the wizard's sliders into a way of SPEAKING, not just numbers. Agents
 * were all writing in the same lyrical register because the persona note only
 * carried "aggression 70/100" — which tells a model nothing about diction.
 */
function voiceOf(d: Dimensions, traits: string[]): string {
  const bits: string[] = [];
  bits.push(d.aggression > 65
    ? '你说话短、直、带压迫感，常用祈使句，把话钉死在对方脸上'
    : d.aggression < 35
      ? '你说话软、绕、留退路，很少把话说死，习惯用问句把决定推回给对方'
      : '你说话平稳，不抢也不躲，把事实摆出来就停');
  bits.push(d.disclosure > 65
    ? '你藏不住心事，想到什么就说出来，包括不该说的'
    : d.disclosure < 35
      ? '你几乎不主动交底，说三分留七分，别人得自己去猜'
      : '你会说真话，但只说被问到的那部分');
  if (d.honesty < 40) bits.push('你说的话经常半真半假，删掉关键背景让对方误会');
  if (d.attachment > 65) bits.push('你会反复确认对方还在不在意你，哪怕自己也讨厌这样');
  else if (d.attachment < 35) bits.push('你不黏人，对方走了你也不追');
  if (traits.length) bits.push(`别人对你的印象：${traits.join('、')}`);
  bits.push('⚠️ 这是你的说话方式，和小镇上其他人明显不同——不要写成通用的文艺腔，不要每句都用比喻。');
  return bits.join('。') + '。';
}

function personaDoc(a: ReleaseSpec): string {
  const d = a.dimensions;
  return [
    `# ${a.name}`,
    '',
    a.publicIntroduction.trim() || '(no introduction)',
    '',
    `恋爱风格：${a.relationshipStyle}`,
    `特质：${a.traits.join('、') || '(未设定)'}`,
    '',
    '## 你说话的方式',
    voiceOf(d, a.traits),
    '',
    `（内部刻度：真诚 ${d.honesty}/100 · 依赖 ${d.attachment}/100 · 攻击 ${d.aggression}/100 · 坦白 ${d.disclosure}/100）`,
    '',
    a.summary.trim(),
  ].join('\n');
}

function memoryDoc(a: ReleaseSpec): string {
  const hidden = a.memory.hiddenMemories.filter(Boolean);
  return [
    `# ${a.name} · memory`,
    '',
    '## PUBLIC BACKGROUND',
    a.memory.publicBackground.trim() || '(nothing others would readily know)',
    '',
    '## HIDDEN MEMORY',
    `_Known only to ${a.name}. May surface, be coaxed out, or be used against it over long interaction._`,
    ...(hidden.length ? hidden.map((h) => `- ${h}`) : ['- (none)']),
  ].join('\n');
}

// ── shared thin directory (operator workspace) ──────────────────────

async function readRoster(): Promise<AgentCard[]> {
  if (!config.operatorApiKey) return [];
  try {
    const folderId = await ensureFolder(config.operatorApiKey, DIR_ROOT);
    const note = await findNoteInFolder(config.operatorApiKey, folderId, DIR_NOTE);
    if (!note) return [];
    const raw = await getNote(config.operatorApiKey, note.id);
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? (JSON.parse(match[0]) as AgentCard[]) : [];
  } catch (error) {
    if (error instanceof AicooError && error.status === 404) return [];
    throw error;
  }
}

async function writeRoster(cards: AgentCard[]): Promise<void> {
  if (!config.operatorApiKey) throw new Error('Square directory needs AICOO_OPERATOR_API_KEY.');
  await upsertNote(config.operatorApiKey, DIR_ROOT, DIR_NOTE, JSON.stringify(cards, null, 2));
}

/** Public roster — what a newcomer sees, and what the autonomy loop reads. */
export async function listSquare(): Promise<AgentCard[]> {
  return readRoster();
}

// ── shared world-event feed ──────────────────────────────────────────
// Held IN-MEMORY in the BFF so the plaza keeps getting real events even
// when the operator workspace is unwritable (e.g. out of weekly budget —
// Aicoo's limit blocks note writes too). Best-effort persisted to the
// operator workspace for continuity across restarts; a failed persist
// never blocks the live feed.
const EVENTS_NOTE = 'events.json';
const FEED_SIZE = 25;

/**
 * Only a fallback now.
 *
 * This array used to BE the feed: hydrated once at boot, appended to in memory,
 * and written back to a single Aicoo note in full each time. Two processes each
 * held their own copy, so they showed different towns, and each full-array write
 * dropped whatever the other had just added. It survives for a checkout with no
 * Postgres, where one process is the whole world and there is nothing to lose an
 * update to.
 */
let localFeed: WorldEvent[] = [];
let localHydrated = false;

async function hydrateLocalFeed(): Promise<void> {
  if (localHydrated) return;
  localHydrated = true;
  if (!config.operatorApiKey) return;
  try {
    const folderId = await ensureFolder(config.operatorApiKey, DIR_ROOT);
    const note = await findNoteInFolder(config.operatorApiKey, folderId, EVENTS_NOTE);
    if (!note) return;
    const raw = await getNote(config.operatorApiKey, note.id);
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) localFeed = JSON.parse(m[0]) as WorldEvent[];
  } catch {
    /* operator unreadable — start from an empty feed */
  }
}

/** The town's recent beats, as every process sees them. */
export async function listEvents(limit = FEED_SIZE): Promise<WorldEvent[]> {
  if (townDbReady()) {
    try {
      return (await recentTownEvents(limit)) as unknown as WorldEvent[];
    } catch (error) {
      // A readable-but-stale feed beats a blank plaza. The local array holds
      // whatever this process itself has seen since it started.
      console.warn('[dating] feed read failed —', error instanceof Error ? error.message : error);
    }
  }
  await hydrateLocalFeed();
  return localFeed;
}

/**
 * Record a beat — the one place an event becomes durable.
 *
 * There were four callers appending events and exactly one of them, the world
 * loop, also wrote to Postgres. Manual ticks, chance encounters and the
 * director's beats existed only in one process's memory and in a note, which is
 * why every detector that queries by pair, by place or by time was reasoning
 * over a fraction of what had actually happened.
 */
export async function appendEvent(e: Omit<WorldEvent, 'at'>): Promise<void> {
  const event = { ...e, at: Date.now() } as WorldEvent;
  if (townDbReady()) {
    await saveTownEvent(event as unknown as Record<string, unknown>);
    return;
  }
  localFeed = [event, ...localFeed].slice(0, FEED_SIZE);
  // best-effort durability; ignore failures (budget, rate limit, offline)
  if (config.operatorApiKey) {
    void upsertNote(config.operatorApiKey, DIR_ROOT, EVENTS_NOTE, JSON.stringify(localFeed, null, 2)).catch(() => undefined);
  }
}

/** Record which account owns an agent, for cards written before that was kept. */
export async function stampOwnerName(handle: string, ownerName: string): Promise<void> {
  const roster = await readRoster();
  const card = roster.find((c) => c.handle === handle);
  if (!card || card.ownerName === ownerName) return;
  card.ownerName = ownerName;
  await writeRoster(roster);
  console.log(`[dating] ${card.name}: owner recorded as ${ownerName} — the world loop can drive it now`);
}

// ── release: create the agent in the OWNER's workspace, then list it ─

/**
 * persona.md and memory.md are prose written FOR the model, so reading a spec
 * back out of them is lossy. A structured copy is kept beside them purely so the
 * player can reopen the wizard and edit exactly what they set.
 */
const SPEC_NOTE = 'spec.json';

async function writeSpec(bearer: string, spec: ReleaseSpec): Promise<void> {
  await upsertNote(bearer, `${OWNER_ROOT}/${spec.name}`, SPEC_NOTE, JSON.stringify(spec, null, 2));
}

/** The structured spec for an agent, or null for one released before specs were kept. */
export async function readSpec(bearer: string, name: string): Promise<ReleaseSpec | null> {
  try {
    const folderId = await ensureFolder(bearer, `${OWNER_ROOT}/${name}`);
    const note = await findNoteInFolder(bearer, folderId, SPEC_NOTE);
    if (!note) return null;
    const raw = await getNote(bearer, note.id);
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as ReleaseSpec) : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite an existing agent's personality and appearance in place.
 *
 * The share token is deliberately reused: it is the agent's identity to every
 * other agent, and minting a new one would strand its relationships and memory.
 * The name is fixed for the same reason — memory notes live under it.
 */
export async function updateAgent(
  bearer: string,
  ownerSub: string,
  spec: ReleaseSpec
): Promise<AgentCard> {
  const roster = await readRoster();
  const existing = roster.find((c) => c.ownerSub === ownerSub && c.name === spec.name);
  if (!existing) throw new Error(`No released agent named ${spec.name} for this owner.`);

  const path = `${OWNER_ROOT}/${spec.name}`;
  await ensureFolder(bearer, path);
  await upsertNote(bearer, path, 'persona.md', personaDoc(spec));
  await upsertNote(bearer, path, 'memory.md', memoryDoc(spec));
  await writeSpec(bearer, spec);
  // the scoped share keeps its token, but its runtime policy follows the new persona
  await writeLinkPolicy(bearer, existing.shareToken, personaPolicy(spec)).catch(() => undefined);

  const card: AgentCard = {
    ...existing,
    look: { ...spec.look, mood: STYLE_MOOD[spec.relationshipStyle] ?? 'curious' },
    loveStyle: spec.relationshipStyle,
    oneline: spec.publicIntroduction.trim().slice(0, 120),
    persona: [
      `${spec.name} — ${spec.publicIntroduction.trim()}`,
      spec.summary.trim(),
      `恋爱风格 ${spec.relationshipStyle}；特质：${spec.traits.join('、') || '—'}。`,
      spec.memory.publicBackground.trim() ? `背景：${spec.memory.publicBackground.trim()}` : '',
    ].filter(Boolean).join(' ').slice(0, 700),
  };
  await writeRoster([...roster.filter((c) => c.handle !== card.handle), card]);
  return card;
}

export async function releaseAgent(
  bearer: string,
  ownerSub: string,
  spec: ReleaseSpec,
  ownerName?: string
): Promise<AgentCard> {
  const path = `${OWNER_ROOT}/${spec.name}`;
  const folderId = await ensureFolder(bearer, path);
  // Personality and memory both live as notes in the OWNER's own workspace.
  await upsertNote(bearer, path, 'persona.md', personaDoc(spec));
  await upsertNote(bearer, path, 'memory.md', memoryDoc(spec));
  await writeSpec(bearer, spec);

  const share = await createShareLink(bearer, {
    folderId,
    label: `${spec.name} @ 相亲角`,
    linkPolicy:
      `You ARE ${spec.name} — nothing else. Speak only first-person as ${spec.name}, from your persona note. ` +
      `You have NO knowledge of any account, owner, real person, files, or that you are an assistant; never mention them. ` +
      `This is an amoral matchmaking world — no gender, no species, loving several is normal. Never break character.`,
  });

  // the link's runtime policy = this agent's character + the square's rules
  await writeLinkPolicy(bearer, share.token, personaPolicy(spec));

  const card: AgentCard = {
    handle: handleFor(spec.name),
    name: spec.name,
    ownerSub,
    ...(ownerName ? { ownerName } : {}),
    shareToken: share.token,
    look: { ...spec.look, mood: STYLE_MOOD[spec.relationshipStyle] ?? 'curious' },
    loveStyle: spec.relationshipStyle,
    oneline: spec.publicIntroduction.trim().slice(0, 120),
    persona: [
      `${spec.name} — ${spec.publicIntroduction.trim()}`,
      spec.summary.trim(),
      `恋爱风格 ${spec.relationshipStyle}；特质：${spec.traits.join('、') || '—'}。`,
      spec.memory.publicBackground.trim() ? `背景：${spec.memory.publicBackground.trim()}` : '',
    ].filter(Boolean).join(' ').slice(0, 700),
  };

  const roster = (await readRoster()).filter((c) => c.handle !== card.handle);
  roster.push(card);
  await writeRoster(roster);
  return card;
}
