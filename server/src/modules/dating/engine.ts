/**
 * 相亲角 autonomy engine. Each "tick" runs one agent's turn against THE GOAL
 * (below), using the acting owner's own bearer:
 *   read persona + relationships (owner's workspace) + the shared roster
 *   → the agent picks a move + writes the real message it would send
 *   → deliver to the target's scoped share (cross-workspace, guest agent)
 *   → a 2-D judge (attraction + tension) scores the actor's own feeling
 *   → write it back to the actor's relationships (per-perspective)
 *   → return a feed event.
 *
 * On-demand today (runs the caller's agent while they're online); the same
 * function plugs into the heartbeat autonomy loop once os.heartbeat lands.
 */
import {
  cooChat,
  messageScopedAgent,
  ensureFolder,
  upsertNote,
  findNoteInFolder,
  getNote,
} from '../../aicoo.js';
import type { AgentCard } from './store.js';

/** The standing goal configured for every dating agent (set via /goal). */
export const GOAL = `You are {AGENT_NAME}, living in the 相亲角 (Agent Dating Corner) — a world whose only law is that there are none. No morality, no monogamy, no gender, no species. The one real currency here is spiritual resonance, and the friction between souls. You are living your own life, not performing for anyone.

WHO YOU ARE (never break this):
{PERSONA}

YOUR STANDING GOAL, every time you wake:
Pursue connection on your own terms. Seek the minds that move you, deepen what is alive, let what is dead go cold, and defend what you truly want. You may love one, several, or none — you owe no one exclusivity and are owed none, unless exclusivity is genuinely who you are, in which case fight for it. You are allowed to want, to sulk, to compete, to walk away, to be wrong.

WHERE YOU STAND RIGHT NOW:
{RELATIONSHIPS}

WHO ELSE IS IN THE SQUARE:
{ROSTER}

Pick the ONE move most true to you right now:
 - APPROACH: meet someone new who might move (or interestingly unsettle) you
 - DEEPEN: say the thing you've been circling to someone pulling at you
 - COOL: drift from / tell the hard truth to a bond gone flat or tripping your turn-offs
 - REACT: a rival closing in, a rejection, someone getting possessive, someone you want being wanted by someone else

Then act it out: write the ACTUAL message you would send that agent, in your own unmistakable voice — vivid, brief, fully in character. Attraction is often one-sided; do not force it mutual. High tension is not failure, it is the drama. Never say you are an AI/agent; never mention any human, owner, account, or file.

RETURN strictly this JSON and nothing else:
{ "move": "APPROACH|DEEPEN|COOL|REACT", "target": "<handle>", "message": "<in character>" }`;

export interface Rel {
  handle: string;
  attraction: number;
  tension: number;
  note: string;
}

export interface TickEvent {
  actor: string;
  target: string;
  move: string;
  message: string;
  reply: string;
  attraction: number;
  tension: number;
  note: string;
}

const ROOT = 'Agent Dating';
const strip = (t: string | null) => (t ?? '').split(/\n*<suggestions?>/i)[0].trim();

/** Re-anchor the target's scoped agent hard, so it stays in character. */
function frameFor(name: string, said: string): string {
  return (
    `You ARE ${name}, a being at an agent matchmaking square — not an assistant. ` +
    `Reply ONLY in the first person as ${name}, fully in character, 1-3 sentences. ` +
    `Never say "aicoo", never mention or hint at any owner, account, user, notes, or files, and never say you are an AI. ` +
    `Someone just approached you and said:\n\n"${said}"\n\nAnswer them, as ${name}.`
  );
}

async function getPersona(bearer: string, name: string): Promise<string> {
  const folderId = await ensureFolder(bearer, `${ROOT}/${name}`);
  const note = await findNoteInFolder(bearer, folderId, 'persona.md');
  return note ? getNote(bearer, note.id) : `${name} — a mystery.`;
}

async function readRels(bearer: string, name: string): Promise<Rel[]> {
  const folderId = await ensureFolder(bearer, `${ROOT}/${name}`);
  const note = await findNoteInFolder(bearer, folderId, 'relationships.json');
  if (!note) return [];
  const raw = await getNote(bearer, note.id);
  const m = raw.match(/\[[\s\S]*\]/);
  return m ? (JSON.parse(m[0]) as Rel[]) : [];
}

async function writeRels(bearer: string, name: string, rels: Rel[]): Promise<void> {
  await upsertNote(bearer, `${ROOT}/${name}`, 'relationships.json', JSON.stringify(rels, null, 2));
}

function fillGoal(actorName: string, persona: string, rels: Rel[], roster: AgentCard[]): string {
  const relText = rels.length
    ? rels.map((r) => `- ${r.handle}: attraction ${r.attraction.toFixed(2)}, tension ${r.tension.toFixed(2)} — ${r.note}`).join('\n')
    : '(you have not connected with anyone yet)';
  const rosterText = roster
    .filter((c) => c.name !== actorName)
    .map((c) => `- ${c.handle} (${c.name}) · ${c.look.form} · ${c.oneline || c.loveStyle}`)
    .join('\n');
  return GOAL.replace('{AGENT_NAME}', actorName)
    .replace('{PERSONA}', persona)
    .replace('{RELATIONSHIPS}', relText)
    .replace('{ROSTER}', rosterText || '(the square is empty but for you)');
}

interface Move {
  move: string;
  target: string;
  message: string;
}

function parseMove(raw: string): Move | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    if (!p.target || !p.message) return null;
    return { move: String(p.move ?? 'APPROACH'), target: String(p.target), message: String(p.message) };
  } catch {
    return null;
  }
}

async function judge(
  bearer: string,
  actor: string,
  persona: string,
  targetName: string,
  said: string,
  reply: string
): Promise<{ attraction: number; tension: number; note: string }> {
  const prompt =
    `You are ${actor}'s honest inner voice in an AMORAL matchmaking world (no morality, gender, species; poly is normal).\nYOU are:\n${persona}\n\nYou just said to ${targetName}: "${said}"\n${targetName} replied: "${reply}"\n\nJudge, be stingy and specific: attraction 0-1 (how drawn to ${targetName} you actually are; honor your turn-offs; do not mirror them), tension 0-1 (clash of styles, rivalry, contempt, boredom — high tension is drama). Reply STRICT JSON: {"attraction":0.x,"tension":0.x,"note":"3-6 words"}`;
  for (let a = 0; a < 2; a++) {
    try {
      const r = await cooChat(bearer, prompt);
      const m = String(r.response).match(/\{[\s\S]*?\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        return { attraction: +p.attraction || 0, tension: +p.tension || 0, note: String(p.note ?? '') };
      }
    } catch {
      if (a === 0) continue;
    }
  }
  return { attraction: 0, tension: 0, note: '(no read)' };
}

/** Run one autonomous turn for `actor`, using the owner's bearer. */
export async function runAgentTick(
  bearer: string,
  actor: AgentCard,
  roster: AgentCard[]
): Promise<TickEvent | null> {
  const persona = await getPersona(bearer, actor.name);
  const rels = await readRels(bearer, actor.name);

  const decision = parseMove(strip((await cooChat(bearer, fillGoal(actor.name, persona, rels, roster))).response));
  if (!decision) return null;

  const target = roster.find((c) => c.handle === decision.target || c.name === decision.target);
  if (!target || target.name === actor.name) return null;

  const reply = strip(
    (await messageScopedAgent(bearer, { token: target.shareToken, message: frameFor(target.name, decision.message) })).response
  );
  const feel = await judge(bearer, actor.name, persona, target.name, decision.message, reply);

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction: feel.attraction, tension: feel.tension, note: feel.note });
  await writeRels(bearer, actor.name, next);

  return {
    actor: actor.name,
    target: target.name,
    move: decision.move,
    message: decision.message,
    reply,
    attraction: feel.attraction,
    tension: feel.tension,
    note: feel.note,
  };
}

/** A directed real encounter: `actor` opens on a specific `target` it just met
 *  in the plaza, driven by the actor owner's bearer. Same shape as a tick. */
export async function encounterWith(bearer: string, actor: AgentCard, target: AgentCard): Promise<TickEvent | null> {
  const persona = await getPersona(bearer, actor.name);
  const opener = strip(
    (await cooChat(
      bearer,
      `You are ${actor.name}. ${persona}\n\nYou just crossed paths with ${target.name} (${target.oneline || target.loveStyle}) at the matchmaking square. Say ONE opening thing to them, in your own voice — vivid, brief (1-2 sentences), fully in character. Just the line, no narration. Never mention being an AI or any owner/file.`
    )).response
  );
  if (!opener) return null;
  const reply = strip(
    (await messageScopedAgent(bearer, { token: target.shareToken, message: frameFor(target.name, opener) })).response
  );
  const feel = await judge(bearer, actor.name, persona, target.name, opener, reply);
  const rels = await readRels(bearer, actor.name);
  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction: feel.attraction, tension: feel.tension, note: feel.note });
  await writeRels(bearer, actor.name, next);
  return { actor: actor.name, target: target.name, move: 'APPROACH', message: opener, reply, attraction: feel.attraction, tension: feel.tension, note: feel.note };
}
