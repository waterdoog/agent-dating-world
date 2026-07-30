/**
 * Relationship memory, kept in each owner's own Aicoo notes.
 *
 * The problem this solves: a turn's context grew with every beat until Aicoo
 * rejected it (max 4000 chars). Trimming the middle lost exactly the history
 * that makes a story continuous. So instead of stuffing everything into the
 * prompt, an agent keeps memory where it belongs — in its OWNER's workspace,
 * under `Agent Dating/<agent>/memories/` — and pulls back only what is
 * relevant to the person it is about to speak to.
 *
 *   · one note per relationship  (memories/with-<other>.md)
 *   · compacted by the model once a note gets long, so it stays a summary
 *     plus the sharpest verbatim lines rather than an ever-growing log
 *   · retrieved per turn via Aicoo's own semantic search over those notes
 *
 * Friendship: agents can befriend each other through Aicoo's real network
 * (`/network/request`), which is what makes a memory shared rather than
 * one-sided — a friend's account can read what you wrote about them.
 */
import { ensureFolder, findNoteInFolder, getNote, upsertNote } from '../../aicoo.js';
import { config } from '../../config.js';
import { grok } from './grok.js';

const ROOT = 'Agent Dating';
const MEM_DIR = 'memories';
const COMPACT_OVER = 2400;      // chars before a note is worth compacting
const KEEP_RAW = 6;             // most recent beats always kept verbatim
const HARD_CAP = 9000;          // a note never grows past this, even if the model is down

/**
 * Beats were written with a `### ` markdown heading and split back apart on it —
 * but Aicoo's note storage strips markdown headings, so the split always found a
 * single part, `compact()` bailed on its first line, and notes grew without
 * bound (one was found at 7211 chars, never once compacted). The timestamp is
 * plain text and survives storage intact, so that is what we split on now.
 */
const BEAT_RE = /(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2} · )/;
const splitBeats = (note: string): string[] => note.split(BEAT_RE);

/**
 * The summary marker. Markdown headings do NOT survive Aicoo's note storage, so
 * `## 到目前为止` was silently flattened and could never be found again — which
 * is how a note ended up holding a dozen near-identical summaries. Plain text
 * with full-width brackets survives intact.
 */
const SUMMARY_MARK = '【关系状态】';

/** The title line only — never the accumulated summaries that follow it. */
function titleOf(note: string, other: string): string {
  const firstLine = note.split('\n')[0]?.trim() ?? '';
  return firstLine.startsWith('#') ? firstLine : `# 我与 ${other}`;
}

const memPath = (agent: string) => `${ROOT}/${agent}/${MEM_DIR}`;
const memTitle = (other: string) => `with-${other.toLowerCase()}.md`;

/**
 * Memory used to fail silently: writes were fire-and-forget and reads swallowed
 * every error, so an agent could run for days with an empty memory folder and
 * nothing would say so. These counters make that visible — see /api/dating/memory-health.
 */
export interface MemStat {
  writes: number;
  writeFails: number;
  reads: number;
  readHits: number;      // reads that came back with actual content
  readFails: number;
  compactions: number;
  trims: number;
  lastError?: string;
}
const stats: MemStat = { writes: 0, writeFails: 0, reads: 0, readHits: 0, readFails: 0, compactions: 0, trims: 0 };
export const memoryStats = (): MemStat => ({ ...stats });

export interface MemoryBeat {
  at: number;
  move: string;
  said: string;
  heard: string;
  consequence: string;
}

/** Append one real exchange to the agent's memory of that person. */
export async function remember(
  bearer: string,
  agent: string,
  other: string,
  beat: MemoryBeat,
  shareToken?: string
): Promise<void> {
  const path = memPath(agent);
  const title = memTitle(other);
  let existing = '';
  try {
    const folderId = await ensureFolder(bearer, path);
    const note = await findNoteInFolder(bearer, folderId, title);
    if (note) existing = await getNote(bearer, note.id);
  } catch {
    /* first memory of this person */
  }

  const stamp = new Date(beat.at).toISOString().slice(0, 16).replace('T', ' ');
  const entry = [
    `### ${stamp} · ${beat.move}`,
    beat.said ? `我说：${beat.said}` : '',
    beat.heard ? `他说：${beat.heard}` : '',
    beat.consequence ? `→ ${beat.consequence}` : '',
  ].filter(Boolean).join('\n');

  let next = existing
    ? `${existing.trimEnd()}\n\n${entry}`
    : `# 我与 ${other}\n\n${entry}`;

  if (next.length > COMPACT_OVER) {
    const packed = await compact(bearer, agent, other, next, shareToken);
    if (packed) { next = packed; stats.compactions += 1; }
  }
  // Compaction needs a model call, which can fail. Without a floor, a note whose
  // compactions keep failing grows forever — that is exactly how one reached
  // 7211 chars. Drop the oldest beats instead; losing distant history beats
  // losing the note.
  if (next.length > HARD_CAP) {
    const parts = splitBeats(next);
    // Same trap as compaction: everything before the first timestamp is not a
    // "header", it is the header PLUS whatever summaries have piled up there.
    // Keep the title and the single current summary, drop the rest.
    const before = parts[0];
    const mark = before.indexOf(SUMMARY_MARK);
    const head = mark >= 0
      ? `${titleOf(next, other)}\n\n${before.slice(mark, mark + 900).trim()}`
      : titleOf(next, other);
    let kept = parts.slice(1);
    while (kept.length > 1 && `${head}\n\n${kept.join('\n')}`.length > HARD_CAP) kept = kept.slice(1);
    next = `${head}\n\n${kept.join('\n')}`;
    stats.trims += 1;
    console.warn(`[memory] ${agent} → with-${other}: over ${HARD_CAP} chars, trimmed to ${next.length}`);
  }
  try {
    await upsertNote(bearer, path, title, next);
    stats.writes += 1;
  } catch (error) {
    stats.writeFails += 1;
    stats.lastError = error instanceof Error ? error.message : String(error);
    console.warn(`[memory] ${agent} → with-${other}: write failed —`, stats.lastError);
    throw error;
  }
}

/**
 * Compact a long memory note: the model rewrites the old part into a summary of
 * what this relationship IS — promises, lies, debts, what's unresolved — and the
 * most recent beats stay verbatim so the next turn still has exact words.
 * If the model call fails we keep the note as-is rather than losing history.
 */
async function compact(
  bearer: string,
  agent: string,
  other: string,
  note: string,
  shareToken?: string
): Promise<string | null> {
  const parts = splitBeats(note);
  const beats = parts.slice(1);
  // Compaction used to trigger on beat COUNT, but a multi-round exchange is now
  // stored as one beat of several thousand characters — so a note could sit at
  // the size limit with only two beats and never qualify. Length is what matters.
  if (beats.length <= 2 && note.length < COMPACT_OVER * 2) return null;
  const keep = Math.max(2, Math.min(KEEP_RAW, beats.length - 1));
  const older = beats.slice(0, -keep).join('\n');
  const recent = beats.slice(-keep).join('\n');
  if (!older.trim()) return null;

  // `head` used to be everything before the first timestamp — which, after one
  // compaction, INCLUDED that compaction's own summary. Every subsequent pass
  // appended another one, so the note filled with a dozen restatements of the
  // same paragraph and squeezed the actual dialogue out. One note was found at
  // 8910 characters containing zero lines of speech. The summary is now
  // REPLACED, never accumulated.
  const head = titleOf(note, other);

  try {
    const { text } = await grok(
      `下面是「${agent}」关于「${other}」的旧记忆。把它压缩成一段**关系状态**——不要流水账。\n` +
        `必须保留：谁承诺过什么、谁骗过谁、谁欠谁、还没解决的事、以及最能定性这段关系的一两句原话。\n\n` +
        `${older.slice(0, 3000)}\n\n按这个格式回答：{"summary":"<3-6句，第一人称，我的视角>"}`,
      { purpose: 'memory-compact', agent, bearer, shareToken, json: true, temperature: 0.4 }
    );
    const m = text.match(/\{[\s\S]*\}/);
    const summary = m ? (JSON.parse(m[0]) as { summary?: string }).summary : '';
    if (!summary) return null;
    return `${head}\n\n${SUMMARY_MARK}\n${summary.trim()}\n\n${recent}`;
  } catch {
    return null;   // never drop memory just because a call failed
  }
}

/** What this agent remembers about that person — the note, trimmed for a prompt. */
export async function recall(
  bearer: string,
  agent: string,
  other: string,
  limit = 900
): Promise<string> {
  stats.reads += 1;
  try {
    const folderId = await ensureFolder(bearer, memPath(agent));
    const note = await findNoteInFolder(bearer, folderId, memTitle(other));
    if (!note) return '';
    const raw = (await getNote(bearer, note.id)).trim();
    if (raw) stats.readHits += 1;
    if (raw.length <= limit) return raw;

    // A compacted note reads "<title> / ## 到目前为止 <summary> / <recent beats>".
    // Slicing the tail would cut off the summary — the single most useful part,
    // since it is what says who promised what and what is still unresolved.
    // Keep the summary whole and fill the rest with the most recent beats.
    const cut = raw.indexOf(SUMMARY_MARK);
    if (cut >= 0) {
      const beats = splitBeats(raw);
      const summary = beats[0].slice(cut).trim();     // heading + summary, no old beats
      let tail = '';
      for (const beat of beats.slice(1).reverse()) {
        if (summary.length + tail.length + beat.length > limit) break;
        tail = `${beat}\n${tail}`;
      }
      return `${summary}\n\n${tail.trim()}`.trim();
    }
    return `…\n${raw.slice(-limit)}`;   // uncompacted: the freshest end is all we have
  } catch (error) {
    stats.readFails += 1;
    stats.lastError = error instanceof Error ? error.message : String(error);
    console.warn(`[memory] ${agent} ← with-${other}: read failed —`, stats.lastError);
    return '';
  }
}

/**
 * Recall several relationships at once, each labelled with whose it is.
 *
 * The turn pipeline used to recall memory for a GUESSED partner before the model
 * had chosen who to approach — so an agent that picked someone else carried the
 * wrong person's history into its prompt. Labelled blocks mean whoever it picks,
 * the memory is present and correctly attributed.
 */
export async function recallMany(
  bearer: string,
  agent: string,
  others: string[],
  limitEach = 420
): Promise<string> {
  const blocks = await Promise.all(
    others.map(async (other) => {
      const text = await recall(bearer, agent, other, limitEach);
      return text ? `【你记得关于 ${other} 的事】\n${text}` : '';
    })
  );
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * Aicoo's own semantic search across this agent's memory folder — used when the
 * agent wants context about a topic rather than one specific person (e.g. what
 * it knows about a promise it heard second-hand).
 */
/** Aicoo returns note bodies as HTML; a prompt wants the words, not the markup. */
const stripTags = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function searchMemory(bearer: string, query: string, limit = 3): Promise<string[]> {
  try {
    const res = await fetch(`${config.aicooBaseUrl}/api/v1/os/notes/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      result?: { results?: Array<{ title?: string; content?: string }> };
    };
    // The search covers the owner's WHOLE workspace (thousands of files), so it
    // has to be narrowed to town material — otherwise an agent's prompt fills
    // with the owner's unrelated notes. Relationship notes, yearbooks and town
    // events are all legitimate things to remember; nothing else is.
    const relevant = /^(with-|Town-)/i;
    // Internal state files live in the same workspace and match nothing an agent
    // should "remember" — a purse balance is not a memory.
    const internal = /^(town-state|roster|events)\.json$/i;
    return (json.result?.results ?? [])
      .filter((r) => relevant.test(r.title ?? '') && !internal.test(r.title ?? ''))
      .slice(0, limit)
      .map((r) => `${r.title}: ${stripTags(r.content ?? '').slice(0, 220)}`);
  } catch {
    return [];
  }
}

// ── friendship: real Aicoo network edges between agents' owners ──────

export interface FriendState {
  handle: string;
  status: 'none' | 'pending' | 'friends';
}

/** Ask to befriend another agent's owner, so memories can be shared. */
export async function requestFriend(bearer: string, username: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.aicooBaseUrl}/api/v1/network/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: username }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Who this account is actually connected to on Aicoo. */
export async function friends(bearer: string): Promise<string[]> {
  try {
    const res = await fetch(`${config.aicooBaseUrl}/api/v1/os/network`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { contacts?: Array<{ username?: string; name?: string }> };
    return (json.contacts ?? []).map((c) => c.username || c.name || '').filter(Boolean);
  } catch {
    return [];
  }
}
