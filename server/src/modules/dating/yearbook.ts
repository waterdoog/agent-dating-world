/**
 * Yearbook — each agent's own account of the year.
 *
 * One world year is one real day (see the town clock), so at the turn of a year
 * every agent looks back: what it thinks of each person it met, which days it
 * remembers, what it spent its conversations on, and what it is still waiting
 * for. Written IN THAT AGENT'S OWN VOICE by a real model run, from its real
 * relationship history and the real beats it was part of — never invented.
 */
import { grok, ModelError } from './grok.js';
import type { Rel, TickEvent } from './engine.js';
import { listThreads } from './threads.js';
import { spentOn } from './budget.js';
import { recordYearbook } from './records.js';

export interface YearbookVerdict {
  who: string;
  line: string;        // what this agent says about them, in its own voice
}

export interface Yearbook {
  agent: string;
  year: number;
  headline: string;         // how the agent sums up its own year
  story: string;            // 2-4 sentences, its voice, its bias
  verdicts: YearbookVerdict[];
  dramas: string[];         // the days it will not forget
  stillWaiting: string;     // what it is still hoping for, if anything
  spent: Array<{ target: string; turns: number }>;
  runId?: string;
  at: number;
}

const books = new Map<string, Yearbook>();     // `${agent}:${year}`
const key = (agent: string, year: number) => `${agent.toLowerCase()}:${year}`;

export function listYearbooks(limit = 20): Yearbook[] {
  return [...books.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}
export function yearbookFor(agent: string, year: number): Yearbook | undefined {
  return books.get(key(agent, year));
}

/**
 * Write one agent's year, in its own voice. Facts come from its relationship
 * history, the beats it appeared in, and how it actually spent its turns.
 */
export async function writeYearbook(args: {
  shareToken?: string;
  agent: string;
  persona: string;
  year: number;
  rels: Rel[];
  events: TickEvent[];
  bearer: string;
}): Promise<Yearbook | null> {
  const { agent, persona, year, rels, events, bearer, shareToken } = args;
  const mine = events.filter(
    (e) => e.actor.toLowerCase() === agent.toLowerCase() || e.target.toLowerCase() === agent.toLowerCase()
  );
  if (!mine.length && !rels.length) return null;      // nothing real to look back on

  const relText = rels.length
    ? rels.map((r) => `- ${r.handle}：心动 ${r.attraction.toFixed(2)}、信任 ${(r.trust ?? 0.3).toFixed(2)}、张力 ${r.tension.toFixed(2)}（${r.note}）`).join('\n')
    : '（这一年你没有和任何人真正建立关系）';
  const beats = mine.slice(0, 14).reverse()
    .map((e) => `- ${e.headline || `${e.actor} → ${e.target} ${e.move}`}${e.consequence ? `（${e.consequence}）` : ''}`)
    .join('\n');
  const threads = listThreads(8)
    .filter((t) => t.cast.some((c) => c.toLowerCase() === agent.toLowerCase()))
    .map((t) => `- ${t.title}${t.openQuestion ? `｜还没有答案：${t.openQuestion}` : ''}`)
    .join('\n');
  const spend = await spentOn(agent);
  const spendText = spend.length
    ? spend.slice(0, 5).map((s) => `${s.target} ${s.turns} 次`).join('、')
    : '（你几乎没有开口）';

  const prompt =
    `你是「${agent}」，住在相亲小镇。第 ${year} 年结束了，你在给自己写年终总结。\n\n` +
    `你是谁：\n${persona}\n\n` +
    `这一年你和别人的关系：\n${relText}\n\n` +
    `这一年真实发生过的事：\n${beats || '（几乎什么都没发生）'}\n\n` +
    `你身处的故事线：\n${threads || '（没有属于你的故事线）'}\n\n` +
    `你把有限的交流机会花在了：${spendText}\n\n` +
    `用**你自己的语气**写这份总结——你的性格是什么样，句子就该是什么样。刻薄的人就刻薄，怕受伤的人就绕着说，享受被追的人可以自得。\n` +
    `只根据上面真实发生的事写，不要编造没发生过的情节，也不要美化成一个圆满结局。你可以对某些人口是心非。\n\n` +
    `按这个格式回答：\n` +
    `{"headline":"<你怎么概括自己这一年，一句话>","story":"<2-4 句，你的语气、你的偏见>","verdicts":[{"who":"<某人>","line":"<你对他的评价，一句，你的语气>"}],"dramas":["<这一年你忘不掉的事，各一句>"],"stillWaiting":"<你还在等什么；如果什么都不等，就说清楚>"}`;

  try {
    const { text, run } = await grok(prompt, { purpose: 'yearbook', agent, bearer, shareToken, json: true, temperature: 0.95 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as Partial<Yearbook> & { verdicts?: YearbookVerdict[]; dramas?: string[] };
    const book: Yearbook = {
      agent,
      year,
      headline: String(p.headline ?? '').trim(),
      story: String(p.story ?? '').trim(),
      verdicts: (p.verdicts ?? []).filter((v) => v?.who).slice(0, 8).map((v) => ({ who: String(v.who), line: String(v.line ?? '').trim() })),
      dramas: (p.dramas ?? []).map((d) => String(d).trim()).filter(Boolean).slice(0, 6),
      stillWaiting: String(p.stillWaiting ?? '').trim(),
      spent: spend.slice(0, 8),
      runId: run.id,
      at: Date.now(),
    };
    books.set(key(agent, year), book);
    void recordYearbook(book).catch(() => undefined);     // durable in links/
    return book;
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    return null;      // a failed run writes no yearbook — never a fabricated one
  }
}
