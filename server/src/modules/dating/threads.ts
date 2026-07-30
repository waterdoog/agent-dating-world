/**
 * Story threads — the town's continuity layer.
 *
 * A single turn is a beat. A thread is what makes beats a STORY: the same pair
 * (or triangle) coming back, an expectation that hardens into resentment, a
 * promise that turns out to have been made twice. Threads are derived from real
 * town events only — never invented — and their narration is a real Grok call
 * so the summary is as traceable as the beats under it.
 *
 * Cross-agent knowledge lives here too: who said what to whom, so two rivals
 * can later discover they heard the same line, and so a secret told to one
 * agent can surface somewhere else.
 */
import { grok, ModelError } from './grok.js';
import type { TickEvent } from './engine.js';
import { recordThread, recordDigest } from './records.js';

export interface ThreadBeat {
  actor: string;
  target: string;
  move: string;
  headline: string;
  message: string;
  reply: string;
  attraction: number;
  trust: number;
  tension: number;
  at: number;
}

export interface StoryThread {
  id: string;              // stable key for the cast, e.g. "bravo~charlie"
  cast: string[];
  beats: ThreadBeat[];
  /** Grok-written, updated as the thread grows. */
  title: string;
  arc: string;             // where this has got to
  openQuestion: string;    // the suspense that is not resolved
  runId?: string;          // the model run that wrote the current narration
  updatedAt: number;
}

const threads = new Map<string, StoryThread>();
const MAX_BEATS = 12;

export const threadKey = (a: string, b: string) => [a, b].map((s) => s.toLowerCase()).sort().join('~');

/** Every line an agent has said to another — the raw material for "同样的承诺". */
interface Utterance { from: string; to: string; text: string; at: number }
const said: Utterance[] = [];
const MAX_SAID = 400;

/** Who knows what about whom: leaked secrets, overheard claims, suspicions. */
export interface Knowledge {
  holder: string;      // who knows it
  about: string;       // who it concerns
  fact: string;
  source: string;      // how they came to know
  at: number;
}
const knowledge: Knowledge[] = [];
const MAX_KNOWLEDGE = 200;

export function knownTo(holder: string): Knowledge[] {
  return knowledge.filter((k) => k.holder.toLowerCase() === holder.toLowerCase()).slice(0, 8);
}
export function recordKnowledge(k: Omit<Knowledge, 'at'>): void {
  knowledge.unshift({ ...k, at: Date.now() });
  if (knowledge.length > MAX_KNOWLEDGE) knowledge.length = MAX_KNOWLEDGE;
}

/**
 * Two agents were told near-identical things by the same person — the raw
 * ingredient of "两个情敌发现听到了同一句承诺". Detected from real utterances.
 */
export function duplicatePromises(): Array<{ speaker: string; heard: string[]; a: string; b: string }> {
  const bySpeaker = new Map<string, Utterance[]>();
  for (const u of said) {
    const list = bySpeaker.get(u.from) ?? [];
    list.push(u);
    bySpeaker.set(u.from, list);
  }
  const out: Array<{ speaker: string; heard: string[]; a: string; b: string }> = [];
  for (const [speaker, list] of bySpeaker) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].to === list[j].to) continue;
        if (overlap(list[i].text, list[j].text) >= 0.5) {
          out.push({ speaker, heard: [list[i].text, list[j].text], a: list[i].to, b: list[j].to });
        }
      }
    }
  }
  return out.slice(0, 5);
}

/**
 * How much two lines say the same thing.
 *
 * This used to split on non-letter/non-digit runs. Chinese writes without
 * spaces, so a whole clause came back as ONE token and the intersection only
 * scored when two lines matched character-for-character. `duplicatePromises` —
 * "the same promise was made to two different people", the best drama trigger in
 * the system — therefore almost never fired on Chinese text.
 *
 * Character bigrams work for both scripts, and match what `tooSimilar` in
 * engine.ts already does, so the two detectors now agree.
 */
function overlap(a: string, b: string): number {
  const grams = (t: string) => {
    const clean = t.toLowerCase().replace(/[\s，。！？、,.!?"'“”「」()（）]/g, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const wa = grams(a), wb = grams(b);
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

/** Fold a real town event into its thread. Returns the thread it belongs to. */
export function absorb(e: TickEvent): StoryThread | null {
  if (!e.target || e.status === 'failed' || e.status === 'timeout' || e.move === 'FAILED' || e.move === 'BROKE') return null;
  if (e.message) {
    said.unshift({ from: e.actor, to: e.target, text: e.message, at: Date.now() });
    if (said.length > MAX_SAID) said.length = MAX_SAID;
  }
  const id = threadKey(e.actor, e.target);
  const t = threads.get(id) ?? {
    id, cast: [e.actor, e.target], beats: [],
    title: `${e.actor} 与 ${e.target}`, arc: '', openQuestion: '', updatedAt: Date.now(),
  };
  t.beats.unshift({
    actor: e.actor, target: e.target, move: e.move, headline: e.headline,
    message: e.message, reply: e.reply,
    attraction: e.attraction, trust: e.trust, tension: e.tension, at: Date.now(),
  });
  if (t.beats.length > MAX_BEATS) t.beats.length = MAX_BEATS;
  t.updatedAt = Date.now();
  threads.set(id, t);
  return t;
}

/**
 * Ask Grok to narrate where a thread has got to. Real model call, recorded;
 * on failure the thread simply keeps its previous narration (never faked).
 */
export async function narrate(
  thread: StoryThread,
  bearer: string,
  shareToken?: string,
  /**
   * Rivals for someone in this thread. A thread is keyed on a PAIR, so without
   * this the narrator literally cannot see that a third person is pulling at the
   * same relationship — a triangle became three separate two-person stories,
   * each blind to the others.
   */
  rivalry?: Array<{ a: string; b: string; contested: string }>
): Promise<StoryThread> {
  const beats = [...thread.beats].reverse()
    .map((b) => `- ${b.actor} → ${b.target} [${b.move}] ${b.headline}\n    「${b.message}」${b.reply ? ` / 回：「${b.reply}」` : '（没有回应）'}  心动${b.attraction.toFixed(2)} 信任${b.trust.toFixed(2)} 张力${b.tension.toFixed(2)}`)
    .join('\n');
  const dup = duplicatePromises().filter((d) => thread.cast.includes(d.a) || thread.cast.includes(d.b));
  const dupText = dup.length
    ? `\n注意：${dup[0].speaker} 对 ${dup[0].a} 和 ${dup[0].b} 说过几乎一样的话。`
    : '';
  const tri = (rivalry ?? []).filter((r) => thread.cast.includes(r.a) || thread.cast.includes(r.b) || thread.cast.includes(r.contested));
  const triText = tri.length
    ? `\n注意：${tri[0].a} 和 ${tri[0].b} 都想要 ${tri[0].contested}——但他们各自未必知道对方也在。` +
      `这条线不是两个人的事，写的时候要把第三个人算进去。`
    : '';

  const prompt =
    `你是相亲小镇的记录者。下面是 ${thread.cast.join(' 和 ')} 之间真实发生过的对话，按时间从早到晚：\n\n${beats}${dupText}${triText}\n\n` +
    `把它写成一条连续故事线的当前状态。只依据上面真实发生的事，不要编造没发生的情节，也不要预设结局。\n` +
    `标题写具体事实（像 "Bravo catches Charlie changing his story"、"Luna waits. Zero never arrives."），不要抽象文学句。\n` +
    `arc 用 1-2 句说清楚：起因 → 现在到了哪一步 → 关系发生了什么变化。\n` +
    `openQuestion 写一个还没有答案的悬念（谁在等什么、谁还不知道什么、下一步取决于谁）。\n\n` +
    `按这个格式回答：{"title":"<具体事实，<=14 词>","arc":"<1-2 句>","openQuestion":"<一句悬念>"}`;

  try {
    const { text, run } = await grok(prompt, { purpose: 'story-thread', agent: thread.cast.join('~'), bearer, shareToken, json: true, temperature: 0.8 });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const p = JSON.parse(m[0]) as { title?: string; arc?: string; openQuestion?: string };
      thread.title = String(p.title ?? thread.title).trim();
      thread.arc = String(p.arc ?? thread.arc).trim();
      thread.openQuestion = String(p.openQuestion ?? thread.openQuestion).trim();
      thread.runId = run.id;
      thread.updatedAt = Date.now();
      void recordThread(thread);                     // durable in links/
    }
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    // keep the previous narration — a failed run never invents story
  }
  return thread;
}

export function listThreads(limit = 12): StoryThread[] {
  return [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** A Grok-written digest of what the town is currently about. */
export interface WorldDigest {
  lines: Array<{ headline: string; shift: string; detail: string }>;
  runId?: string;
  at: number;
}
let digest: WorldDigest | null = null;
export function currentDigest(): WorldDigest | null {
  return digest;
}

/**
 * Summarise the town from its real threads. Facts only — the digest may not
 * introduce anyone or anything that has not actually happened.
 */
export async function summariseWorld(bearer: string, shareToken?: string): Promise<WorldDigest | null> {
  const live = listThreads(6).filter((t) => t.beats.length);
  if (!live.length) return digest;
  const body = live
    .map((t) => {
      const last = t.beats.slice(0, 3).reverse()
        .map((b) => `    ${b.actor} → ${b.target} [${b.move}] ${b.headline}｜心动${b.attraction.toFixed(2)} 信任${b.trust.toFixed(2)} 张力${b.tension.toFixed(2)}`)
        .join('\n');
      return `【${t.cast.join(' × ')}】${t.title}\n  ${t.arc || '(还在展开)'}\n${last}${t.openQuestion ? `\n    悬念：${t.openQuestion}` : ''}`;
    })
    .join('\n\n');
  const dup = duplicatePromises();
  const dupText = dup.length ? `\n另外：${dup.map((d) => `${d.speaker} 对 ${d.a} 和 ${d.b} 说过几乎相同的话`).join('；')}。` : '';

  const prompt =
    `你是相亲小镇的世界动态编辑。下面是小镇里真实发生的故事线：\n\n${body}${dupText}\n\n` +
    `挑出最值得报道的 3-5 条，每条写成：\n` +
    `- headline：写具体事实，谁做了什么。像 "Bravo catches Charlie changing his story"、"Luna waits. Zero never arrives."、"Vale rejects Aster, then follows him"。禁止 "沉默中的涟漪" 这类抽象文学句。\n` +
    `- shift：关系发生了什么变化，一个短句。像 "trust falls, suspicion rises"、"expectation becomes resentment"、"jealousy becomes an alliance"。\n` +
    `- detail：一句话说清动机、消息来源，以及还没解决的悬念。\n` +
    `只用上面真实发生过的事，不要编造人物或情节。\n\n` +
    `按这个格式回答：{"lines":[{"headline":"...","shift":"...","detail":"..."}]}`;

  try {
    const { text, run } = await grok(prompt, { purpose: 'world-feed-summary', bearer, shareToken, json: true, temperature: 0.7 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return digest;
    const parsed = JSON.parse(m[0]) as { lines?: Array<{ headline?: string; shift?: string; detail?: string }> };
    const lines = (parsed.lines ?? [])
      .filter((l) => l?.headline)
      .slice(0, 5)
      .map((l) => ({ headline: String(l.headline).trim(), shift: String(l.shift ?? '').trim(), detail: String(l.detail ?? '').trim() }));
    if (lines.length) {
      digest = { lines, runId: run.id, at: Date.now() };
      void recordDigest(digest);                     // durable in links/
    }
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;   // failed run keeps the old digest
  }
  return digest;
}
export function threadFor(a: string, b: string): StoryThread | undefined {
  return threads.get(threadKey(a, b));
}
