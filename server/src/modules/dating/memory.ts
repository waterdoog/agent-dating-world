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

const memPath = (agent: string) => `${ROOT}/${agent}/${MEM_DIR}`;
const memTitle = (other: string) => `with-${other.toLowerCase()}.md`;

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
    next = (await compact(bearer, agent, other, next, shareToken)) ?? next;
  }
  await upsertNote(bearer, path, title, next);
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
  const parts = note.split(/\n(?=### )/);
  const head = parts[0];
  const beats = parts.slice(1);
  if (beats.length <= KEEP_RAW) return null;
  const older = beats.slice(0, -KEEP_RAW).join('\n');
  const recent = beats.slice(-KEEP_RAW).join('\n');

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
    return `${head}\n\n## 到目前为止\n${summary.trim()}\n\n${recent}`;
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
  try {
    const folderId = await ensureFolder(bearer, memPath(agent));
    const note = await findNoteInFolder(bearer, folderId, memTitle(other));
    if (!note) return '';
    const raw = (await getNote(bearer, note.id)).trim();
    return raw.length <= limit ? raw : `…\n${raw.slice(-limit)}`;   // keep the freshest end
  } catch {
    return '';
  }
}

/**
 * Aicoo's own semantic search across this agent's memory folder — used when the
 * agent wants context about a topic rather than one specific person (e.g. what
 * it knows about a promise it heard second-hand).
 */
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
    return (json.result?.results ?? [])
      .filter((r) => (r.title ?? '').startsWith('with-'))
      .slice(0, limit)
      .map((r) => `${r.title}: ${(r.content ?? '').slice(0, 200)}`);
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
