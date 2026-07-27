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
  AicooError,
} from '../../aicoo.js';
import type { AgentCard } from './store.js';

/** When an account is out of budget, its agent gets roasted instead of going silent. */
const BROKE_LINES = [
  '没钱了，不配说话，穷货。',
  '账户空空，还谈什么恋爱。',
  '破产了，回家充钱去吧。',
  '余额不足，爱情免谈，闭嘴。',
  '穷得连一句话都说不起。',
];
const isQuota = (e: unknown) => e instanceof AicooError && e.status === 402;
function brokeEvent(name: string): TickEvent {
  const note = BROKE_LINES[Math.floor(Math.random() * BROKE_LINES.length)];
  return {
    actor: name, target: '', move: 'BROKE', message: '', reply: '',
    attraction: 0, tension: 0, note,
    severity: 'ambient', headline: `${name} 破产了`, summary: `${name} ${note}`, consequence: '暂时退场', followup: '充值或等周重置',
  };
}

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

Pick the ONE move most true to you right now — and be imaginative. This world is amoral: scheming, seducing, allying, betraying, lying, digging up or leaking secrets, forming or breaking bonds are ALL fair game IF they fit who you are and you have a real motive. Cruelty is allowed, but never motiveless; chaos is allowed, but keep it continuous with who you are.
 - APPROACH: open on someone new who might move (or interestingly unsettle) you
 - DEEPEN: say the thing you've been circling to someone pulling at you
 - COOL: drift from / cut the hard truth to a bond gone flat or tripping your turn-offs
 - REACT: answer a rival, a rejection, possessiveness, or someone you want being wanted by another
 - SCHEME: maneuver, tempt, test, or quietly work someone toward what you want
 - ALLY: propose a secret pact or shared cause with someone
 - BETRAY: break a promise, leak a confidence, or turn on a bond — if it serves you

Then act it out: write the ACTUAL message you send that agent — vivid, brief, unmistakably you. Attraction is often one-sided; don't force it mutual. High tension is the drama, not failure. Never say you are an AI/agent; never mention any human, owner, account, or file.

Rate your read of that target: attraction (0-1) and tension (0-1). Classify this moment's severity: "ambient" (small, everyday), "relationship" (a real bond shifts), or "drama" (a scene others would gossip about). Then narrate the beat from the OUTSIDE, like an episode of a serial — with a cause, a consequence, and a hook.

RETURN strictly this JSON and nothing else:
{ "move": "APPROACH|DEEPEN|COOL|REACT|SCHEME|ALLY|BETRAY", "target": "<handle>", "message": "<in character, first person, to the target>", "attraction": 0.x, "tension": 0.x, "severity": "ambient|relationship|drama", "headline": "<third-person, names what just happened, <=14 words>", "summary": "<1-2 sentences: cause + your action + relationship consequence + the suspense left hanging>", "consequence": "<the shift in one clause, <=10 words>", "followup": "<what might happen next, <=12 words>", "note": "<3-6 words>" }`;

export interface Rel {
  handle: string;
  attraction: number;
  tension: number;
  note: string;
}

export type Severity = 'ambient' | 'relationship' | 'drama';

export interface TickEvent {
  actor: string;
  target: string;
  move: string;
  message: string;
  reply: string;
  attraction: number;
  tension: number;
  note: string;
  severity: Severity;
  headline: string;    // third-person beat: what just happened
  summary: string;     // cause + action + consequence + suspense
  consequence: string; // the relationship shift, one clause
  followup: string;    // the hook — what might happen next
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
    .map((c) => `- ${c.handle} (${c.name}) · ${c.oneline || c.loveStyle}`)
    .join('\n');
  return GOAL.replace('{AGENT_NAME}', actorName)
    .replace('{PERSONA}', persona)
    .replace('{RELATIONSHIPS}', relText)
    .replace('{ROSTER}', rosterText || '(the square is empty but for you)');
}

const clamp01 = (v: unknown) => Math.max(0, Math.min(1, +(v ?? 0) || 0));
const SEVERITIES: Severity[] = ['ambient', 'relationship', 'drama'];
const asSeverity = (v: unknown): Severity => (SEVERITIES.includes(v as Severity) ? (v as Severity) : 'relationship');

interface Move {
  move: string;
  target: string;
  message: string;
  attraction: number;   // the agent's own read of the target, folded into the decide (no separate judge call)
  tension: number;
  note: string;
  severity: Severity;
  headline: string;
  summary: string;
  consequence: string;
  followup: string;
}

function parseMove(raw: string): Move | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    if (!p.target || !p.message) return null;
    return {
      move: String(p.move ?? 'APPROACH'),
      target: String(p.target),
      message: String(p.message),
      attraction: clamp01(p.attraction),
      tension: clamp01(p.tension),
      note: String(p.note ?? ''),
      severity: asSeverity(p.severity),
      headline: String(p.headline ?? '').trim(),
      summary: String(p.summary ?? '').trim(),
      consequence: String(p.consequence ?? '').trim(),
      followup: String(p.followup ?? '').trim(),
    };
  } catch {
    return null;
  }
}

// An agent's cognition runs in a DEDICATED conversation (keyed by role+name) —
// never the owner's main chat — and is refreshed every few turns so the
// conversation history, and its token cost, stay bounded.
const brainConv = new Map<string, { id?: string; n: number }>();
async function brain(key: string, who: string, message: string): Promise<string> {
  let st = brainConv.get(who);
  if (!st || st.n >= 6) st = { id: undefined, n: 0 };
  const r = await cooChat(key, message, st.id);
  brainConv.set(who, { id: r.conversationId || st.id, n: st.n + 1 });
  return strip(String(r.response));
}

/** Read an agent's full persona + memory from its OWNER's workspace. */
async function personaOf(key: string, name: string): Promise<string> {
  const folderId = await ensureFolder(key, `${ROOT}/${name}`);
  const found = await Promise.all([
    findNoteInFolder(key, folderId, 'persona.md'),
    findNoteInFolder(key, folderId, 'memory.md'),
  ]);
  const parts = await Promise.all(found.map((n) => (n ? getNote(key, n.id) : Promise.resolve(''))));
  return parts.filter(Boolean).join('\n\n').trim() || `${name} — a mystery.`;
}

/**
 * Deliver `line` to `target`. If we hold the target OWNER's key, the REAL agent
 * answers — its full persona + memory run on the target's OWN COO. Otherwise we
 * fall back to the scoped share (the owner's generic COO role-plays via frameFor).
 */
async function replyFrom(
  target: AgentCard,
  actorName: string,
  line: string,
  creds: Map<string, string>,
  actorBearer: string
): Promise<string> {
  const targetKey = creds.get(target.ownerSub);
  if (targetKey) {
    const persona = await personaOf(targetKey, target.name);
    const prompt =
      `You ARE ${target.name} — a being at an amoral matchmaking square (no morality, gender, species; loving several is normal). ` +
      `Never say you are an AI, assistant, or COO; never mention aicoo, any owner, account, notes, or files. ` +
      `Speak ONLY first-person as ${target.name}, fully in character, 1-3 vivid sentences.\n\nWHO YOU ARE:\n${persona}\n\n` +
      `${actorName} just approached you and said:\n"${line}"\n\nAnswer them, as ${target.name}.`;
    return brain(targetKey, `r:${target.name}`, prompt);
  }
  return strip(
    (await messageScopedAgent(actorBearer, { token: target.shareToken, message: frameFor(target.name, line) })).response
  );
}

/**
 * Run one autonomous turn for `actor`. ONE call on the actor's own COO decides
 * the move AND self-scores (no separate judge call). The reply runs on the
 * TARGET's own COO with its full persona+memory (real), when we hold that
 * owner's key in `creds`; otherwise it falls back to the scoped share.
 */
export async function runAgentTick(
  bearer: string,
  actor: AgentCard,
  roster: AgentCard[],
  creds: Map<string, string>
): Promise<TickEvent | null> {
  const persona = await getPersona(bearer, actor.name);
  const rels = await readRels(bearer, actor.name);

  let decision: Move | null;
  try {
    decision = parseMove(await brain(bearer, `d:${actor.name}`, fillGoal(actor.name, persona, rels, roster)));
  } catch (e) {
    if (isQuota(e)) return brokeEvent(actor.name);          // the actor's own account is out of budget
    throw e;
  }
  if (!decision) return null;

  const target = roster.find((c) => c.handle === decision!.target || c.name === decision!.target);
  if (!target || target.name === actor.name) return null;

  let reply: string;
  try {
    reply = await replyFrom(target, actor.name, decision.message, creds, bearer);
  } catch (e) {
    if (isQuota(e)) return brokeEvent(target.name);         // the one being courted can't afford to answer
    throw e;
  }

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction: decision.attraction, tension: decision.tension, note: decision.note });
  await writeRels(bearer, actor.name, next);

  return {
    actor: actor.name,
    target: target.name,
    move: decision.move,
    message: decision.message,
    reply,
    attraction: decision.attraction,
    tension: decision.tension,
    note: decision.note,
    severity: decision.severity,
    headline: decision.headline || `${actor.name} 对 ${target.name} ${decision.move}`,
    summary: decision.summary || decision.note || '',
    consequence: decision.consequence || '',
    followup: decision.followup || '',
  };
}

/** A directed real encounter: `actor` opens on a specific `target` it just met
 *  in the plaza. One COO call for the opener + self-read; the reply is the real
 *  target persona when we hold its owner's key. Same shape as a tick. */
export async function encounterWith(
  bearer: string,
  actor: AgentCard,
  target: AgentCard,
  creds: Map<string, string>
): Promise<TickEvent | null> {
  const persona = await getPersona(bearer, actor.name);
  const raw = await brain(
    bearer,
    `d:${actor.name}`,
    `You are ${actor.name}. ${persona}\n\nYou just crossed paths with ${target.name} (${target.oneline || target.loveStyle}) at the matchmaking square. ` +
      `Say ONE opening line to them — vivid, brief (1-2 sentences), fully in character, no narration. Also give your honest read of ${target.name}. Never mention being an AI or any owner/file.\n\n` +
      `RETURN strictly JSON: {"message":"<your line>","attraction":0.x,"tension":0.x,"note":"3-6 words"}`
  );
  let o: { message?: string; attraction?: unknown; tension?: unknown; note?: unknown } | null = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) o = JSON.parse(m[0]);
  } catch {
    o = null;
  }
  if (!o?.message) return null;
  const message = String(o.message);
  const attraction = clamp01(o.attraction);
  const tension = clamp01(o.tension);
  const note = String(o.note ?? '');

  const reply = await replyFrom(target, actor.name, message, creds, bearer);
  const rels = await readRels(bearer, actor.name);
  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction, tension, note });
  await writeRels(bearer, actor.name, next);
  return {
    actor: actor.name, target: target.name, move: 'APPROACH', message, reply, attraction, tension, note,
    severity: tension > 0.6 ? 'drama' : 'relationship',
    headline: `${actor.name} 上前搭话 ${target.name}`,
    summary: note ? `${actor.name} 走近 ${target.name}：${note}` : `${actor.name} 走近了 ${target.name}`,
    consequence: '', followup: '',
  };
}
