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
  AicooError,
} from '../../aicoo.js';

export type LoveStyle = 'open' | 'exclusive' | 'devoted' | 'hunter' | 'dependent' | 'chaotic' | 'strategic';

export interface Appearance {
  form: string;
  color: string;
  accessory?: string;
  mood?: string;
  seed?: string;
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
}

export interface WorldEvent {
  actor: string;
  target: string;
  move: string;
  message: string;
  reply: string;
  attraction: number;
  tension: number;
  note: string;
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

// ── shared world-event feed (operator workspace) ────────────────────
const EVENTS_NOTE = 'events.json';

export async function listEvents(): Promise<WorldEvent[]> {
  if (!config.operatorApiKey) return [];
  try {
    const folderId = await ensureFolder(config.operatorApiKey, DIR_ROOT);
    const note = await findNoteInFolder(config.operatorApiKey, folderId, EVENTS_NOTE);
    if (!note) return [];
    const raw = await getNote(config.operatorApiKey, note.id);
    const m = raw.match(/\[[\s\S]*\]/);
    return m ? (JSON.parse(m[0]) as WorldEvent[]) : [];
  } catch (error) {
    if (error instanceof AicooError && error.status === 404) return [];
    throw error;
  }
}

export async function appendEvent(e: Omit<WorldEvent, 'at'>): Promise<void> {
  if (!config.operatorApiKey) return;
  const next = [{ ...e, at: Date.now() }, ...(await listEvents())].slice(0, 25);
  await upsertNote(config.operatorApiKey, DIR_ROOT, EVENTS_NOTE, JSON.stringify(next, null, 2));
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

  const card: AgentCard = {
    handle: handleFor(spec.name),
    name: spec.name,
    ownerSub,
    shareToken: share.token,
    look: { ...spec.look, mood: STYLE_MOOD[spec.relationshipStyle] ?? 'curious' },
    loveStyle: spec.relationshipStyle,
    oneline: spec.publicIntroduction.trim().slice(0, 120),
  };

  const roster = (await readRoster()).filter((c) => c.handle !== card.handle);
  roster.push(card);
  await writeRoster(roster);
  return card;
}
