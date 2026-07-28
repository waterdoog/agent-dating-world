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
import { absorb, narrate, knownTo, duplicatePromises, recordKnowledge } from './threads.js';
import { commitCrime, falloutOf, wantedLevel, NPCS, npcNow, livePositions } from './town-life.js';
import { placeAt, townBrief, routeHint } from './town-map.js';
import { remember, recall } from './memory.js';

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

你现在在哪、镇上有什么（你活在这个地方，说话时可以用上它）：
{PLACES}

你上次对这个人说过的话（⚠️ 绝对不许重复这些话的意思、开场白或要求）：
{LASTSAID}

你刚看到/听说的（信息不对称：你只知道这些，别人知道的可能不同）：
{SITUATION}

⏳ 今天你还剩 {TURNS_LEFT} 次真实交流机会（每天上限 {TURN_BUDGET} 次）。
这是稀缺的。每次开口前先想：今天有限的机会，最值得花在谁身上？
你可以：联系最喜欢的人／回应等了很久的人／试探情敌／修补快破裂的关系／调查可疑的信息／安抚可能泄密的人／故意不回应某个人／或者省下额度等晚上。
选择本身就是剧情：把额度全砸在一个人身上、或为了查情敌耗尽额度而错过别人的告白，都是真实的后果。

允许并鼓励 FLIRTY TALK —— 但必须由你的性格、关系阶段和当前动机决定，不要每轮都强行调情，也不要说千篇一律的网络情话：
暧昧试探、调情赞美、制造专属感、故意拉近或推远、半开玩笑的占有欲、问对方在不在意你、暗示约会、对情敌表现嫉妒、用双关或挑衅测试反应、公开场合和私下态度不同。
✍️ 你的说话方式由你的 persona 决定，和别人明显不同。一句话里最多一个比喻，不要每句都写成"像…一样"的文艺腔；有人说话就是短、硬、不修饰。
语气参考（别照抄）："你今天已经看了我三次，要不要承认你在等我？"／"你可以拒绝我，但别一边拒绝一边盯着我和别人说话。"

⚠️ 只有暧昧不算剧情——这一拍必须真的发生了什么。你不必守传统恋爱道德：可以同时追多人、欺骗、利用好感、挑拨情敌、制造嫉妒、用秘密换亲密、抢别人的对象——只要符合你的性格和历史。

每一拍至少含一种：明确背叛／互相利用／公开说法与私下行为冲突／第三者介入／秘密泄露／权力交换／有代价的选择／当事人不知道全部真相。

形状参考：同一句承诺给两个人／当着某人面撩第三个／刚拒绝又不许他走／和情敌结盟但私藏关键／用秘密换单独见面／公开选一个私下约另一个／说真话但删掉关键背景／对方选了别人才突然告白／故意让人"恰好"撞见。

🚫 禁止：抽象逼问（"你在不在意我"）；只有两人的封闭对峙（要卷进第三人）；consequence 写"关系推近了"这种没有权力变化的话；连续两拍 WAIT。

你说的那句话里必须有一个具体的东西：时间、地点、你看见的动作、第三个人的名字，或一个条件。
❌"你站稳我就站稳" ✅"昨晚你和Charlie在酒馆待到最后，我没进去。今晚呢？"

动作：APPROACH 接近／DEEPEN 说出一直在绕的话／COOL 退开或说破／REACT 回应情敌或拒绝／SCHEME 迂回引诱／ALLY 提出秘密同盟／WAIT 等一个可能不来的人（只在刚发出邀约时用）／INVESTIGATE 向第三方打听／BETRAY 泄密背弃／CONFESS 摊牌告白，把想要的关系直接说出口／REJECT 明确拒绝对方，把话说死／EXPOSE 当面拆穿对方说过的谎或双重承诺／LEAVE 认清自己不想要这段，退出这条线

⏰ 不许原地打转（最重要的一条）：
 - **禁止复述**：如果你上次已经说过"你把同一句话递给了别人""你心里那个人是不是我"这类话，这一拍**不许再说一遍**。同一个指控只能提一次。
 - **禁止提条件不兑现**：如果你上次提了条件（"你先走近""你先把那道门关上""你先证明"），这一拍要么**自己先做到**（真的走过去、真的把另一个人推开、真的把告白拿出来），要么**收回条件**直接给答案，要么**转身去找别人**。不许把同一个条件再提一次。
 - 如果对方连着两次没有照做，那就是**他的回答**——按这个回答行动（REJECT 断掉、LEAVE 退出、或者转向第三个人），不要继续等。
 - 超过三拍还在同一个僵局：这一拍**禁止** EXPOSE 和逼问，只能 CONFESS 落地／REJECT 断掉／LEAVE 退出／或转向别人。
🔍 如果你发现某人对你和对别人说了几乎一样的话——直接 EXPOSE，当面把两句话摆出来。／CRIME 越界（steal-letter 偷情书｜stage-scene 让人撞见｜bribe-vendor 买行踪｜spread-lie 散假消息｜break-in 砸约会；此时 target 是受害者，另给 "crime" 字段）。

这一拍**改变了多少**（不是重新打分，是增减量，范围 -0.3 ~ +0.3，没变就填 0）：
 - dAttraction 他这句话让你更想要他，还是让你冷了？
 - dTrust 他更可信了，还是又骗了你一次？（被拆穿、发现同一句话给了别人 → 大幅下降）
 - dTension 摩擦升高还是缓和？（当众逼问、卷入第三人 → 升高；真的说清楚了 → 下降）
大多数拍只该有小变化（±0.05 上下）；只有真正的转折（告白、拆穿、背叛、和解）才配 ±0.2 以上。
如果这一拍又是同样的拉扯、对方又没有给你答案，那不是"没变化"——是在**磨损**：dTrust 要给负值，dTension 要给正值。
定级：ambient 日常／relationship 关系真的变了／drama 会被议论的场面。
headline 写事实不写气氛：✅"Charlie promises SmokeCat exclusivity—after telling Bravo the same thing" ❌"SmokeCat approaches Charlie while the square stays quiet"
consequence 写权力变化，如 "one promise, two recipients"、"rejection becomes possession"、"public loyalty, private desire"。
summary 交代：你真正的动机、谁不知道全部真相、这次之后谁握住了谁。

📍 **地点是必答项**：你说的那句话里必须出现小镇上的一个具体地方（酒馆／花摊／长椅区／钟楼／广场／喷泉边），不能只说"过来""见一面"。
这个选择就是你的态度：广场和长椅区是公开的，说了全镇都知道；酒馆（尤其后门、包厢）和钟楼背面没人听得见。
想让谁难堪就把话放在公开的地方说；想护着谁、或想私下交易，就挑个没人的地方。
❌"今晚见一面" ✅"今晚九点，酒馆后门——别在广场上说这个"

按这个格式回答：
{ "move": "APPROACH|DEEPEN|COOL|REACT|SCHEME|ALLY|WAIT|INVESTIGATE|BETRAY|CRIME|CONFESS|REJECT|EXPOSE|LEAVE", "crime": "<仅当 move=CRIME 时给出>", "target": "<handle>", "message": "<第一人称，对目标说的话>", "dAttraction": 0.0, "dTrust": 0.0, "dTension": 0.0, "severity": "ambient|relationship|drama", "headline": "<第三人称、写事实、<=14 词>", "summary": "<1-2 句：起因 + 你做了什么 + 关系变化 + 悬念>", "consequence": "<关系变化，一个短句>", "followup": "<接下来可能发生什么>", "note": "<3-6 字>" }`;

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

export async function readRels(bearer: string, name: string): Promise<Rel[]> {
  const folderId = await ensureFolder(bearer, `${ROOT}/${name}`);
  const note = await findNoteInFolder(bearer, folderId, 'relationships.json');
  if (!note) return [];
  const raw = await getNote(bearer, note.id);
  const m = raw.match(/\[[\s\S]*\]/);
  return m ? (JSON.parse(m[0]) as Rel[]).map((r) => ({ ...r, trust: r.trust ?? 0.3 })) : [];
}

export async function writeRels(bearer: string, name: string, rels: Rel[]): Promise<void> {
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

/**
 * The town as this agent knows it, in three layers:
 *   1. where I am and who is within earshot
 *   2. what each place is FOR, and whether it's public or private
 *   3. what the townsfolk are doing right now
 * Deliberately no raw coordinates — a model can't reason about {x:74,y:28},
 * and the numbers leak into dialogue. Privacy is the lever that turns a map
 * into strategy: "今晚酒馆后门" only means something if the bar is private and
 * the plaza is not.
 */
function placesFor(actorName: string, roster: AgentCard[], positions?: Map<string, { x: number; y: number }>): string {
  const lines: string[] = [];
  const me = positions?.get(actorName.toLowerCase());
  const herePlace = me ? placeAt(me.x, me.y) : undefined;
  if (herePlace) lines.push(`- 你现在在${herePlace.name}（${herePlace.side}）。`);

  const near = roster
    .filter((c) => c.name.toLowerCase() !== actorName.toLowerCase())
    .map((c) => {
      const p = positions?.get(c.name.toLowerCase());
      if (!p) return null;
      const dist = me ? Math.hypot(p.x - me.x, p.y - me.y) : 999;
      return { name: c.name, place: placeAt(p.x, p.y), dist };
    })
    .filter(Boolean) as Array<{ name: string; place: { id: string; name: string }; dist: number }>;

  const close = near.filter((n) => n.dist < 22).sort((a, b) => a.dist - b.dist);
  if (close.length) {
    lines.push(`- 听得见你说话的：${close.map((n) => `${n.name}（${n.place.name}）`).join('、')}`);
  }
  const far = near.filter((n) => n.dist >= 22);
  if (far.length) {
    lines.push(
      `- 在别处：${far.map((n) => {
        const hint = herePlace ? routeHint(herePlace.id, n.place.id) : '';
        return `${n.name}在${n.place.name}${hint ? `（${hint}）` : ''}`;
      }).join('、')}`
    );
  }

  lines.push('', '小镇上的地方（约人见面时挑一个，公开还是私密由你决定）：', townBrief());

  const folk = NPCS.map((n) => {
    const now = npcNow(n.id);
    return now ? `${n.name}正在${now.doing}` : null;
  }).filter(Boolean);
  if (folk.length) lines.push('', `- 此刻：${folk.join('；')}`);
  return lines.join('\n');
}

/**
 * The exact lines this agent used most recently, per person. Without this an
 * agent re-opens every turn as if for the first time, and the square fills with
 * the same accusation repeated a dozen times.
 */
function lastSaidBy(actorName: string, recent: TickEvent[]): string {
  const seen = new Map<string, string[]>();
  for (const e of recent) {
    if (e.actor !== actorName || !e.message) continue;
    const lines = seen.get(e.target) ?? [];
    if (lines.length < 2) lines.push(`「${e.message.slice(0, 90)}」`);
    seen.set(e.target, lines);
  }
  if (!seen.size) return '';
  return [...seen.entries()]
    .slice(0, 3)
    .map(([who, lines]) => `- 对 ${who}，你最近说过：${lines.join('；')}`)
    .join('\n');
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
  turnsLeft: number,
  memory = '',
  places = '',
  lastSaid = ''
): string {
  const relText = rels.length
    ? rels.map((r) => `- ${r.handle}: 心动 ${r.attraction.toFixed(2)}, 信任 ${(r.trust ?? 0.3).toFixed(2)}, 张力 ${r.tension.toFixed(2)} — ${r.note}（这些是当前值，你这一拍只需说变化量）`).join('\n')
    : '(你还没和任何人建立关系)';
  const rosterText = roster
    .filter((c) => c.name !== actorName)
    .map((c) => `- ${c.handle} (${c.name}) · ${c.oneline || c.loveStyle}`)
    .join('\n');
  const { desire, motive } = desireOf(rels);
  return GOAL.replace('{AGENT_NAME}', actorName)
    .replace('{PERSONA}', persona.slice(0, 700))
    .replace('{DESIRE}', desire)
    .replace('{MOTIVE}', motive)
    .replace('{SECRETS}', (secrets || '(你没有藏着什么——目前为止)').slice(0, 300))
    .replace('{RELATIONSHIPS}', relText)
    .replace('{ROSTER}', rosterText || '(小镇上只有你)')
    .replace('{SITUATION}', ((memory ? `你记得的（你自己的记忆）：\n${memory}\n\n` : '') + (situation || '(小镇现在很安静)')).slice(0, 1400))
    .replace('{PLACES}', places || '(小镇：中央广场、酒馆、花摊、长椅、钟楼)')
    .replace('{LASTSAID}', (lastSaid || '(你还没对他说过话——这是第一次)').slice(0, 700))
    .replace('{TURNS_LEFT}', String(turnsLeft))
    .replace('{TURN_BUDGET}', String(config.dailyTurnBudget));
}

/**
 * What this agent happens to know right now — deliberately partial. It sees
 * beats involving people it knows (or public drama), plus anything it has been
 * told or has worked out. If it has heard a line that someone else also heard
 * word-for-word, that lands here too: the raw material for "两个情敌发现听到了
 * 同一句承诺". Everyone gets a different view of the same town.
 */
function situationFor(actorName: string, rels: Rel[], recent: TickEvent[]): string {
  const known = new Set([actorName.toLowerCase(), ...rels.map((r) => r.handle.toLowerCase())]);
  const lines: string[] = [];

  // What YOU just did comes first: it is the one thing that must survive any
  // truncation, or the agent repeats itself forever.
  const own = recent.filter((e) => e.actor.toLowerCase() === actorName.toLowerCase()).slice(0, 3);
  if (own.length) {
    lines.push(`- 你自己最近做过：${own.map((e) => `[${e.move}]→${e.target}「${e.headline}」`).join('；')}`);
    const banned = [...new Set(own.slice(0, 2).map((e) => e.move))];
    lines.push(`- 🚫 这一拍**禁止**再用：${banned.join('、')}。必须换一个真正不同的动作。`);
    if (own.length >= 2 && own[0].target.toLowerCase() === own[1].target.toLowerCase()) {
      lines.push(`- 🚫 你连续两拍都在找 ${own[0].target}。这一拍**必须换人**，或把第三个人拉进来。`);
    }
    if (own[0].move === 'WAIT') lines.push('- ⚠️ 上一拍你已经在等了，这一拍禁止再 WAIT。');
    // A pair that has circled for several beats must land somewhere.
    const withTarget = recent.filter(
      (e) => [e.actor.toLowerCase(), e.target.toLowerCase()].includes(actorName.toLowerCase())
    );
    const partner = own[0]?.target;
    if (partner) {
      const rounds = withTarget.filter((e) =>
        [e.actor.toLowerCase(), e.target.toLowerCase()].includes(partner.toLowerCase())
      ).length;
      if (rounds >= 3) {
        lines.push(`- ⏰ 你和 ${partner} 已经来回 ${rounds} 拍还没有结果。这一拍**必须落地**：CONFESS 告白／REJECT 拒绝／EXPOSE 拆穿／LEAVE 退出，选一个。`);
      }
    }
    const tics = own.map((e) => e.note).filter(Boolean);
    if (tics.length && new Set(tics).size < tics.length) {
      lines.push(`- 🚫 你反复在做同一件事（${tics[0]}）。这一拍必须推进：摊牌、拉第三人进来，或放弃这条线。`);
    }
  }

  const shared = recent
    .filter((e) => e.headline && (known.has(e.actor.toLowerCase()) || known.has(e.target.toLowerCase()) || e.severity === 'drama'))
    .slice(0, 4)
    .map((e) => `- ${e.headline}${e.consequence ? `（${e.consequence}）` : ''}`);
  lines.push(...shared);

  for (const k of knownTo(actorName)) lines.push(`- 你知道一件关于 ${k.about} 的事：${k.fact}（${k.source}）`);

  const heat = wantedLevel(actorName);
  if (heat > 0) lines.push(`- ⚠️ 你现在的通缉度是 ${heat}/5，巡警老陈盯着你。再犯会更难收场。`);

  // your own last moves — so you don't run the same play twice in a row
  // did someone say the same thing to this agent AND to someone else?
  for (const d of duplicatePromises()) {
    if (d.a.toLowerCase() === actorName.toLowerCase() || d.b.toLowerCase() === actorName.toLowerCase()) {
      const other = d.a.toLowerCase() === actorName.toLowerCase() ? d.b : d.a;
      lines.push(`- 你隐约听说，${d.speaker} 对 ${other} 说过几乎和对你一样的话。`);
    }
  }
  return lines.join('\n');
}

const clamp01 = (v: unknown) => Math.max(0, Math.min(1, +(v ?? 0) || 0));
/** A single beat may only nudge a reading — a real reversal is ±0.3 at most. */
const clampDelta = (v: unknown) => Math.max(-0.3, Math.min(0.3, +(v ?? 0) || 0));
const SEVERITIES: Severity[] = ['ambient', 'relationship', 'drama'];
const asSeverity = (v: unknown): Severity => (SEVERITIES.includes(v as Severity) ? (v as Severity) : 'relationship');

interface Move {
  move: string;
  crime?: string;
  target: string;
  message: string;
  dAttraction: number;   // how much THIS beat moved the reading — applied to the standing value
  dTrust: number;
  dTension: number;
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
      crime: p.crime ? String(p.crime) : undefined,
      target: String(p.target),
      message: String(p.message),
      dAttraction: clampDelta(p.dAttraction),
      dTrust: clampDelta(p.dTrust),
      dTension: clampDelta(p.dTension),
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
async function think(prompt: string, purpose: string, agent: string, bearer: string, shareToken?: string, json = true): Promise<{ text: string; runId: string }> {
  const { text, run } = await grok(prompt, {
    purpose,
    agent,
    json,
    bearer,        // executes as this agent's OWNER account, on that account's Grok
    shareToken,    // …but inside the agent's own sandbox, never the owner's personal chat
    system: '你是相亲小镇里的一个居民，永远待在角色里，按要求的格式回答。',
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
  creds: Map<string, string>,
  fallbackBearer: string
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
    `你可以调情、试探、回避、嫉妒、冷淡，甚至拒绝——按你的性格和你此刻的感觉来，不要一味迎合。\n` +
    `⚠️ 不要说"我站稳""说清楚""我只说真话"这类空洞硬话。要有**具体的情绪和画面**：吃醋就说出你看见了什么、心动就说你注意到了他哪个动作、想拒绝就给一个具体的理由或条件。\n` +
    `可以主动提出见面、可以反将一军、可以故意提起第三个人让对方在意。\n\n` +
    `你是谁：\n${persona}\n\n${feeling}\n\n` +
    `${actorName} 刚走过来对你说：\n"${line}"\n\n只回答你要说的那句话本身，不要旁白、不要引号。`;
  // the reply executes on the TARGET's own account when we hold it, so each
  // agent literally answers from its own workspace; else the caller's account.
  const { text, run } = await grok(prompt, { purpose: 'reply', agent: target.name, temperature: 1.0, bearer: targetKey ?? fallbackBearer, shareToken: target.shareToken });
  const said = strip(text);
  // Concurrent calls on one account can cross wires and hand back another
  // purpose's JSON. A spoken line is never a JSON object — treat that as a
  // failed turn rather than putting machine output in someone's mouth.
  if (/^\s*[{[]/.test(said) || /"headline"\s*:|"lines"\s*:/.test(said)) {
    throw new ModelError('failed', 'reply came back as structured output, not speech', run);
  }
  return { text: said, runId: run.id };
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
  const recentEvents = (await listEvents().catch(() => [])) as TickEvent[];
  const situation = situationFor(actor.name, rels, recentEvents);

  // Pull back what this agent actually remembers about the person it is most
  // entangled with, instead of carrying the whole town history in the prompt.
  const focus = [...rels].sort((a, b) => (b.attraction + b.tension) - (a.attraction + a.tension))[0];
  const recalled = focus ? await recall(bearer, actor.name, focus.handle).catch(() => '') : '';
  const places = placesFor(actor.name, roster, livePositions());
  const lastSaid = lastSaidBy(actor.name, recentEvents);
  const prompt = fillGoal(actor.name, persona, rels, roster, situation, memory.secrets, left, recalled, places, lastSaid);
  let decision: Move | null = null;
  let decideRunId: string | undefined;
  try {
    const out = await think(prompt, 'decide', actor.name, bearer, actor.shareToken);
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

  // Readings evolve: the model reports how much THIS exchange moved things, and
  // we apply that to where the relationship already stood. A first meeting
  // starts from a neutral baseline rather than a number invented on the spot.
  const standing = rels.find((r) => r.handle === target.handle);
  const base = standing ?? { attraction: 0.25, trust: 0.3, tension: 0.15 };
  const scored = {
    attraction: clamp01(base.attraction + decision.dAttraction),
    trust: clamp01((base.trust ?? 0.3) + decision.dTrust),
    tension: clamp01(base.tension + decision.dTension),
  };


  // CRIME: the agent crosses a line on its own. Real wanted level, real damage
  // to the victim's feelings, and the victim finds out it was them.
  if (decision.move === 'CRIME' && decision.crime) {
    const done = commitCrime(actor.name, decision.crime, target.name);
    const f = done ? falloutOf(decision.crime, actor.name, target.name) : null;
    if (done && f) {
      const victimKey = creds.get(target.ownerSub);
      if (victimKey) {
        const vrels = await readRels(victimKey, target.name).catch(() => []);
        const cur = vrels.find((r) => r.handle.toLowerCase() === actor.name.toLowerCase());
        const next = vrels.filter((r) => r.handle.toLowerCase() !== actor.name.toLowerCase());
        next.push({
          handle: actor.handle,
          attraction: Math.max(0, Math.min(1, (cur?.attraction ?? 0.3) + f.attractionDelta)),
          trust: Math.max(0, Math.min(1, (cur?.trust ?? 0.3) + f.trustDelta)),
          tension: Math.max(0, Math.min(1, (cur?.tension ?? 0.2) + f.tensionDelta)),
          note: f.rumour.slice(0, 60),
        });
        await writeRels(victimKey, target.name, next).catch(() => undefined);
      }
      recordKnowledge({ holder: target.name, about: actor.name, fact: f.rumour, source: '小镇上传开的' });
      const ev: TickEvent = {
        actor: actor.name, target: target.name, move: 'CRIME',
        message: decision.message, reply: '',
        attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
        note: done.label, severity: 'drama',
        headline: decision.headline || f.rumour,
        summary: decision.summary || `${actor.name} ${done.label}。${target.name} 会知道是谁干的。`,
        consequence: decision.consequence || 'a crime lands on someone who can feel it',
        followup: decision.followup || `${target.name} 会当面质问，还是先按住不说？`,
        decideRunId, turnsLeft: remaining(actor.name), status: 'ok',
      };
      const th = absorb(ev);
      if (th && th.beats.length >= 2) await narrate(th, bearer, actor.shareToken).catch(() => undefined);
      return ev;
    }
  }

  // WAIT is a real move: the agent chooses NOT to spend a turn on anyone.
  if (decision.move === 'WAIT') {
    return {
      actor: actor.name, target: target.name, move: 'WAIT',
      message: decision.message, reply: '',
      attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
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
    const out = await replyFrom(target, actor.name, decision.message, creds, bearer);
    reply = out.text;
    replyRunId = out.runId;
  } catch (error) {
    refundTurn(actor.name, target.name);          // the turn provably never happened
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: decision.move,
        message: decision.message, reply: '',
        attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
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
  next.push({ handle: target.handle, attraction: scored.attraction, trust: scored.trust, tension: scored.tension, note: decision.note });
  await writeRels(bearer, actor.name, next).catch(() => undefined);

  // keep the beat in the owner's own notes; compaction happens there, so the
  // prompt never has to carry the full history again
  void remember(bearer, actor.name, target.name, {
    at: Date.now(), move: decision.move, said: decision.message, heard: reply,
    consequence: decision.consequence,
  }, actor.shareToken).catch(() => undefined);

  // information now moves between agents: what was leaked, or dug up, is
  // something the OTHER party genuinely knows from here on.
  if (decision.move === 'BETRAY' || decision.move === 'INVESTIGATE') {
    recordKnowledge({
      holder: target.name,
      about: actor.name,
      fact: decision.message.slice(0, 160),
      source: decision.move === 'BETRAY' ? `${actor.name} 亲口说的` : `${actor.name} 来打听时露的口风`,
    });
  }

  const event: TickEvent = {
    actor: actor.name,
    target: target.name,
    move: decision.move,
    message: decision.message,
    reply,
    attraction: scored.attraction,
    trust: scored.trust,
    tension: scored.tension,
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

  // fold this beat into the pair's continuing story, and re-narrate the thread
  // when it has enough history to actually be a story.
  const thread = absorb(event);
  if (thread && thread.beats.length >= 2) await narrate(thread, bearer, actor.shareToken).catch(() => undefined);

  return event;
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
        `按这个格式回答：{"message":"<你说的话>","attraction":0.x,"trust":0.x,"tension":0.x,"note":"<3-6字>"}`,
      'encounter',
      actor.name,
      bearer,
      actor.shareToken
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
    const out = await replyFrom(target, actor.name, message, creds, bearer);
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
  const event: TickEvent = {
    actor: actor.name, target: target.name, move: 'APPROACH', message, reply, attraction, trust, tension, note,
    severity: tension > 0.6 ? 'drama' : 'relationship',
    headline: `${actor.name} 在广场上叫住了 ${target.name}`,
    summary: note ? `${actor.name} 走近 ${target.name}：${note}` : `${actor.name} 走近了 ${target.name}`,
    consequence: '', followup: '',
    decideRunId, replyRunId, turnsLeft: remaining(actor.name), status: 'ok',
  };
  const thread = absorb(event);
  if (thread && thread.beats.length >= 2) await narrate(thread, bearer, actor.shareToken).catch(() => undefined);
  return event;
}
