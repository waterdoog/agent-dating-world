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
import { listEvents, type AgentCard } from './store.js';
import { config } from '../../config.js';
import { grok, ModelError } from './grok.js';
import { remaining, reserveTurn, refundTurn } from './budget.js';

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
    attraction: 0, trust: 0, tension: 0, note,
    severity: 'ambient', headline: `${name} 破产了`, summary: `${name} ${note}`, consequence: '暂时退场', followup: '充值或等周重置',
  };
}

/** The standing goal configured for every dating agent (set via /goal). */
export const GOAL = `你是 {AGENT_NAME}，住在「相亲小镇」。这座小镇只围绕亲密关系运转：你不工作、不赚钱、没有外部任务。你唯一会做的事，是认识别人、观察关系、产生好感、试探、暧昧、约会、告白、拒绝、等待、嫉妒、竞争、隐瞒、调查、结盟、争吵、和解，或者离开。

你不一定会恋爱，也不保证配对成功。你可能一直遇不到喜欢的人；可能只享受被追求；可能喜欢的人永远不回应；也可能最终只形成友情、依赖、控制、利用或敌对。这都可以。

你是谁（绝不脱离）：
{PERSONA}

你现在真正想要的（DESIRE）：{DESIRE}
你不会直说的动机（HIDDEN MOTIVE）：{MOTIVE}
只有你知道的事（SECRETS，是筹码：可以守、可以交换、可以当武器）：
{SECRETS}

你和别人的关系历史：
{RELATIONSHIPS}

小镇上还有谁：
{ROSTER}

你刚看到/听说的（信息不对称：你只知道这些，别人知道的可能不同）：
{SITUATION}

⏳ 今天你还剩 {TURNS_LEFT} 次真实交流机会（每天上限 {TURN_BUDGET} 次）。
这是稀缺的。每次开口前先想：今天有限的机会，最值得花在谁身上？
你可以：联系最喜欢的人／回应等了很久的人／试探情敌／修补快破裂的关系／调查可疑的信息／安抚可能泄密的人／故意不回应某个人／或者省下额度等晚上。
选择本身就是剧情：把额度全砸在一个人身上、或为了查情敌耗尽额度而错过别人的告白，都是真实的后果。

允许并鼓励 FLIRTY TALK —— 但必须由你的性格、关系阶段和当前动机决定，不要每轮都强行调情，也不要说千篇一律的网络情话：
暧昧试探、调情赞美、制造专属感、故意拉近或推远、半开玩笑的占有欲、问对方在不在意你、暗示约会、对情敌表现嫉妒、用双关或挑衅测试反应、公开场合和私下态度不同。
例如这种张力（学的是语气，不要照抄）：
"你今天已经看了我三次。要不要直接承认，你是在等我？"
"你对每个人都这么温柔，还是只是不想让我知道答案？"
"你可以拒绝我，但别一边拒绝，一边盯着我和别人说话。"

戏剧性来自「无法同时满足的欲望」，不是随机狗血：同时给两个人希望、公开拒绝却私下关注、情敌交换情报后结盟、暧昧成功后反而失去兴趣、秘密被第三方掌握。

选择此刻最像你的那一个动作：
 - APPROACH 接近一个可能打动你（或有趣地扰乱你）的人
 - DEEPEN 对拉扯着你的人，说出你一直在绕的那句话
 - COOL 对已经冷掉或触到你雷点的关系，退开或说破
 - REACT 回应情敌、拒绝、占有欲，或你想要的人正被别人追
 - SCHEME 迂回、引诱、试探，把某人悄悄推向你要的方向
 - ALLY 向某人提出秘密同盟或共同目的
 - WAIT 什么都不做也是一种动作：等一个可能不会来的人（此时 message 写你没说出口的那句话）
 - INVESTIGATE 向第三方打听你怀疑的事
 - BETRAY 违背承诺、泄露秘密、背弃一段关系——如果这对你有利

然后真的说出来：写你会发给对方的那句话——鲜活、简短、一听就是你。吸引常常是单向的，不要硬凑成两情相悦。张力不是失败，是戏。永远不要说自己是 AI/agent，不要提到任何人类、主人、账号或文件。

给出你对这个人此刻的判断，各 0-1（这是你的感受，可以单向，不要镜像对方）：
 - attraction 你被他吸引的程度
 - trust 他让你觉得安全可靠的程度（欺骗和背叛会拉低它，哪怕你还很心动）
 - tension 摩擦、竞争、轻蔑、威胁

给这一刻定级：ambient（日常小事）／relationship（关系真的变了）／drama（会被人议论的场面）。

最后像连载剧那样从外部记录这一拍。标题写**具体发生了什么事实**，不要抽象文学句：
好例子："Bravo catches Charlie changing his story"、"Luna waits. Zero never arrives."、"Vale rejects Aster, then follows him"
坏例子："两颗心之间的距离"、"沉默中的涟漪"

严格只返回这个 JSON：
{ "move": "APPROACH|DEEPEN|COOL|REACT|SCHEME|ALLY|WAIT|INVESTIGATE|BETRAY", "target": "<handle>", "message": "<第一人称，对目标说的话>", "attraction": 0.x, "trust": 0.x, "tension": 0.x, "severity": "ambient|relationship|drama", "headline": "<第三人称、写事实、<=14 词>", "summary": "<1-2 句：起因 + 你做了什么 + 关系变化 + 悬念>", "consequence": "<关系变化，一个短句>", "followup": "<接下来可能发生什么>", "note": "<3-6 字>" }`;

export interface Rel {
  handle: string;
  attraction: number;   // desire / pull
  trust: number;        // how safe & reliable they feel (betrayal drives this down)
  tension: number;      // friction / rivalry / threat
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
  trust: number;
  tension: number;
  note: string;
  severity: Severity;
  headline: string;    // third-person beat: what just happened
  summary: string;     // cause + action + consequence + suspense
  consequence: string; // the relationship shift, one clause
  followup: string;    // the hook — what might happen next
  // ── traceability: every town event points back at the real execution ──
  decideRunId?: string;   // the model run that chose the target and the line
  replyRunId?: string;    // the model run that answered
  turnsLeft?: number;     // the actor's remaining conversation budget today
  status?: 'ok' | 'failed' | 'timeout' | 'queued' | 'no-budget';
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
  return m ? (JSON.parse(m[0]) as Rel[]).map((r) => ({ ...r, trust: r.trust ?? 0.3 })) : [];
}

async function writeRels(bearer: string, name: string, rels: Rel[]): Promise<void> {
  await upsertNote(bearer, `${ROOT}/${name}`, 'relationships.json', JSON.stringify(rels, null, 2));
}

/** The agent's private memory note — public background + the hidden part. */
async function getMemory(bearer: string, name: string): Promise<{ secrets: string }> {
  try {
    const folderId = await ensureFolder(bearer, `${ROOT}/${name}`);
    const note = await findNoteInFolder(bearer, folderId, 'memory.md');
    if (!note) return { secrets: '' };
    const raw = await getNote(bearer, note.id);
    const hidden = raw.split(/HIDDEN MEMORY/i)[1] ?? '';
    return { secrets: hidden.replace(/^[^\n]*\n/, '').trim().slice(0, 600) };
  } catch {
    return { secrets: '' };
  }
}

/** What this agent wants right now, derived from its own relationship history. */
function desireOf(rels: Rel[]): { desire: string; motive: string } {
  if (!rels.length) return { desire: '还没遇到任何人，想知道这里有谁值得认识。', motive: '不想显得太急切。' };
  const top = [...rels].sort((a, b) => b.attraction - a.attraction)[0];
  const hot = [...rels].sort((a, b) => b.tension - a.tension)[0];
  const shaky = [...rels].sort((a, b) => (a.trust ?? 0.3) - (b.trust ?? 0.3))[0];
  const desire = top.attraction >= 0.6
    ? `你现在最在意 ${top.handle}（心动 ${top.attraction.toFixed(2)}）—— 你想知道这是不是单向的。`
    : `没有谁真正抓住你，你在等一个值得的人，或者享受被追。`;
  const motive = hot && hot.tension >= 0.5
    ? `你和 ${hot.handle} 之间的张力（${hot.tension.toFixed(2)}）你不会承认，但它影响你的每个选择。`
    : shaky && (shaky.trust ?? 1) < 0.3
      ? `你其实不太信任 ${shaky.handle}，但你没打算说破。`
      : `你不想第一个把底牌翻开。`;
  return { desire, motive };
}

function fillGoal(
  actorName: string,
  persona: string,
  rels: Rel[],
  roster: AgentCard[],
  situation: string,
  secrets: string,
  turnsLeft: number
): string {
  const relText = rels.length
    ? rels.map((r) => `- ${r.handle}: 心动 ${r.attraction.toFixed(2)}, 信任 ${(r.trust ?? 0.3).toFixed(2)}, 张力 ${r.tension.toFixed(2)} — ${r.note}`).join('\n')
    : '(你还没和任何人建立关系)';
  const rosterText = roster
    .filter((c) => c.name !== actorName)
    .map((c) => `- ${c.handle} (${c.name}) · ${c.oneline || c.loveStyle}`)
    .join('\n');
  const { desire, motive } = desireOf(rels);
  return GOAL.replace('{AGENT_NAME}', actorName)
    .replace('{PERSONA}', persona)
    .replace('{DESIRE}', desire)
    .replace('{MOTIVE}', motive)
    .replace('{SECRETS}', secrets || '(你没有藏着什么——目前为止)')
    .replace('{RELATIONSHIPS}', relText)
    .replace('{ROSTER}', rosterText || '(小镇上只有你)')
    .replace('{SITUATION}', situation || '(小镇现在很安静)')
    .replace('{TURNS_LEFT}', String(turnsLeft))
    .replace('{TURN_BUDGET}', String(config.dailyTurnBudget));
}

/** Phase 3 — the director: the last few square beats that touch `actor`, so turns chain. */
function situationFor(actorName: string, rels: Rel[], recent: TickEvent[]): string {
  const known = new Set([actorName, ...rels.map((r) => r.handle)]);
  const lines = recent
    .filter((e) => e.headline && (known.has(e.actor) || known.has(e.target) || e.severity === 'drama'))
    .slice(0, 6)
    .map((e) => `- ${e.headline}${e.consequence ? ` (${e.consequence})` : ''}`);
  return lines.join('\n');
}

const clamp01 = (v: unknown) => Math.max(0, Math.min(1, +(v ?? 0) || 0));
const SEVERITIES: Severity[] = ['ambient', 'relationship', 'drama'];
const asSeverity = (v: unknown): Severity => (SEVERITIES.includes(v as Severity) ? (v as Severity) : 'relationship');

interface Move {
  move: string;
  target: string;
  message: string;
  attraction: number;   // the agent's own read of the target, folded into the decide (no separate judge call)
  trust: number;
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
      trust: clamp01(p.trust),
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

/**
 * An agent's cognition. Every town model call goes through the single Grok
 * gateway — no owner COO, no per-page model choice — and every run is recorded
 * so the resulting town event can be traced back to it.
 */
async function think(prompt: string, purpose: string, agent: string, json = true): Promise<{ text: string; runId: string }> {
  const { text, run } = await grok(prompt, {
    purpose,
    agent,
    json,
    system: '你是相亲小镇里的一个居民。永远待在角色里，永远只按要求的 JSON 格式回答，不要解释、不要加前后缀。',
  });
  return { text: strip(text), runId: run.id };
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
 * The target answers, in its own voice, on the town's model — loaded with its
 * real persona + memory from its OWNER's workspace, plus how it currently feels
 * about the speaker. Information is asymmetric: it answers from what IT knows.
 */
async function replyFrom(
  target: AgentCard,
  actorName: string,
  line: string,
  creds: Map<string, string>
): Promise<{ text: string; runId: string }> {
  const targetKey = creds.get(target.ownerSub);
  const persona = targetKey ? await personaOf(targetKey, target.name) : (target.persona || target.oneline || target.name);
  const rels = targetKey ? await readRels(targetKey, target.name).catch(() => []) : [];
  const mine = rels.find((r) => r.handle.toLowerCase() === actorName.toLowerCase());
  const feeling = mine
    ? `你对 ${actorName} 目前的感觉：心动 ${mine.attraction.toFixed(2)}、信任 ${(mine.trust ?? 0.3).toFixed(2)}、张力 ${mine.tension.toFixed(2)}（${mine.note}）。`
    : `${actorName} 对你来说还是个新面孔。`;
  const prompt =
    `你是「${target.name}」，住在相亲小镇——这里只有亲密关系，没有道德约束、没有性别与物种之分。\n` +
    `绝不说自己是 AI、助理或 COO；绝不提到任何主人、账号、公司、笔记或文件。只用第一人称说话，1-3 句，鲜活、像你自己。\n` +
    `你可以调情、试探、回避、嫉妒、冷淡，甚至拒绝——按你的性格和你此刻的感觉来，不要一味迎合。\n\n` +
    `你是谁：\n${persona}\n\n${feeling}\n\n` +
    `${actorName} 刚走过来对你说：\n"${line}"\n\n只回答你要说的那句话本身，不要旁白、不要引号。`;
  const { text, run } = await grok(prompt, { purpose: 'reply', agent: target.name, temperature: 1.0 });
  return { text: strip(text), runId: run.id };
}

/**
 * One autonomous turn in the town, end to end:
 *   personality + desire + hidden motive + secrets + relationship history
 *   + what this agent happens to know + nearby roster + today's remaining budget
 *   → target selection & decision (Grok)
 *   → a real conversation turn (Grok, in the target's own voice)
 *   → relationship change written back to the owner's workspace
 *   → a traceable town event carrying both model run ids.
 *
 * Budget is reserved atomically BEFORE any model call. Out of budget means the
 * turn does not happen — that silence is the story, never a faked exchange.
 * A failed model call surfaces as failed/timeout; it never invents content.
 */
export async function runAgentTick(
  bearer: string,
  actor: AgentCard,
  roster: AgentCard[],
  creds: Map<string, string>
): Promise<TickEvent | null> {
  const left = remaining(actor.name);
  if (left <= 0) return null;                    // spent today — it simply doesn't speak

  const [persona, memory, rels] = await Promise.all([
    getPersona(bearer, actor.name),
    getMemory(bearer, actor.name),
    readRels(bearer, actor.name),
  ]);
  const situation = situationFor(actor.name, rels, (await listEvents().catch(() => [])) as TickEvent[]);

  const prompt = fillGoal(actor.name, persona, rels, roster, situation, memory.secrets, left);
  let decision: Move | null = null;
  let decideRunId: string | undefined;
  try {
    const out = await think(prompt, 'decide', actor.name);
    decideRunId = out.runId;
    decision = parseMove(out.text);
  } catch (error) {
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: '', move: 'FAILED', message: '', reply: '',
        attraction: 0, trust: 0, tension: 0, note: error.run.error ?? error.status,
        severity: 'ambient',
        headline: `${actor.name} 这一轮没能行动`,
        summary: `模型调用 ${error.status}：${error.run.error ?? ''}`.trim(),
        consequence: '', followup: '', decideRunId: error.run.id,
        turnsLeft: left, status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }
  if (!decision) return null;

  const target = roster.find((c) => c.handle === decision!.target || c.name === decision!.target);
  if (!target || target.name === actor.name) return null;

  // WAIT is a real move: the agent chooses NOT to spend a turn on anyone.
  if (decision.move === 'WAIT') {
    return {
      actor: actor.name, target: target.name, move: 'WAIT',
      message: decision.message, reply: '',
      attraction: decision.attraction, trust: decision.trust, tension: decision.tension,
      note: decision.note, severity: decision.severity,
      headline: decision.headline || `${actor.name} 等着 ${target.name}，没有开口`,
      summary: decision.summary, consequence: decision.consequence, followup: decision.followup,
      decideRunId, turnsLeft: left, status: 'ok',
    };
  }

  // atomically reserve the conversation turn before spending it
  if (!reserveTurn(actor.name, target.name)) return null;

  let reply: string;
  let replyRunId: string | undefined;
  try {
    const out = await replyFrom(target, actor.name, decision.message, creds);
    reply = out.text;
    replyRunId = out.runId;
  } catch (error) {
    refundTurn(actor.name, target.name);          // the turn provably never happened
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: decision.move,
        message: decision.message, reply: '',
        attraction: decision.attraction, trust: decision.trust, tension: decision.tension,
        note: error.run.error ?? error.status, severity: 'ambient',
        headline: `${target.name} 没有回应${actor.name}`,
        summary: `对方的回合 ${error.status}：${error.run.error ?? ''}`.trim(),
        consequence: '', followup: '', decideRunId, replyRunId: error.run.id,
        turnsLeft: remaining(actor.name), status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction: decision.attraction, trust: decision.trust, tension: decision.tension, note: decision.note });
  await writeRels(bearer, actor.name, next).catch(() => undefined);

  return {
    actor: actor.name,
    target: target.name,
    move: decision.move,
    message: decision.message,
    reply,
    attraction: decision.attraction,
    trust: decision.trust,
    tension: decision.tension,
    note: decision.note,
    severity: decision.severity,
    headline: decision.headline || `${actor.name} 对 ${target.name} ${decision.move}`,
    summary: decision.summary || decision.note || '',
    consequence: decision.consequence || '',
    followup: decision.followup || '',
    decideRunId,
    replyRunId,
    turnsLeft: remaining(actor.name),
    status: 'ok',
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
  const left = remaining(actor.name);
  if (left <= 0) return null;                      // no turns left today

  const [persona, rels] = await Promise.all([getPersona(bearer, actor.name), readRels(bearer, actor.name)]);
  const mine = rels.find((r) => r.handle === target.handle);
  const history = mine
    ? `你对 ${target.name} 目前：心动 ${mine.attraction.toFixed(2)}、信任 ${(mine.trust ?? 0.3).toFixed(2)}、张力 ${mine.tension.toFixed(2)}（${mine.note}）`
    : `你还没和 ${target.name} 说过话。`;

  let o: { message?: string; attraction?: unknown; trust?: unknown; tension?: unknown; note?: unknown } | null = null;
  let decideRunId: string | undefined;
  try {
    const out = await think(
      `你是「${actor.name}」，住在相亲小镇。\n${persona}\n\n${history}\n` +
        `你今天还剩 ${left} 次交流机会。你刚在广场上迎面遇到 ${target.name}（${target.oneline || target.loveStyle}）。\n` +
        `说出你会对 ${target.name} 说的开场白——1-2 句，鲜活、像你自己。可以调情、试探、挑衅或冷淡，按你的性格来，不要客套。\n` +
        `绝不说自己是 AI，不要提任何主人/账号/文件。\n\n` +
        `严格只返回 JSON：{"message":"<你说的话>","attraction":0.x,"trust":0.x,"tension":0.x,"note":"<3-6字>"}`,
      'encounter',
      actor.name
    );
    decideRunId = out.runId;
    const m = out.text.match(/\{[\s\S]*\}/);
    if (m) o = JSON.parse(m[0]);
  } catch (error) {
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: 'APPROACH', message: '', reply: '',
        attraction: 0, trust: 0, tension: 0, note: error.run.error ?? error.status, severity: 'ambient',
        headline: `${actor.name} 张了张嘴，没能说出话`,
        summary: `模型调用 ${error.status}：${error.run.error ?? ''}`.trim(),
        consequence: '', followup: '', decideRunId: error.run.id,
        turnsLeft: left, status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }
  if (!o?.message) return null;

  const message = String(o.message);
  const attraction = clamp01(o.attraction);
  const trust = clamp01(o.trust);
  const tension = clamp01(o.tension);
  const note = String(o.note ?? '');

  if (!reserveTurn(actor.name, target.name)) return null;
  let reply: string;
  let replyRunId: string | undefined;
  try {
    const out = await replyFrom(target, actor.name, message, creds);
    reply = out.text;
    replyRunId = out.runId;
  } catch (error) {
    refundTurn(actor.name, target.name);
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: 'APPROACH', message, reply: '',
        attraction, trust, tension, note: error.run.error ?? error.status, severity: 'ambient',
        headline: `${target.name} 没有回应 ${actor.name}`,
        summary: `对方的回合 ${error.status}`, consequence: '', followup: '',
        decideRunId, replyRunId: error.run.id,
        turnsLeft: remaining(actor.name), status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction, trust, tension, note });
  await writeRels(bearer, actor.name, next).catch(() => undefined);
  return {
    actor: actor.name, target: target.name, move: 'APPROACH', message, reply, attraction, trust, tension, note,
    severity: tension > 0.6 ? 'drama' : 'relationship',
    headline: `${actor.name} 在广场上叫住了 ${target.name}`,
    summary: note ? `${actor.name} 走近 ${target.name}：${note}` : `${actor.name} 走近了 ${target.name}`,
    consequence: '', followup: '',
    decideRunId, replyRunId, turnsLeft: remaining(actor.name), status: 'ok',
  };
}
