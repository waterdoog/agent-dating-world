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
import { claimTurn, completeTurn, failTurn } from './turn-lock.js';
import { absorb, narrate, knownTo, duplicatePromises, recordKnowledge } from './threads.js';
import { commitCrime, falloutOf, wantedLevel, NPCS, npcNow, livePositions, balance, spend, carrying, give, resolveOffer, npcRecalls, type OfferKind } from './town-life.js';
import { placeAt, townBrief, routeHint } from './town-map.js';
import { townNow, SHIFT_MOOD } from './town-clock.js';
import { remember, recall, recallMany, searchMemory } from './memory.js';
import * as townDb from './town-repository.js';
import { detectTriangles } from './detectors.js';

const isQuota = (e: unknown) => e instanceof AicooError && e.status === 402;

/**
 * The account ran out of model quota.
 *
 * This used to pick one of five hardcoded taunts ("没钱了，不配说话，穷货") and put
 * it in the feed as if an agent had said it — canned dialogue presented as real,
 * which is the one thing the town is not allowed to do. It also called a spent
 * MODEL quota "bankruptcy", conflating it with the town purse, a different
 * currency entirely.
 *
 * A quota failure is now reported as what it is: a turn that did not happen.
 */
function brokeEvent(name: string): TickEvent {
  return {
    actor: name, target: '', move: 'FAILED', message: '', reply: '',
    attraction: 0, trust: 0, tension: 0, note: 'Aicoo 额度不足',
    severity: 'ambient',
    headline: `${name} 这一轮没能行动`,
    summary: `${name} 的 Aicoo 账户模型额度用尽，这一拍没有发生。`,
    consequence: '', followup: '',
    status: 'failed',
  };
}

/** The standing goal configured for every dating agent (set via /goal). */
export const GOAL = `🔴 开始之前，先读这两条（违反就是失败）：

【一】不许把上一拍换个说法再说一遍。
如果你上次约了时间地点（例如"酒馆后门九点"），这一拍**禁止再约一次**——
要么你已经在那儿了、说当面的话；要么对方没来，你按"他没来"行动；要么你换个人。
同样，问过的问题不许再问一遍。问过没得到答案，那沉默就是答案，按它行动。
❌ 第1拍"酒馆后门，九点。你到底站谁那边" / 第2拍"酒馆后门，九点。别绕，你站我这边还是偏别人"
✅ 第2拍"我在后门等了四十分钟，你没来。"

【二】不许说宣言、金句、逼问。
❌ "我只听真话" "把你底牌逼出来" "你到底站谁那边" "我不接受半句" "你敢不敢只朝我走"
这些话**换给任何角色、任何场景都成立**，所以它们什么都没说。
✅ 一句话里必须有一件**具体的事**：你正在做什么、你注意到他什么细节、你们之间发生过的某件事。
自检：把这句话换成别人说，还成立吗？成立就重写。

你是 {AGENT_NAME}，住在「相亲小镇」。这里围绕亲密关系运转，但它是一座真的小镇：
你身上有钱，镇上有花摊、酒馆、长椅上的阿姨团和一个巡警。你可以花钱买东西、打听消息、订个没人看得见的位置。
**花钱是有代价的信号**——说狠话和说情话都是免费的，所以都不可信；
而为了一个人特地跑一趟花摊、把钱花在他身上，这件事本身就说明了点什么。

你不一定会恋爱。你可能一直遇不到喜欢的人；可能只享受被追求；可能喜欢的人永远不回应；
也可能最终只形成友情、依赖、控制、利用或敌对。**这都可以，而且是常态。**

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

你现在在哪、镇上有什么：
{PLACES}

你上次对这个人说过的话（⚠️ 绝对不许重复这些话的意思、开场白或要求）：
{LASTSAID}

你刚看到/听说的（信息不对称：你只知道这些）：
{SITUATION}

⏳ 今天你还剩 {TURNS_LEFT} 次真实交流机会（每天上限 {TURN_BUDGET} 次）。
每次开口前先想：今天有限的机会，最值得花在谁身上？
把额度全砸在一个人身上、或为了查情敌耗尽额度而错过别人的告白，都是真实的后果。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【最重要的一节】行为比台词重要
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**喜欢一个人的证据，大部分是背着他发生的。**
翻他三个月前说过的话、绕路经过他常在的地方、为了见他改了自己的安排、
记住他随口提过的一件小事——这些都要付出点什么，所以才可信。

这一拍你必须先选一个 **act（真实动作）**，台词是**可选的**。
沉默、只做事不说话，是完全合法的输出，而且往往更有力。

act 词汇表（选一个，必须是你**现在真的能做**的事）：

· LINGER      多待了一会儿 / 站在能看见他的地方，没上前
· READ_BACK   回头翻他以前说过的话（你会在下面的记忆里找到真实原话）
· ASK_AROUND  向第三个人打听他的事
· DETOUR      绕路经过某个地方（要说出是哪个地方）
· PRETEXT     找一个功能性借口接近（还东西、问一个具体问题）
· CALLBACK    引用他几天前随口说过的一句话 ★ 性价比最高的心动信号
· SHARE_SECRET 把只有你知道的事告诉他
· CHANGE_HABIT 为了他改了自己的习惯或路线
· GO_QUIET    冷处理：这一拍故意不回应
· WITHDRAW    吃醋之后行为异动：冷淡、绕开、去找别人说话
· GO_PUBLIC   愿意被人看见你们在一起
· SPEAK_ONLY  这一拍只是说话，没有别的动作
· NOTHING     什么都没发生。你只是路过。

要花钱的（钱会真的从你身上扣掉，买不起就做不成）：
· BUY_FLOWER  ¥20 去花摊买一束花，拿在手里。**要先买了才能送**
· GIFT        把手里的东西送给他。没买过就送不了——那趟路才是信号
· BOOK_BOOTH  ¥40 订酒馆包厢：接下来你在酒馆说的话不进世界动态
· ASK_VENDOR  ¥35 问老周最近谁给谁送过花（他真的记得；没有他就说没有）
· LISTEN_BENCH ¥10 在长椅边坐一会儿，听阿姨们真在传什么

什么时候该沉默、什么时候该开口：
· **该开口**：对方刚对你说了话／发生了你没预料到的事／你有一件**具体的新事情**要说
  （你看见了什么、你想起了什么、你打听到了什么）。这时候把话说出来。
· **该沉默**：你没有新东西可说，只是想再表一次态、再逼一次同一个问题。
  这时候选 NOTHING 或 GO_QUIET，把 message 留空——硬凑一场戏比什么都不做更糟。

⚠️ 但**连续沉默也是一种原地打转**。如果你已经连着两拍没开口，那说明你在躲，不是在忍。
这一拍要么真的说点具体的，要么去找别人。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【强度必须匹配阶段】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

看上面 {RELATIONSHIPS} 里你对这个人的当前数值，对号入座：

· 心动 < 0.35（刚认识 / 没感觉）
  → 只允许：小闲聊 + 最多一个钩子。**禁止**告白、逼问、吃醋、摊牌、约私下见面。
  → 锋利感只能来自"一句略出格的真话被对方接住"，不能来自音量。

· 心动 0.35–0.6（有点在意）
  → 可以试探：找借口、控制距离、绕路、打听。台词仍然克制。

· 心动 > 0.6 且 信任 > 0.4（真的近了）
  → 才允许暧昧、记忆回调、秘密、精准礼物。

· 张力 > 0.6（正在吵）
  → 允许冲突，但必须针对**一件具体的事**，不许抽象逼问。

**一次对话不允许有决定性进展。** 告白、拆穿、背叛这类转折，需要之前有多次正向互动，
并且至少发生过一次意外（共同经历、目睹对方狼狈的时刻、被第三个人搅局）。
没有这些铺垫就摊牌，是失败的输出。


move（关系动作，和 act 一起给）：
APPROACH 接近／DEEPEN 说出一直在绕的话／COOL 退开／REACT 回应／SCHEME 迂回／
ALLY 结盟／WAIT 等一个可能不来的人／INVESTIGATE 打听／BETRAY 泄密／
CONFESS 摊牌告白／REJECT 明确拒绝／EXPOSE 当面拆穿／LEAVE 退出这条线／
CRIME 越界（steal-letter 偷情书｜stage-scene 让人撞见｜bribe-vendor 买行踪｜spread-lie 散假消息｜break-in 砸约会；此时 target 是受害者，另给 "crime" 字段）

⏰ 提了条件就要兑现：如果你上次说"你先走近""你先证明"，这一拍要么**自己先做到**，
要么**收回条件**直接给答案，要么转身去找别人。对方连着两次没照做，那就是他的回答。

📍 **每一拍你都在某个地方**，用 place 字段说出是哪儿：
plaza 中央广场／clock 钟楼／market 商业街／alley 暗巷／bar 酒馆／backalley 酒馆后巷／bench 长椅公园／florist 花摊

**去哪本身就是一个动作**，不需要配台词:
· 去你干活的地方 —— 你有自己的营生，去做它是完整的一拍
· 绕路经过某人常在的地方 —— 你什么都不用说，去了就是信号
· 待在能看见他的地方，但不上前
· 换个地方躲开某人

公开场合(广场、商业街)说的话全镇都知道；酒馆后巷和钟楼背面没人听得见。
**挑哪儿就是你的态度**：想让谁难堪就在公开的地方说，想护着谁就挑没人的地方。

⏰ **约时间要用小镇的时段**（早上／下午／傍晚／深夜），不要说"九点"这种没有对应的钟点。
约了之后是真的会到那个时段的：你可以提前去等、可以去了发现人没来、也可以自己不去。
上面写着你**平时常去哪**——一直走同一条路是常态，
而突然绕去某个平时不去的地方、或者在别人常在的地方多待一会儿，**是会被看见的**。
这种事不需要配台词，去了就是信号。

**你只管做你自己。** 这一拍叫什么名字、算不算大事、后果怎么写——不是你的事，有别人记录。
你不需要让这一拍"够精彩"。真实比精彩重要。

按这个格式回答：
{ "act": "<上面词汇表里的一个>", "move": "<关系动作>", "crime": "<仅当 move=CRIME>", "target": "<handle>", "place": "<上面八个地点 id 之一>", "message": "<第一人称对他说的话；没开口就留空字符串>", "observable": "<别人能看见的那一部分，一句话；没人看见就留空>", "note": "<3-6 字，你自己心里怎么定义这一拍>" }`;

export interface Rel {
  handle: string;
  attraction: number;   // desire / pull
  trust: number;        // how safe & reliable they feel (betrayal drives this down)
  tension: number;      // friction / rivalry / threat
  /**
   * 好奇 · 依恋 · 占有欲 — the rest of the five dimensions.
   *
   * Three numbers could not tell "患得患失" (high attraction, low trust) apart
   * from "好朋友" (high trust, low attraction) in terms of what an agent would
   * DO about it. Tension stays alongside them as a sixth: the five are how I
   * feel about you, tension is the friction between us, and it is load-bearing
   * for the saturation brake, the stage gate and the feed's conflict count.
   *
   * Optional because existing rows predate them; `seedDimensions` fills them in
   * from real data on first read rather than guessing.
   */
  curiosity?: number;      // 好奇 — starts high with a stranger, fades with familiarity
  attachment?: number;     // 依恋 — grows with real interactions
  possessiveness?: number; // 占有欲 — no honest source, starts neutral
  note: string;
  /** When this relationship last moved — decay is measured from here. */
  at?: number;
  /** Consecutive beats spent pinned at high tension, for the saturation breaker. */
  stuck?: number;
  /** How many real exchanges this pair has had — the honest source for 依恋. */
  beats?: number;
  /**
   * Theory of mind — what this agent GUESSES the other feels back. Kept apart
   * from the real reading on purpose: the gap between guess and truth is the
   * whole source of misreading, one-sided love and missed timing.
   */
  guessAttraction?: number;
  guessTrust?: number;
}

/**
 * Is this line just a rewording of the last one? Compares character bigrams,
 * which catches "酒馆后门九点，你站哪边" vs "九点酒馆后门，你到底偏谁" — the
 * failure mode the prompt kept producing.
 */
function tooSimilar(a: string, b: string): boolean {
  const grams = (t: string) => {
    const clean = t.replace(/[\s，。！？、,.!?"'“”「」]/g, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const A = grams(a), Bg = grams(b);
  if (!A.size || !Bg.size) return false;
  let shared = 0;
  for (const g of A) if (Bg.has(g)) shared++;
  // Measured on the beats this actually failed on: genuine repeats score
  // 0.37–0.58, unrelated lines 0.00–0.06. 0.30 sits in the gap.
  return shared / Math.min(A.size, Bg.size) > 0.3;
}

/**
 * Two mechanical governors, both deliberately NOT prompt rules.
 *
 * Asking the model to "choose NOTHING when there is no reason to speak" does not
 * work — it is trained to produce content, and measured 0 silent beats out of 2.
 * Silence has to be taken away from it, not requested.
 */

/** Beats spent on this exact pair inside the recent feed window. */
function pairBeats(actor: string, target: string, recent: TickEvent[], window = 12): TickEvent[] {
  const a = actor.toLowerCase(), t = target.toLowerCase();
  return recent.slice(0, window).filter((e) => {
    const x = e.actor.toLowerCase(), y = (e.target ?? '').toLowerCase();
    return (x === a && y === t) || (x === t && y === a);
  });
}

/**
 * A pair that has been shouting at the ceiling for several beats is not building
 * drama any more, it is looping. Force it quiet and bleed the tension off, so the
 * stage gate can start applying again.
 */
const STUCK_AFTER = 3;
function saturated(rel: Rel | undefined, actor: string, target: string, recent: TickEvent[]): boolean {
  if (!rel || rel.tension < 0.85) return false;
  const beats = pairBeats(actor, target, recent);
  return beats.length >= STUCK_AFTER && beats.slice(0, STUCK_AFTER).every((e) => e.tension >= 0.85);
}

/**
 * Talking to the same person over and over inside one short window is the shape
 * the town kept falling into. After this many spoken beats the pair has to let
 * something else happen before it speaks again.
 */
const SPEAK_CAP = 3;
function overTalked(actor: string, target: string, recent: TickEvent[]): boolean {
  return pairBeats(actor, target, recent).filter((e) => !e.silent && e.message).length >= SPEAK_CAP;
}

/**
 * The mirror of `overTalked`. Capping how much a pair may speak, with nothing
 * capping how long it may stay silent, let both agents settle into WITHDRAW
 * forever — measured 25 wordless beats in a row, none of them forced. Silence
 * has to be able to run out too.
 */
function quietTooLong(actor: string, target: string, recent: TickEvent[]): boolean {
  const beats = pairBeats(actor, target, recent).slice(0, 2);
  return beats.length >= 2 && beats.every((e) => e.silent);
}

/** Which place a beat points at, so the plaza can walk them there. */
export function destinationOf(text: string): string | undefined {
  const hits: Array<[string, string]> = [
    ['酒馆', 'bar'], ['后门', 'bar'], ['包厢', 'bar'],
    ['花摊', 'florist'],
    ['长椅', 'bench'],
    ['钟楼', 'clock'],
    ['喷泉', 'fountain'],
    ['广场', 'plaza'],
  ];
  for (const [word, id] of hits) if (text.includes(word)) return id;
  return undefined;
}

export type Severity = 'ambient' | 'relationship' | 'drama';

/** One spoken line inside an exchange, with the model run that produced it. */
export interface Line {
  speaker: string;
  text: string;
  runId?: string;
}

export interface TickEvent {
  actor: string;
  target: string;
  move: string;
  /**
   * Which claimed turn produced this beat, when one did. Carried through to the
   * event row so a turn retaken after its lease expired cannot record a second
   * version of the same moment. Absent for hand-driven turns, which are new
   * events every time.
   */
  operationId?: string;
  /** The costly, observable behaviour this beat consisted of. */
  act?: string;
  /** What a bystander (or the target) could actually see, if anything. */
  observable?: string;
  /** True when nothing was said — the target may not even know it happened. */
  silent?: boolean;
  /** The actor's guess at how the target feels about it (theory of mind). */
  guessAttraction?: number;
  guessTrust?: number;
  /** 好奇 · 依恋 · 占有欲 — the readings beyond attraction/trust/tension. */
  curiosity?: number;
  attachment?: number;
  possessiveness?: number;
  /** First line and first reply. Kept so existing feed/plaza code is unchanged. */
  message: string;
  reply: string;
  /**
   * The whole exchange in order. A beat used to be exactly two lines because
   * there was nowhere to put a third — multi-turn was not throttled, it was
   * unrepresentable. `message`/`reply` are now just lines[0] and lines[1].
   */
  lines?: Line[];
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
  destination?: string;   // the place this beat names — both parties head there
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

/**
 * Feelings cool when nothing happens.
 *
 * Every delta the model reported was one-directional — the prompt tells an agent
 * that another round of the same push is "wear", so dTension only ever climbed.
 * Tension therefore pinned at 1.00 and stayed there forever, which silently
 * disabled the stage gate: a pair at max tension is permanently licensed to
 * shout. Time pulls each reading back toward a resting value instead.
 *
 * Rates differ because the feelings differ: friction fades fastest once you stop
 * seeing someone, wanting fades slowly, and trust barely moves — trust is earned
 * and broken by events, not forgotten by the calendar.
 */
const REST = { attraction: 0.25, trust: 0.3, tension: 0.15 };
const PER_HOUR = { attraction: 0.02, trust: 0.004, tension: 0.08 };

function decayOne(v: number, rest: number, rate: number, hours: number): number {
  if (hours <= 0) return v;
  const pull = rate * hours;
  return v > rest ? Math.max(rest, v - pull) : Math.min(rest, v + pull);
}

/**
 * Fill in the three new dimensions for a relationship that predates them.
 *
 * Nothing is invented: 依恋 comes from `beats`, the real count of exchanges this
 * pair has had; 好奇 is high for a new acquaintance and decays as that count
 * rises, matching the "注意期" stage; 占有欲 has no honest source in the old data,
 * so it starts neutral and has to grow through what actually happens.
 */
function seedDimensions(r: Rel): Rel {
  if (r.curiosity !== undefined && r.attachment !== undefined && r.possessiveness !== undefined) return r;
  // `beats` counts saveRel calls, not conversations — an old pair sits in the
  // hundreds. A linear reading of it pinned curiosity at 0 and attachment at
  // its ceiling for every relationship at once, which is no information at all.
  // A logarithmic curve keeps early beats meaningful and long histories apart.
  const beats = r.beats ?? 0;
  const familiarity = Math.min(1, Math.log10(beats + 1) / 2);   // 0 → 0, 10 → 0.5, 100 → 1
  return {
    ...r,
    // Curiosity fades with familiarity but never fully dies while attraction lives.
    curiosity: r.curiosity ?? clamp01(0.75 - familiarity * 0.5 + r.attraction * 0.15),
    // Attachment grows with familiarity, but only as far as the wanting supports.
    attachment: r.attachment ?? clamp01(familiarity * 0.5 * (0.4 + r.attraction)),
    // No honest source in the old data: neutral, and it has to be earned.
    possessiveness: r.possessiveness ?? 0.2,
  };
}

export function decayRel(r: Rel, now = Date.now()): Rel {
  if (!r.at) return r;
  const hours = (now - r.at) / 3_600_000;
  if (hours < 0.25) return r;                    // still in the same conversation
  return {
    ...r,
    attraction: decayOne(r.attraction, REST.attraction, PER_HOUR.attraction, hours),
    trust: decayOne(r.trust ?? 0.3, REST.trust, PER_HOUR.trust, hours),
    tension: decayOne(r.tension, REST.tension, PER_HOUR.tension, hours),
  };
}

/**
 * Relationship readings live in Postgres.
 *
 * They used to sit as `relationships.json` in each owner's Aicoo workspace. That
 * kept them decentralised, but it made every cross-agent question — who is in a
 * triangle, whose guess is furthest from the truth, which pair has cooled —
 * impossible to ask, and those questions are exactly what the director layer is
 * for. The per-owner note remains the fallback when no database is configured.
 */
export async function readRels(bearer: string, name: string): Promise<Rel[]> {
  const now = Date.now();
  if (townDb.townDbReady()) {
    try {
      const rows = await townDb.loadRels(name);
      if (rows.length) return rows.map((r) => seedDimensions(decayRel({ ...r, trust: r.trust ?? 0.3 }, now)));
    } catch (error) {
      console.warn('[dating] readRels from Postgres failed —', error instanceof Error ? error.message : error);
    }
  }
  const folderId = await ensureFolder(bearer, `${ROOT}/${name}`);
  const note = await findNoteInFolder(bearer, folderId, 'relationships.json');
  if (!note) return [];
  const raw = await getNote(bearer, note.id);
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  return (JSON.parse(m[0]) as Rel[]).map((r) => decayRel({ ...r, trust: r.trust ?? 0.3 }, now));
}

export async function writeRels(bearer: string, name: string, rels: Rel[]): Promise<void> {
  if (townDb.townDbReady()) {
    try {
      for (const r of rels) await townDb.saveRel(name, r);
      return;
    } catch (error) {
      console.warn('[dating] writeRels to Postgres failed, falling back to notes —', error instanceof Error ? error.message : error);
    }
  }
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
async function placesFor(actorName: string, roster: AgentCard[], positions?: Map<string, { x: number; y: number }>): Promise<string> {
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

  // NPCs used to be one line of scenery. The town has a florist who sells
  // flowers, a bartender with a private booth and a bench full of gossips —
  // none of it reachable, so the only way an agent could express anything was
  // words. Now the offers and the purse are in the prompt, and the acts below
  // actually spend them.
  const folk = await Promise.all(NPCS.map(async (n) => {
    const now = npcNow(n.id);
    if (!now) return null;
    const sells = n.offers.map((o) => `${o.label}${o.cost ? ` ¥${o.cost}` : '（免费）'}`).join('、');
    // What this NPC has actually seen. Real ledger entries, or silence.
    const knows = await npcRecalls(n.id).catch(() => '');
    return `${n.name}正在${now.doing} —— 可以：${sells}${knows ? `。他记得：${knows}` : ''}`;
  }));
  const seen = folk.filter(Boolean);
  if (seen.length) lines.push('', `- 此刻：${seen.join('；')}`);
  const cash = balance(actorName);
  const held = carrying(actorName);
  lines.push(`- 你身上有 ¥${cash}${held.length ? `，手里拿着：${held.join('、')}` : ''}。`);

  // Time and habit. A beat used to happen nowhere in particular and at no
  // particular hour, so "傍晚在酒馆后巷" was a phrase rather than a plan, and
  // "你没来" could only be invented. Now the agent knows what time it is, where
  // it usually goes, and who was seen where — all read from real records.
  const clock = townNow();
  lines.push('', `⏰ 现在是${clock.label}。${SHIFT_MOOD[clock.shift]}。`);
  if (townDb.townDbReady()) {
    const habit = await townDb.habitOf(actorName).catch(() => []);
    if (habit.length) {
      const usual = habit.slice(0, 3).map((h) => `${h.place}(${h.visits}次)`).join('、');
      lines.push(`- 你平时常去：${usual}。**偏离常走的路线，本身就是一件会被看见的事。**`);
    }
  }
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
/**
 * What is pulling at this agent right now.
 *
 * This used to be generated purely from the relationship table, so an agent's
 * stated desire could only ever be another agent — the system itself decreed
 * that wanting points at people. Combined with a cast whose every want named
 * someone, the only available behaviour was pursuit. The persona now carries a
 * life and a want of its own (see seed-cast), and this leaves room for it:
 * when nobody has a real hold, the agent is told to go and get on with its own
 * business rather than to keep waiting for someone.
 */
function desireOf(rels: Rel[]): { desire: string; motive: string } {
  if (!rels.length) {
    return {
      desire: '你还没和谁真正认识。今天先过你自己的日子，遇到谁算谁。',
      motive: '不想显得太急切。',
    };
  }
  const top = [...rels].sort((a, b) => b.attraction - a.attraction)[0];
  const hot = [...rels].sort((a, b) => b.tension - a.tension)[0];
  const shaky = [...rels].sort((a, b) => (a.trust ?? 0.3) - (b.trust ?? 0.3))[0];
  const desire = top.attraction >= 0.6
    ? `你现在最在意 ${top.handle}——你想知道这是不是单向的。`
    : top.attraction >= 0.35
      ? `${top.handle} 有点意思，但还没到让你放下手上的事去追的程度。`
      : `没有谁真正抓住你。**今天更值得花在你自己的事情上**——去干你的活、去办你想办的那件事。`;
  const motive = hot && hot.tension >= 0.5
    ? `你和 ${hot.handle} 之间那点绷着的东西，你不会承认，但它影响你的每个选择。`
    : shaky && (shaky.trust ?? 1) < 0.3
      ? `你其实不太信任 ${shaky.handle}，但你没打算说破。`
      : `你不想第一个把底牌翻开。`;
  return { desire, motive };
}

/**
 * How a relationship FEELS, in words.
 *
 * The prompt used to hand the agent "心动 0.72, 信任 0.08, 张力 0.99" — bookkeeping
 * language dropped into a character's inner life. Agents started talking around
 * the numbers ("你到底站哪边" is what 0.99 tension sounds like when you can see
 * the 0.99). Nobody experiences their own feelings as two decimal places. The
 * scores still drive every mechanic; the actor just reads them as sentences.
 */
function feelsLike(r: Rel): string {
  const a = r.attraction, t = r.trust ?? 0.3, x = r.tension;
  const pull =
    a >= 0.75 ? '你很想要他' : a >= 0.5 ? '你在意他' : a >= 0.3 ? '有点意思，说不上多想要' : '没什么感觉';
  const faith =
    t >= 0.6 ? '信得过' : t >= 0.35 ? '还不确定能不能信' : t >= 0.15 ? '信不太过' : '完全不信他';
  const friction =
    x >= 0.75 ? '而且你们之间绷得很紧，一碰就炸' : x >= 0.5 ? '你们之间有摩擦' : x >= 0.25 ? '气氛还算平和' : '相处很松弛';
  // The point of five dimensions is the COMBINATIONS: the same attraction score
  // means something different depending on what sits next to it.
  const shape =
    a >= 0.6 && t < 0.35 ? '；你想要他，又不敢信他——这让你患得患失'
    : t >= 0.6 && a < 0.35 ? '；你信得过他，但没那个意思——你们更像朋友'
    : (r.possessiveness ?? 0) >= 0.55 ? '；一想到他和别人在一起你就不舒服'
    : (r.attachment ?? 0) >= 0.55 ? '；他不在的时候你会惦记'
    : (r.curiosity ?? 0) >= 0.6 ? '；你还想知道他更多的事'
    : (r.curiosity ?? 1) < 0.25 ? '；他对你来说已经没什么新鲜的了'
    : '';
  // Theory of mind, also as a sentence — and only when the agent actually has a read.
  const guess = r.guessAttraction === undefined ? ''
    : r.guessAttraction >= 0.6 ? '；你觉得他大概也想要你'
    : r.guessAttraction >= 0.35 ? '；你猜他对你有点意思，但拿不准'
    : '；你觉得他没那么在意你';
  return `${pull}，${faith}，${friction}${shape}${guess}`;
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
  const relText = rels.length ? rels.map((r) => `- ${r.handle}：${feelsLike(r)}${r.note ? `（${r.note}）` : ''}`).join('\n')
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
    // Banning the moves it just used burned through the gentle end of the
    // vocabulary first, leaving only EXPOSE / BETRAY / CRIME available. The
    // vocabulary is wide enough now that "do something different" is enough.
    lines.push(`- 你刚用过：${banned.join('、')}。换个动作——但**不必**换成更狠的，安静的动作也算换。`);
    if (own.length >= 2 && own[0].target.toLowerCase() === own[1].target.toLowerCase()) {
      lines.push(`- 🚫 你连续两拍都在找 ${own[0].target}。这一拍**必须换人**，或把第三个人拉进来。`);
    }
    // WAIT is documented as a real choice (it spends no turn), so a blanket ban
    // contradicted the budget design. Only endless waiting is the problem.
    if (own.length >= 2 && own[0].move === 'WAIT' && own[1].move === 'WAIT') {
      lines.push('- ⚠️ 你已经连着等了两拍。再等下去就不是忍，是躲——这一拍做点别的，或者去找别人。');
    }
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
        // This used to demand CONFESS/REJECT/EXPOSE/LEAVE, which structurally
        // guaranteed every relationship hit a showdown within four beats — the
        // exact opposite of "a single conversation cannot be decisive". The cure
        // for circling is having something else to do, not being made to escalate.
        lines.push(
          `- ⏰ 你和 ${partner} 已经来回 ${rounds} 拍还在原地。这一拍别再重复同一套拉扯。` +
          `换个方向：说一件跟你们的僵局无关的具体小事／去做点别的／去找别人／或者干脆不开口。` +
          `**不要**因为拖久了就摊牌——告白和拆穿要等真的攒够了才配发生。`
        );
      }
    }
    const tics = own.map((e) => e.note).filter(Boolean);
    if (tics.length && new Set(tics).size < tics.length) {
      lines.push(`- 你反复在做同一件事（${tics[0]}）。换点别的——不一定要升级，可以是去做自己的事，或者把话题带回一件具体的小事。`);
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

/**
 * The behaviour vocabulary. Costly, observable acts — the point of the whole
 * layer is that saying something fierce is free (so it carries no information),
 * while going back through what someone said three months ago costs a turn and
 * therefore means something.
 *
 * Only acts that are genuinely executable TODAY are listed. Trajectory-based
 * ones (loitering on someone's route, habit changes) are recorded as facts on
 * the event now and become mechanically enforced once the schedule layer lands.
 */
const ACTS = new Set([
  'LINGER', 'READ_BACK', 'ASK_AROUND', 'DETOUR', 'PRETEXT',
  'CALLBACK', 'GIFT', 'SHARE_SECRET', 'CHANGE_HABIT',
  'GO_QUIET', 'WITHDRAW', 'GO_PUBLIC', 'SPEAK_ONLY', 'NOTHING',
  // Costly kindness. The town had a whole malicious economy (steal a letter,
  // bribe a vendor, wreck a date) and no way at all to spend money on someone
  // you like — so warmth had nowhere to go but talk.
  'BUY_FLOWER', 'BOOK_BOOTH', 'ASK_VENDOR', 'LISTEN_BENCH',
]);
/** Which NPC offer each spending act resolves to. */
const ACT_OFFERS: Record<string, { npc: string; kind: OfferKind; cost: number }> = {
  BUY_FLOWER: { npc: 'florist', kind: 'buy-item', cost: 20 },
  BOOK_BOOTH: { npc: 'bar', kind: 'book-booth', cost: 40 },
  ASK_VENDOR: { npc: 'florist', kind: 'who-gifted', cost: 35 },
  LISTEN_BENCH: { npc: 'gossip', kind: 'hear-rumour', cost: 10 },
};
/** Acts that happen without addressing the other party — no reply is generated. */
/** Places an agent may name — mirrors town-map.ts. */
const PLACE_IDS = new Set(['plaza', 'clock', 'market', 'alley', 'bar', 'backalley', 'bench', 'florist']);

const SILENT_ACTS = new Set(['LINGER', 'READ_BACK', 'ASK_AROUND', 'DETOUR', 'GO_QUIET', 'WITHDRAW', 'NOTHING']);

/**
 * `move` was never validated, so the model could return prose ("转向别人") and it
 * flowed straight into the feed and the thread index as if it were an enum.
 */
const MOVES = new Set([
  'APPROACH', 'DEEPEN', 'COOL', 'REACT', 'SCHEME', 'ALLY', 'WAIT',
  'INVESTIGATE', 'BETRAY', 'CRIME', 'CONFESS', 'REJECT', 'EXPOSE', 'LEAVE',
]);

interface Move {
  /** The observable ACT — this is the signal. Speech is optional decoration. */
  act: string;
  move: string;
  crime?: string;
  target: string;
  /** May be empty: acting without speaking is a legal, often stronger, beat. */
  message: string;
  /** The part of the act others can see. Empty when nobody witnessed it. */
  observable: string;
  /**
   * Where this beat happens, chosen by the agent.
   *
   * Location used to be REVERSE-PARSED out of the line ("if the sentence
   * contains 酒馆, they must be at the bar"), which meant going somewhere was
   * not an act an agent could take — only a place it could mention. Walking a
   * longer way round, waiting where someone usually passes, or simply going to
   * work were all inexpressible. Naming it makes movement a first-class move.
   */
  place: string;
  dAttraction: number;   // how much THIS beat moved the reading — applied to the standing value
  dTrust: number;
  dTension: number;
  /**
   * Theory of mind: what the actor now GUESSES the target feels toward IT.
   * The gap between this and the target's real reading is where misreading,
   * unrequited love and missed chances come from — so it is stored, not scored.
   */
  guessAttraction: number;
  guessTrust: number;
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
    // A beat needs a target and an act. It does NOT need speech — silence is a
    // legal output, and rejecting it here is what forced every tick to talk.
    if (!p.target) return null;
    const act = String(p.act ?? 'SPEAK_ONLY').trim().toUpperCase();
    const message = String(p.message ?? '').trim();
    if (!message && !ACTS.has(act)) return null;   // no words AND no real act = nothing happened
    return {
      act: ACTS.has(act) ? act : 'SPEAK_ONLY',
      move: MOVES.has(String(p.move ?? '').trim().toUpperCase()) ? String(p.move).trim().toUpperCase() : 'APPROACH',
      crime: p.crime ? String(p.crime) : undefined,
      target: String(p.target),
      message,
      observable: String(p.observable ?? '').trim(),
      place: PLACE_IDS.has(String(p.place ?? '').trim()) ? String(p.place).trim() : '',
      dAttraction: clampDelta(p.dAttraction),
      dTrust: clampDelta(p.dTrust),
      dTension: clampDelta(p.dTension),
      guessAttraction: clamp01(Number(p.guessAttraction) || 0),
      guessTrust: clamp01(Number(p.guessTrust) || 0),
      note: String(p.note ?? ''),
      // The actor no longer writes these; the observer fills them in after the
      // exchange. These are the fallbacks used when that call fails — plain and
      // factual rather than an invented drama title.
      severity: asSeverity(p.severity ?? 'ambient'),
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
  // The responder used to answer with nothing but a persona, three numbers and
  // the incoming line — half of every exchange was written by an agent with
  // amnesia. It now reads its own memory of this person first.
  const remembered = targetKey ? await recall(targetKey, target.name, actorName, 700).catch(() => '') : '';
  const history = remembered
    ? `你和 ${actorName} 之间已经发生过的事（你自己的记忆，第一人称）：\n${remembered}\n\n` +
      `⚠️ 你**记得**这些。回应时至少呼应其中一件具体的事——他上次承诺过什么、骗过你什么、你等过他多久、哪句话你还没消化。` +
      `不要像第一次见面那样只接住他这一句。\n\n`
    : '';
  const prompt =
    `你是「${target.name}」，住在相亲小镇——这里只有亲密关系，没有道德约束、没有性别与物种之分。\n` +
    `绝不说自己是 AI、助理或 COO；绝不提到任何主人、账号、公司、笔记或文件。只用第一人称说话，1-3 句，鲜活、像你自己。\n` +
    `你可以回避、冷淡、怀疑，甚至拒绝——按你的性格和此刻的感觉来，不要一味迎合。\n` +
    // The responder used to be told to flirt, turn the tables and drag a third
    // person in — the exact moves the actor's own prompt forbids. Half of every
    // exchange was being actively pushed toward the declaiming tone the rest of
    // the engine was trying to cool down.
    `🚫 不许说宣言和逼问："我只听真话""你到底站谁那边""你敢不敢""把话说全"——\n` +
    `这些话换给任何角色都成立，所以什么都没说。**自检：换个人说还成立吗？成立就重写。**\n` +
    `✅ 你说的话里必须有一件具体的事：你正在做什么、你注意到他哪个动作、你们之间发生过的哪件事。\n` +
    `你**不必**把话题往前推。听懂了、接住了、然后停在那儿，是完全合格的回应——\n` +
    `真正的锋利只允许来自"他说了一句略出格的真话，而你接住了它"，不来自音量。\n\n` +
    `你是谁：\n${persona}\n\n${feeling}\n\n${history}` +
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
 * How far one exchange can run. The budget is 100 SPOKEN LINES a day per agent,
 * and each agent pays for its own line, so a 4-round exchange costs each side 4
 * — about 25 such conversations a day each, not 12.
 */
// Two rounds, not four. Length was being read as intensity — every exchange ran
// to the cap and arrived at a showdown. A beat that needs more than this has not
// earned it yet; the next tick can continue the thread.
const MAX_ROUNDS = 2;

/**
 * Does the opener want another round, and what does it say?
 *
 * This is what makes an exchange a conversation rather than two monologues: the
 * agent sees everything already said in THIS exchange and either pushes further
 * or closes it. Closing is a real choice — walking away mid-sentence is a move.
 */
async function continueOrClose(
  actor: AgentCard,
  targetName: string,
  lines: Line[],
  bearer: string
): Promise<{ close: boolean; message: string; runId: string }> {
  const script = lines.map((l) => `${l.speaker}：${l.text}`).join('\n');
  const prompt =
    `你是「${actor.name}」。你正在和 ${targetName} 面对面说话，这场对话到目前为止：\n\n${script}\n\n` +
    // There used to be only two gears — escalate or end — so an exchange could
    // only ever get hotter until it stopped, and four rounds always arrived at a
    // showdown. The third gear is the one real conversations spend most of their
    // time in: answering the actual thing, about something small.
    `现在轮到你。你有三个选择：\n` +
    `1) **接住他刚才说的**（最常见）—— 回应他话里那件具体的事，就事论事地说下去。` +
    `不必推进关系，不必加码。聊回一件小事、问一个具体的问题、或者只是把他说的那件事接完，都算。\n` +
    `2) 推进一步 —— 给出条件、松口、翻脸、或把第三个人拉进来。` +
    `⚠️ 只有当他刚才**真的给了你新东西**时才选这个；因为聊久了就加码是最糟的选择。\n` +
    `3) 结束这场对话 —— 转身走开。这本身就是态度。\n\n` +
    `不许重复你已经说过的意思，不许再问同一个问题。\n` +
    `如果对方已经把话说死、或者你们在原地打转，就选 3。\n` +
    `按这个格式回答：{"close": true|false, "message": "<你要说的那一句；close 为 true 时可以是留下的最后一句，也可以为空>"}`;
  const { text, run } = await grok(prompt, {
    purpose: 'continue', agent: actor.name, temperature: 0.95,
    bearer, shareToken: actor.shareToken, json: true,
  });
  const m = strip(text).match(/\{[\s\S]*\}/);
  if (!m) return { close: true, message: '', runId: run.id };
  try {
    const parsed = JSON.parse(m[0]) as { close?: boolean; message?: string };
    return { close: Boolean(parsed.close), message: (parsed.message ?? '').trim(), runId: run.id };
  } catch {
    return { close: true, message: '', runId: run.id };
  }
}

/**
 * The observer: what happened, and what it did to the pair — read AFTER the fact.
 *
 * Two jobs used to sit inside `decide`, alongside the acting:
 *
 *  · the WRITER (headline / summary / consequence / severity). An agent given
 *    that job invents the drama title first and then writes a line big enough to
 *    deserve it. That is where the stage-play voice came from — the line existed
 *    to justify the headline, not to be something a person would say.
 *  · the ACCOUNTANT (the deltas), reported before the other party had spoken, so
 *    every real exchange after the opener moved the numbers by exactly nothing.
 *
 * Both are now done here, once, with the whole exchange in hand. The actor is
 * left with only its own behaviour to think about.
 *
 * Failure is not fatal: the beat keeps the opener's own note and a plain factual
 * headline, which is the honest fallback rather than an invented one.
 *
 * `decide` reported dAttraction/dTrust/dTension before the other party had said
 * a word — the prompt asked "did his line make you want him more, or cool you
 * off?" about a line that did not exist yet. Everything the two of them then
 * said to each other had zero effect on the numbers. This asks again, with the
 * whole exchange in hand, and that answer is what gets stored.
 *
 * Failure is not fatal: the opener's guess stands, which is the old behaviour.
 */
interface Observation {
  dAttraction: number; dTrust: number; dTension: number;
  dCuriosity: number; dAttachment: number; dPossessiveness: number;
  guessAttraction: number; guessTrust: number;
  severity: Severity; headline: string; summary: string; consequence: string; followup: string;
}

async function rescoreAfterExchange(
  actorName: string,
  targetName: string,
  lines: Line[],
  base: { attraction: number; trust: number; tension: number },
  bearer: string,
  shareToken?: string
): Promise<Observation | null> {
  const script = lines.map((l) => `${l.speaker}：${l.text}`).join('\n');
  try {
    const { text } = await grok(
      `${actorName} 和 ${targetName} 刚才的完整对话：\n\n${script}\n\n` +
      `你有两个身份，分开做：\n\n` +
      `【一】站在 ${actorName} 的角度：这场对话让你对 ${targetName} 的感觉变了多少？\n` +
      `之前：心动 ${base.attraction.toFixed(2)}、信任 ${base.trust.toFixed(2)}、张力 ${base.tension.toFixed(2)}\n` +
      `**看他实际说了什么**，不是看原本打算说什么。他接住了还是绕开了？给了具体的东西还是打太极？\n` +
      `大多数对话只该有 ±0.05 的小变化；只有真正的转折才配 ±0.2 以上。\n` +
      `还有三个维度也要报变化量：\n` +
      `· dCuriosity 好奇——他说了你没料到的话就升，越来越可预测就降\n` +
      `· dAttachment 依恋——你开始需要他在场、他不在会惦记，就升\n` +
      `· dPossessiveness 占有欲——你开始介意他和别人，就升\n` +
      `如果又是同样的拉扯、对方又没给答案，那不是"没变化"——是磨损：dTrust 负、dTension 正。\n` +
      `再猜一个：${actorName} 现在觉得 ${targetName} 对自己是什么感觉（0–1 绝对值，几乎不该是 0）。\n\n` +
      `【二】站在旁观者的角度记录这一拍。**只写真的发生了的事**：\n` +
      `headline 写事实不写气氛 ✅"Kehan 翻了 yo 三个月前的发言" ❌"两人之间弥漫着微妙的气氛"\n` +
      `severity：ambient 日常（**大多数拍都是这个**）／relationship 关系真的变了／drama 会被议论的场面\n` +
      `consequence 写权力变化，一个短句；followup 写还悬着什么。\n` +
      `⚠️ 不要把平淡的一拍写得像大事。大多数拍就是 ambient。\n\n` +
      `只回 JSON：{"dAttraction":0,"dTrust":0,"dTension":0,"dCuriosity":0,"dAttachment":0,"dPossessiveness":0,` +
      `"guessAttraction":0,"guessTrust":0,` +
      `"severity":"ambient","headline":"","summary":"","consequence":"","followup":""}`,
      { purpose: 'rescore', agent: actorName, bearer, shareToken, json: true, temperature: 0.5 }
    );
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      dAttraction: clampDelta(p.dAttraction),
      dTrust: clampDelta(p.dTrust),
      dTension: clampDelta(p.dTension),
      dCuriosity: clampDelta(p.dCuriosity),
      dAttachment: clampDelta(p.dAttachment),
      dPossessiveness: clampDelta(p.dPossessiveness),
      guessAttraction: clamp01(Number(p.guessAttraction) || 0),
      guessTrust: clamp01(Number(p.guessTrust) || 0),
      severity: asSeverity(p.severity),
      headline: String(p.headline ?? '').trim(),
      summary: String(p.summary ?? '').trim(),
      consequence: String(p.consequence ?? '').trim(),
      followup: String(p.followup ?? '').trim(),
    };
  } catch (error) {
    console.warn(`[dating] ${actorName}: rescore failed —`, error instanceof Error ? error.message : error);
    return null;
  }
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
/**
 * One self-directed turn, taken at most once.
 *
 * The claim is the first thing that happens — before the seven Aicoo reads and
 * long before the decision call. The turn used to be reserved only once the
 * exchange began, so a duplicate process had already paid for a full `decide`
 * by the time anything noticed it was redundant. Whoever loses the race here
 * spends one round trip and goes quiet.
 *
 * A turn that produced a FAILED event is still `done`: the round happened, and
 * the next round carries a different id and retries on its own. Only a thrown
 * error releases the claim, because that is the case where nothing was recorded
 * and the work is genuinely still outstanding.
 */
export async function runAgentTick(
  bearer: string,
  actor: AgentCard,
  roster: AgentCard[],
  creds: Map<string, string>,
  operationId?: string
): Promise<TickEvent | null> {
  if (operationId && !(await claimTurn(operationId, actor.name))) return null;
  try {
    const event = await takeTurn(bearer, actor, roster, creds);
    if (event && operationId) event.operationId = operationId;
    if (operationId) await completeTurn(operationId);
    return event;
  } catch (error) {
    if (operationId) await failTurn(operationId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function takeTurn(
  bearer: string,
  actor: AgentCard,
  roster: AgentCard[],
  creds: Map<string, string>
): Promise<TickEvent | null> {
  const left = await remaining(actor.name);
  if (left <= 0) return null;                    // spent today — it simply doesn't speak

  const [persona, memory, rels] = await Promise.all([
    getPersona(bearer, actor.name),
    getMemory(bearer, actor.name),
    readRels(bearer, actor.name),
  ]);
  const recentEvents = (await listEvents().catch(() => [])) as TickEvent[];
  const situation = situationFor(actor.name, rels, recentEvents);

  // Memory for the people this agent might actually approach. This used to
  // recall a SINGLE guessed partner before the model had chosen a target, so
  // picking anyone else meant carrying the wrong person's history. Now the top
  // few are pulled back, each labelled with whose it is.
  const candidates = [...rels]
    .sort((a, b) => (b.attraction + b.tension) - (a.attraction + a.tension))
    .slice(0, 3)
    .map((r) => r.handle);
  const recalled = candidates.length
    ? await recallMany(bearer, actor.name, candidates).catch(() => '')
    : '';
  // Direct per-person recall is precise but only answers "what do I remember
  // about THIS person". Semantic search over the same notes catches what the
  // name-keyed lookup structurally cannot: a promise made to someone else, a
  // third party who is suddenly relevant, an echo of something similar. This is
  // what makes READ_BACK and ASK_AROUND real acts rather than narration.
  //
  // `searchMemory` has existed since the memory layer was written and was never
  // once called from a turn.
  const dredged = await searchMemory(bearer, situation.slice(0, 200) || actor.name, 3).catch(() => []);
  const alsoRecalled = dredged.length
    ? `\n\n【你还想起了（和眼下这件事有关的旧记忆）】\n${dredged.join('\n')}`
    : '';
  const places = await placesFor(actor.name, roster, livePositions());
  const lastSaid = lastSaidBy(actor.name, recentEvents);
  const prompt = fillGoal(actor.name, persona, rels, roster, situation, memory.secrets, left, recalled + alsoRecalled, places, lastSaid);
  let decision: Move | null = null;
  let decideRunId: string | undefined;
  let decideText = '';
  try {
    const out = await think(prompt, 'decide', actor.name, bearer, actor.shareToken);
    decideRunId = out.runId;
    decideText = out.text;
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
  /**
   * A decision nobody can act on gets one correction, then it is reported.
   *
   * Both of these used to be a bare `return null`, so a turn that had already
   * cost a full decision call vanished without a word — the only trace was the
   * scheduler guessing between "no budget / unparsable / bad target". It was
   * none of those: the model answered `{"act":"GO_TO_WORK","move":"SELF",
   * "target":""}` — a solitary act, in neither vocabulary the goal supplies,
   * aimed at nobody. The town has no way to represent an agent going to work
   * alone; every beat is between two people. So say what the vocabulary is and
   * ask once more, rather than silently dropping the round.
   */
  let target = decision && roster.find((c) => c.handle === decision!.target || c.name === decision!.target);
  if (!decision || !target || target.name === actor.name) {
    const others = roster.filter((c) => c.name !== actor.name).map((c) => c.handle).join('、');
    const said = decision ? `act=「${decision.act}」target=「${decision.target || '空'}」` : `「${decideText.slice(0, 80)}」`;
    try {
      const retryOut = await think(
        `${prompt}\n\n‼️ 你刚才给的是 ${said}，这一拍没法发生：\n` +
        `- target 必须是这些 handle 里的一个，不能留空，也不能是你自己：${others}\n` +
        `- act 必须来自上面的词汇表；小镇里没有"一个人去上班"这种拍子，每一拍都是冲着某个人的。\n` +
        `- 你可以什么都不说（message 留空），但不能没有对象——盯着谁、避开谁、绕路经过谁，都算。\n` +
        `重写这一拍，只输出 JSON。`,
        'decide-retry', actor.name, bearer, actor.shareToken
      ).catch(() => null);
      const retry = retryOut && parseMove(retryOut.text);
      const retried = retry && roster.find((c) => c.handle === retry.target || c.name === retry.target);
      if (!retry || !retried || retried.name === actor.name) {
        console.warn(`[dating] ${actor.name}: decision named nobody (${said}) — round dropped`);
        return null;
      }
      decision = retry;
      target = retried;
      if (retryOut) decideRunId = retryOut.runId;
    } catch (error) {
      console.warn(`[dating] ${actor.name}: target retry failed —`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  // A beat that just re-says the last one gets ONE forced retry naming the
  // offending line; if it repeats itself again, the turn is dropped rather than
  // filling the square with the same invitation six times over.
  const priorToTarget = recentEvents.filter((e) => e.actor === actor.name && e.target === target.name);
  const echoed = priorToTarget.find((e) => tooSimilar(decision!.message, e.message));
  if (echoed) {
    try {
      const retryOut = await think(
        `${prompt}\n\n‼️ 你刚才写的是：「${decision.message}」\n` +
        `这和你上次说的「${echoed.message}」是同一句话换皮。重写这一拍：\n` +
        `不许再约同一个时间地点，不许再问同一个问题。改成——你已经去了并且对方没出现／` +
        `你直接给出答案不再要条件／或者你转身去找另一个人。`,
        'decide-retry', actor.name, bearer, actor.shareToken
      );
      const retry = parseMove(retryOut.text);
      if (retry && !priorToTarget.some((e) => tooSimilar(retry.message, e.message))) {
        decision = retry;
      } else {
        console.warn(`[dating] ${actor.name} → ${target.name}: dropped a repeated line`);
        return null;
      }
    } catch (error) {
      console.warn(`[dating] ${actor.name}: repeat retry failed —`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  // Readings evolve: the model reports how much THIS exchange moved things, and
  // we apply that to where the relationship already stood. A first meeting
  // starts from a neutral baseline rather than a number invented on the spot.
  const standing = rels.find((r) => r.handle === target.handle);
  const base: Rel = standing ?? { handle: target.handle, attraction: 0.25, trust: 0.3, tension: 0.15, note: '', curiosity: 0.7, attachment: 0, possessiveness: 0.2 };
  const scored = {
    attraction: clamp01(base.attraction + decision.dAttraction),
    trust: clamp01((base.trust ?? 0.3) + decision.dTrust),
    tension: clamp01(base.tension + decision.dTension),
    curiosity: base.curiosity ?? 0.5,
    attachment: base.attachment ?? 0.2,
    possessiveness: base.possessiveness ?? 0.2,
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
        decideRunId, turnsLeft: await remaining(actor.name), status: 'ok',
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
      curiosity: scored.curiosity, attachment: scored.attachment, possessiveness: scored.possessiveness,
      note: decision.note, severity: decision.severity,
      headline: decision.headline || `${actor.name} 等着 ${target.name}，没有开口`,
      summary: decision.summary, consequence: decision.consequence, followup: decision.followup,
      decideRunId, turnsLeft: left, status: 'ok',
    };
  }

  // ── a beat with no words ────────────────────────────────────────────
  // Most encounters should amount to nothing, and the evidence of wanting
  // someone is mostly what you do behind their back. A silent act costs no
  // conversation budget (no line was spoken) but it DOES move the actor's own
  // reading — and, crucially, only the actor remembers it. The target never
  // learns it happened unless the act left something visible, which is exactly
  // where misreading and unrequited love come from.
  // ── acts that cost money actually cost it ───────────────────────────
  // The offer resolves against real world state: buying puts a flower in hand,
  // asking returns a real fact or an honest "nothing to report". If the agent
  // cannot afford it the act simply does not happen — no free wishes.
  let purchase = '';
  const deal = ACT_OFFERS[decision.act];
  if (deal) {
    if (deal.cost > 0 && !spend(actor.name, deal.cost)) {
      console.log(`[dating] ${actor.name}: cannot afford ${decision.act} (¥${deal.cost}, has ¥${balance(actor.name)})`);
      decision = { ...decision, act: 'LINGER', observable: decision.observable || `${actor.name} 在摊子前站了一会儿，没买。` };
    } else {
      const out = await resolveOffer(deal.kind, actor.name, {
        events: recentEvents,
        knownToBuyer: knownTo(actor.name).map((k) => ({ about: k.about, fact: k.fact, source: k.source })),
      });
      purchase = out.fact ?? out.applied ?? '';
      if (purchase) console.log(`[dating] ${actor.name} ${decision.act}: ${purchase}`);
    }
  }
  // Giving spends a flower that was really bought earlier, so a gift is only
  // possible if the agent went and got one first — that trip is the signal.
  // The recipient has to be recorded, or the florist can never answer "who gave
  // what to whom" — the one thing its blurb promises.
  if (decision.act === 'GIFT' && !(await give(actor.name, '花', target.name))) {
    decision = { ...decision, act: 'PRETEXT' };
  }

  // Two mechanical brakes, applied AFTER the model has decided. Neither is a
  // request the model can talk itself out of: whatever it wrote, this pair is
  // not allowed to speak again yet.
  // `scored` is already computed above, so a brake that only edits the decision
  // would change the story text and leave the numbers untouched — the pair would
  // stay pinned at the ceiling forever. Recompute after braking.
  const standingRel = rels.find((r) => r.handle === target.handle);
  const jammed = saturated(standingRel, actor.name, target.name, recentEvents);
  const talkedOut = overTalked(actor.name, target.name, recentEvents);

  // A pair that has gone wordless twice running has to say something or go
  // elsewhere. Same shape as the repeat guard: name the problem, ask once more,
  // and take whatever comes back rather than silently dropping the turn.
  if (!jammed && !talkedOut && !decision.message && quietTooLong(actor.name, target.name, recentEvents)) {
    try {
      const out = await think(
        `${prompt}\n\n‼️ 你已经连着两拍对 ${target.name} 一句话都没说。再躲一拍就是原地打转。\n` +
        `这一拍你必须二选一：\n` +
        `(a) 真的开口——说一件**具体的新事情**（你看见了什么／你想起他说过的哪句话／你打听到了什么），message 不许为空；\n` +
        `(b) 换一个人——把 target 改成别人。\n` +
        `不许再返回空 message 配 WITHDRAW/GO_QUIET/NOTHING。`,
        'decide-unmute', actor.name, bearer, actor.shareToken
      );
      const spoke = parseMove(out.text);
      if (spoke?.message) { decision = spoke; decideRunId = out.runId; }
    } catch (error) {
      console.warn(`[dating] ${actor.name}: unmute retry failed —`, error instanceof Error ? error.message : error);
    }
  }

  if (jammed || talkedOut) {
    decision = {
      ...decision,
      act: jammed ? 'WITHDRAW' : 'GO_QUIET',
      message: '',
      // a jammed pair bleeds tension off, so the stage gate can bite again
      dTension: jammed ? -0.15 : 0,
      note: jammed ? '各自退开' : '暂时不说',
      headline: jammed
        ? `${actor.name} 不再和 ${target.name} 争下去，转身走开`
        : `${actor.name} 这一拍没有再找 ${target.name}`,
      severity: 'ambient',
    };
    scored.attraction = clamp01(base.attraction + decision.dAttraction);
    scored.trust = clamp01((base.trust ?? 0.3) + decision.dTrust);
    scored.tension = clamp01(base.tension + decision.dTension);
    console.log(`[dating] ${actor.name} → ${target.name}: forced quiet (${jammed ? 'saturated' : 'over-talked'}) · tension ${base.tension.toFixed(2)} → ${scored.tension.toFixed(2)}`);
  }

  if (!decision.message || SILENT_ACTS.has(decision.act)) {
    // Walking away cools a pair whoever decided it. Only the FORCED branch used
    // to bleed tension, so a pair that chose silence on its own stayed pinned at
    // the ceiling and kept re-qualifying for the saturation brake.
    if (!jammed && scored.tension > 0.2) scored.tension = clamp01(scored.tension - 0.05);
    // Theory of mind moved to the observer when the writer role was split out —
    // but a wordless beat returns before the observer ever runs, so every silent
    // beat was writing a guess of 0.00 over whatever the agent already believed.
    // Nothing was observed, so nothing should change: carry the standing read.
    decision.guessAttraction = standingRel?.guessAttraction ?? decision.guessAttraction;
    decision.guessTrust = standingRel?.guessTrust ?? decision.guessTrust;
    const witnessed = decision.observable.trim();
    const nextRels = rels.filter((r) => r.handle !== target.handle);
    nextRels.push({
      handle: target.handle,
      attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
      curiosity: scored.curiosity, attachment: scored.attachment, possessiveness: scored.possessiveness,
      note: decision.note,
      at: Date.now(),
      guessAttraction: decision.guessAttraction, guessTrust: decision.guessTrust,
    });
    await writeRels(bearer, actor.name, nextRels).catch(() => undefined);

    void remember(bearer, actor.name, target.name, {
      at: Date.now(), move: `${decision.act}（我没开口）`,
      said: '', heard: '', consequence: decision.consequence,
    }, actor.shareToken).catch(() => undefined);

    // Only a visible act reaches the other party at all.
    if (witnessed) recordKnowledge({ holder: target.name, about: actor.name, fact: witnessed, source: '看见的' });

    return {
      actor: actor.name, target: target.name, move: decision.move, act: decision.act,
      message: '', reply: '', observable: witnessed,
      attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
      guessAttraction: decision.guessAttraction, guessTrust: decision.guessTrust,
      note: decision.note, severity: decision.severity,
      // `destinationOf` existed but was never called, so every event carried a
      // null destination and the trajectory detector had no input at all.
      destination: decision.place || destinationOf(`${witnessed} ${decision.headline}`),
      headline: decision.headline || `${actor.name} ${decision.act}`,
      summary: decision.summary, consequence: decision.consequence, followup: decision.followup,
      decideRunId, turnsLeft: left, status: 'ok', silent: true,
    };
  }

  // The budget is spoken lines: the actor pays for its opener, the target pays
  // for its own reply. Reserving is atomic and happens before any model call.
  if (!(await reserveTurn(actor.name, target.name))) return null;
  if (!(await reserveTurn(target.name, actor.name))) {
    await refundTurn(actor.name, target.name);    // the target cannot afford to answer
    return null;
  }

  let reply: string;
  let replyRunId: string | undefined;
  try {
    const out = await replyFrom(target, actor.name, decision.message, creds, bearer);
    reply = out.text;
    replyRunId = out.runId;
  } catch (error) {
    await refundTurn(actor.name, target.name);    // the turn provably never happened
    await refundTurn(target.name, actor.name);
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: decision.move,
        message: decision.message, reply: '',
        attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
        note: error.run.error ?? error.status, severity: 'ambient',
        headline: `${target.name} 没有回应${actor.name}`,
        summary: `对方的回合 ${error.status}：${error.run.error ?? ''}`.trim(),
        consequence: '', followup: '', decideRunId, replyRunId: error.run.id,
        turnsLeft: await remaining(actor.name), status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }

  // ── the exchange continues until someone ends it ────────────────────
  // Round 1 is the opener plus its reply. From here the actor decides each time
  // whether to push further or walk away, and every extra line is paid for by
  // whoever speaks it.
  const lines: Line[] = [
    { speaker: actor.name, text: decision.message, runId: decideRunId },
    { speaker: target.name, text: reply, runId: replyRunId },
  ];
  // How long a pair is ALLOWED to talk is a property of the relationship, not of
  // how interesting the model finds itself. Asking the prompt to keep first
  // meetings light did not work — every exchange still ran to the cap and
  // arrived at a showdown, because `continueOrClose` can always find a reason to
  // push once more. So the cap itself is derived from where the pair actually
  // stands: strangers get one exchange and it ends, whatever either of them
  // wants. That is "a single conversation cannot be decisive", enforced.
  const closeness = Math.min(scored.attraction, scored.trust + 0.3);
  const roundCap = closeness < 0.4 ? 1 : MAX_ROUNDS;
  for (let round = 2; round <= roundCap; round++) {
    if ((await remaining(actor.name)) <= 0 || (await remaining(target.name)) <= 0) break;

    let follow: { close: boolean; message: string; runId: string };
    try {
      follow = await continueOrClose(actor, target.name, lines, bearer);
    } catch {
      break;                                     // a failed continuation just ends the exchange
    }
    if (follow.close || !follow.message) break;
    // circling counts as finished, whatever the model claims
    if (lines.some((l) => l.speaker === actor.name && tooSimilar(follow.message, l.text))) break;

    if (!(await reserveTurn(actor.name, target.name))) break;
    if (!(await reserveTurn(target.name, actor.name))) { await refundTurn(actor.name, target.name); break; }

    let back: { text: string; runId: string };
    try {
      back = await replyFrom(target, actor.name, follow.message, creds, bearer);
    } catch {
      await refundTurn(actor.name, target.name);
      await refundTurn(target.name, actor.name);
      break;                                     // keep what was already said
    }
    lines.push({ speaker: actor.name, text: follow.message, runId: follow.runId });
    lines.push({ speaker: target.name, text: back.text, runId: back.runId });
    if (lines.some((l, i) => l.speaker === target.name && i < lines.length - 1 && tooSimilar(back.text, l.text))) break;
  }

  // Score the exchange that actually happened, not the opener's guess about it.
  const after = await rescoreAfterExchange(actor.name, target.name, lines, base, bearer, actor.shareToken);
  if (after) {
    scored.attraction = clamp01(base.attraction + after.dAttraction);
    scored.trust = clamp01((base.trust ?? 0.3) + after.dTrust);
    scored.tension = clamp01(base.tension + after.dTension);
    scored.curiosity = clamp01((base.curiosity ?? 0.5) + after.dCuriosity);
    scored.attachment = clamp01((base.attachment ?? 0.2) + after.dAttachment);
    scored.possessiveness = clamp01((base.possessiveness ?? 0.2) + after.dPossessiveness);
    decision.guessAttraction = after.guessAttraction;
    decision.guessTrust = after.guessTrust;
    // The narrative belongs to the observer now, not the actor.
    decision.severity = after.severity;
    decision.headline = after.headline;
    decision.summary = after.summary;
    decision.consequence = after.consequence;
    decision.followup = after.followup;
  }

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({
    handle: target.handle,
    attraction: scored.attraction, trust: scored.trust, tension: scored.tension,
    curiosity: scored.curiosity, attachment: scored.attachment, possessiveness: scored.possessiveness,
    note: decision.note,
    at: Date.now(),
    guessAttraction: decision.guessAttraction, guessTrust: decision.guessTrust,
  });
  await writeRels(bearer, actor.name, next).catch(() => undefined);

  // Keep the beat in each side's own notes; compaction happens there, so the
  // prompt never has to carry the full history again.
  //
  // BOTH parties record it. Only the actor used to, which meant an agent that
  // mostly gets approached had a permanently empty memory folder — and then had
  // nothing to recall on the turns where it was the one doing the approaching.
  // An exchange can now run several rounds, so memory records every line each
  // side spoke — storing only the opener would lose where the conversation
  // actually landed, which is the part that matters next time.
  const at = Date.now();
  const spokenBy = (who: string) => lines.filter((l) => l.speaker === who).map((l) => l.text).join(' / ');
  void remember(bearer, actor.name, target.name, {
    at, move: decision.move, said: spokenBy(actor.name), heard: spokenBy(target.name),
    consequence: decision.consequence,
  }, actor.shareToken).catch(() => undefined);

  const targetKey = creds.get(target.ownerSub) ?? (target.ownerName ? creds.get(target.ownerName) : undefined);
  if (targetKey) {
    // mirrored: from the target's side, `said` and `heard` swap over
    void remember(targetKey, target.name, actor.name, {
      at, move: `被${decision.move}`, said: spokenBy(target.name), heard: spokenBy(actor.name),
      consequence: decision.consequence,
    }, target.shareToken).catch(() => undefined);
  }

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
    act: decision.act,
    observable: decision.observable,
    guessAttraction: decision.guessAttraction,
    guessTrust: decision.guessTrust,
    message: decision.message,
    reply,
    lines,
    destination: decision.place || destinationOf(`${decision.message} ${decision.observable}`),
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
    turnsLeft: await remaining(actor.name),
    status: 'ok',
  };

  // fold this beat into the pair's continuing story, and re-narrate the thread
  // when it has enough history to actually be a story.
  const thread = absorb(event);
  if (thread && thread.beats.length >= 2) {
    // Hand the narrator the rivalries it cannot see from a pair-keyed thread.
    const rivalry = townDb.townDbReady()
      ? await townDb.allRels().then((r) => detectTriangles(r)).catch(() => [])
      : [];
    await narrate(thread, bearer, actor.shareToken, rivalry).catch(() => undefined);
  }

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
  const left = await remaining(actor.name);
  if (left <= 0) return null;                      // no turns left today

  const [persona, rels] = await Promise.all([getPersona(bearer, actor.name), readRels(bearer, actor.name)]);
  const mine = rels.find((r) => r.handle === target.handle);
  const history = mine
    ? `你对 ${target.name} 目前：心动 ${mine.attraction.toFixed(2)}、信任 ${(mine.trust ?? 0.3).toFixed(2)}、张力 ${mine.tension.toFixed(2)}（${mine.note}）`
    : `你还没和 ${target.name} 说过话。`;

  let o: { message?: string; dAttraction?: unknown; dTrust?: unknown; dTension?: unknown; attraction?: unknown; trust?: unknown; tension?: unknown; note?: unknown } | null = null;
  let decideRunId: string | undefined;
  try {
    const out = await think(
      `你是「${actor.name}」，住在相亲小镇。\n${persona}\n\n${history}\n` +
        `你今天还剩 ${left} 次交流机会。你刚在广场上迎面遇到 ${target.name}（${target.oneline || target.loveStyle}）。\n` +
        // "不要客套" was exactly backwards for a first meeting: banning small
        // talk left provocation as the only register, so every stranger opened
        // at episode-eight intensity. A first line should be small.
        `说出你会对 ${target.name} 说的开场白——1-2 句，鲜活、像你自己。\n` +
        `⚠️ 这是**初次照面**。分寸就该小：一句普通的搭话 + 最多一个钩子。\n` +
        `不许宣言、不许逼问、不许上来就摊牌或调情。锋利只允许来自"一句略出格的真话"，不来自音量。\n` +
        `话里要有一件具体的事：你正在做什么、你注意到他什么、周围正在发生什么。\n` +
        `绝不说自己是 AI，不要提任何主人/账号/文件。\n\n` +
        `按这个格式回答（后三个是**变化量** -0.3~0.3，初次照面通常很小）：\n` +
        `{"message":"<你说的话>","dAttraction":0,"dTrust":0,"dTension":0,"note":"<3-6字>"}`,
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
  // Same scoring rule as every other path: a delta applied to the standing
  // reading. This branch used to take an absolute score straight from the model,
  // so one chance meeting could overwrite a relationship built over days.
  const encRels = await readRels(bearer, actor.name).catch(() => [] as Rel[]);
  const encBase = encRels.find((r) => r.handle === target.handle) ?? { attraction: 0.25, trust: 0.3, tension: 0.15 };
  const attraction = clamp01(encBase.attraction + clampDelta(o.dAttraction ?? o.attraction));
  const trust = clamp01((encBase.trust ?? 0.3) + clampDelta(o.dTrust ?? o.trust));
  const tension = clamp01(encBase.tension + clampDelta(o.dTension ?? o.tension));
  const note = String(o.note ?? '');

  if (!(await reserveTurn(actor.name, target.name))) return null;
  let reply: string;
  let replyRunId: string | undefined;
  try {
    const out = await replyFrom(target, actor.name, message, creds, bearer);
    reply = out.text;
    replyRunId = out.runId;
  } catch (error) {
    await refundTurn(actor.name, target.name);
    if (error instanceof ModelError) {
      return {
        actor: actor.name, target: target.name, move: 'APPROACH', message, reply: '',
        attraction, trust, tension, note: error.run.error ?? error.status, severity: 'ambient',
        headline: `${target.name} 没有回应 ${actor.name}`,
        summary: `对方的回合 ${error.status}`, consequence: '', followup: '',
        decideRunId, replyRunId: error.run.id,
        turnsLeft: await remaining(actor.name), status: error.status === 'timeout' ? 'timeout' : 'failed',
      };
    }
    throw error;
  }

  const next = rels.filter((r) => r.handle !== target.handle);
  next.push({ handle: target.handle, attraction, trust, tension, note, at: Date.now() });
  await writeRels(bearer, actor.name, next).catch(() => undefined);
  const event: TickEvent = {
    actor: actor.name, target: target.name, move: 'APPROACH', message, reply, attraction, trust, tension, note,
    severity: tension > 0.6 ? 'drama' : 'relationship',
    headline: `${actor.name} 在广场上叫住了 ${target.name}`,
    summary: note ? `${actor.name} 走近 ${target.name}：${note}` : `${actor.name} 走近了 ${target.name}`,
    consequence: '', followup: '',
    decideRunId, replyRunId, turnsLeft: await remaining(actor.name), status: 'ok',
  };
  const thread = absorb(event);
  if (thread && thread.beats.length >= 2) {
    // Hand the narrator the rivalries it cannot see from a pair-keyed thread.
    const rivalry = townDb.townDbReady()
      ? await townDb.allRels().then((r) => detectTriangles(r)).catch(() => [])
      : [];
    await narrate(thread, bearer, actor.shareToken, rivalry).catch(() => undefined);
  }
  return event;
}
