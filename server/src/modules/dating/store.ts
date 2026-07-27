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
  ownerSub: string;
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

function personaDoc(a: ReleaseSpec): string {
  const d = a.dimensions;
  return [
    `# ${a.name}`,
    '',
    a.publicIntroduction.trim() || '(no introduction)',
    '',
    `Relationship style: ${a.relationshipStyle}`,
    `Traits: ${a.traits.join(', ') || '(none)'}`,
    `Behaviour — honesty ${d.honesty}/100 · attachment ${d.attachment}/100 · aggression ${d.aggression}/100 · disclosure ${d.disclosure}/100`,
    '',
    a.summary.trim(),
    '',
    '```json',
    JSON.stringify({ appearance: a.look, relationshipStyle: a.relationshipStyle, traits: a.traits, dimensions: d }, null, 2),
    '```',
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
let recentEvents: WorldEvent[] = [];
let eventsHydrated = false;

async function hydrateEvents(): Promise<void> {
  if (eventsHydrated) return;
  eventsHydrated = true;
  if (!config.operatorApiKey) return;
  try {
    const folderId = await ensureFolder(config.operatorApiKey, DIR_ROOT);
    const note = await findNoteInFolder(config.operatorApiKey, folderId, EVENTS_NOTE);
    if (!note) return;
    const raw = await getNote(config.operatorApiKey, note.id);
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) recentEvents = JSON.parse(m[0]) as WorldEvent[];
  } catch {
    /* operator unreadable — start from an empty feed */
  }
}

export async function listEvents(): Promise<WorldEvent[]> {
  if (!eventsHydrated) await hydrateEvents();
  return recentEvents;
}

export async function appendEvent(e: Omit<WorldEvent, 'at'>): Promise<void> {
  if (!eventsHydrated) await hydrateEvents();
  recentEvents = [{ ...e, at: Date.now() }, ...recentEvents].slice(0, 25);
  // best-effort durability; ignore failures (budget, rate limit, offline)
  if (config.operatorApiKey) {
    void upsertNote(config.operatorApiKey, DIR_ROOT, EVENTS_NOTE, JSON.stringify(recentEvents, null, 2)).catch(() => undefined);
  }
}

// ── release: create the agent in the OWNER's workspace, then list it ─

export async function releaseAgent(
  bearer: string,
  ownerSub: string,
  spec: ReleaseSpec
): Promise<AgentCard> {
  const path = `${OWNER_ROOT}/${spec.name}`;
  const folderId = await ensureFolder(bearer, path);
  // Personality and memory both live as notes in the OWNER's own workspace.
  await upsertNote(bearer, path, 'persona.md', personaDoc(spec));
  await upsertNote(bearer, path, 'memory.md', memoryDoc(spec));

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
