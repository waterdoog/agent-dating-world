/**
 * Town records, written into Aicoo notes under the shared `links/` folder —
 * the same place Aicoo keeps a share link's own policy note. Everything the
 * town produces is durable and inspectable there:
 *
 *   links/Town-Events        every traceable beat (with its model run ids)
 *   links/Town-Thread_<pair> one continuing story line per pair
 *   links/Town-Digest        the current World Feed summary
 *   links/Town-Yearbook_<a>  an agent's own account of a year, in its voice
 *
 * Notes are the database; a failed write never blocks the town.
 */
import { config } from '../../config.js';
import { upsertNote } from '../../aicoo.js';
import type { TickEvent } from './engine.js';
import type { StoryThread, WorldDigest } from './threads.js';
import type { Yearbook } from './yearbook.js';

const FOLDER = 'links';
const operator = () => config.operatorApiKey;

/**
 * A bad timestamp should not be fatal. One undefined `at` on one beat threw
 * RangeError inside narrate() and took the entire BFF down with it — the whole
 * town went dark because a log line could not be formatted.
 */
function stamp(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '????-??-?? ??:??:??';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Append-style event log: newest first, capped so the note stays readable. */
const eventLog: string[] = [];
const MAX_LOG = 60;

export async function recordEvent(e: TickEvent): Promise<void> {
  if (!operator()) return;
  const block = [
    `## ${stamp(Date.now())} · ${e.headline || `${e.actor} → ${e.target}`}`,
    `- 人物：${e.actor} → ${e.target}｜动作：${e.move}｜级别：${e.severity}`,
    e.summary ? `- 经过：${e.summary}` : '',
    e.consequence ? `- 关系变化：${e.consequence}` : '',
    e.followup ? `- 悬念：${e.followup}` : '',
    e.message ? `- ${e.actor} 说：「${e.message}」` : '',
    e.reply ? `- ${e.target} 回：「${e.reply}」` : '',
    `- 读数：心动 ${e.attraction.toFixed(2)}｜信任 ${e.trust.toFixed(2)}｜张力 ${e.tension.toFixed(2)}`,
    `- 追溯：decide=${e.decideRunId ?? '-'}｜reply=${e.replyRunId ?? '-'}｜剩余额度=${e.turnsLeft ?? '-'}｜状态=${e.status ?? 'ok'}`,
  ].filter(Boolean).join('\n');
  eventLog.unshift(block);
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
  await upsertNote(operator(), FOLDER, 'Town-Events', `# 相亲小镇 · 事件记录\n\n${eventLog.join('\n\n')}\n`).catch(() => undefined);
}

export async function recordThread(t: StoryThread): Promise<void> {
  if (!operator()) return;
  const beats = [...t.beats].reverse()
    .map((b) => `- ${stamp(b.at)} ${b.actor} → ${b.target} [${b.move}] ${b.headline}\n    「${b.message}」${b.reply ? `\n    回：「${b.reply}」` : ''}\n    心动 ${b.attraction.toFixed(2)}｜信任 ${b.trust.toFixed(2)}｜张力 ${b.tension.toFixed(2)}`)
    .join('\n');
  const body = [
    `# ${t.title}`,
    ``,
    `**当事人**：${t.cast.join(' × ')}`,
    t.arc ? `**故事走到哪**：${t.arc}` : '',
    t.openQuestion ? `**还没有答案**：${t.openQuestion}` : '',
    t.runId ? `**追溯**：narration run = ${t.runId}` : '',
    ``,
    `## 经过`,
    beats,
  ].filter(Boolean).join('\n');
  await upsertNote(operator(), FOLDER, `Town-Thread_${t.id}`, body).catch(() => undefined);
}

export async function recordDigest(d: WorldDigest): Promise<void> {
  if (!operator()) return;
  const body = [
    `# 相亲小镇 · 世界动态`,
    ``,
    `_更新于 ${stamp(d.at)}${d.runId ? `｜run = ${d.runId}` : ''}_`,
    ``,
    ...d.lines.map((l) => `## ${l.headline}\n**${l.shift}**\n${l.detail}`),
  ].join('\n');
  await upsertNote(operator(), FOLDER, 'Town-Digest', body).catch(() => undefined);
}

export async function recordYearbook(y: Yearbook): Promise<void> {
  if (!operator()) return;
  const body = [
    `# ${y.agent} · 第 ${y.year} 年`,
    ``,
    `## ${y.headline}`,
    y.story,
    ``,
    `## 我怎么看他们`,
    ...(y.verdicts.length ? y.verdicts.map((v) => `- **${v.who}**：${v.line}`) : ['- （这一年我谁也没真正认识）']),
    ``,
    `## 忘不掉的事`,
    ...(y.dramas.length ? y.dramas.map((d) => `- ${d}`) : ['- （什么都没发生）']),
    ``,
    y.stillWaiting ? `## 我还在等\n${y.stillWaiting}` : '',
    ``,
    `## 这一年我把话花在了谁身上`,
    ...(y.spent.length ? y.spent.map((s) => `- ${s.target}：${s.turns} 次`) : ['- （几乎没开口）']),
    ``,
    y.runId ? `_追溯：run = ${y.runId}_` : '',
  ].filter(Boolean).join('\n');
  await upsertNote(operator(), FOLDER, `Town-Yearbook_${y.agent}_Y${y.year}`, body).catch(() => undefined);
}
