/**
 * Thin client for the Aicoo v1 REST surface. Operator workspace calls use the
 * dedicated Virtual N1 credential. Encounter turns intentionally use an
 * anonymous, short-lived share capability so no player identity or relationship
 * memory can enter the runtime.
 */
import { config } from './config.js';

export class AicooError extends Error {
  constructor(
    public status: number,
    public body: string,
    message?: string
  ) {
    super(message ?? `Aicoo API error ${status}: ${body.slice(0, 300)}`);
  }
}

async function api<T>(bearer: string, method: string, apiPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.aicooBaseUrl}/api/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(apiPath === '/chat' ? 90_000 : 30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AicooError(res.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AicooError(res.status, text, 'Aicoo returned non-JSON response');
  }
}

async function aicooJson<T>(
  bearer: string | null,
  method: string,
  absolutePath: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${config.aicooBaseUrl}${absolutePath}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Fighter rounds run inside a 300s serverless invocation. Both attacks and
    // both defenses are parallelized per round; cap each model wave so link
    // cleanup and durable finalization still have time to run.
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) throw new AicooError(res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AicooError(res.status, text, 'Aicoo returned non-JSON response');
  }
}

// ─── Folders & notes ────────────────────────────────────────────────

export interface NoteSummary {
  id: number;
  title: string;
  updatedAt?: string;
}

export interface FolderSummary {
  id: number;
  name: string;
  parentId: number | null;
}

export async function ensureFolder(bearer: string, pathSpec: string): Promise<number> {
  const res = await api<{ folder: { id: number } }>(bearer, 'POST', '/os/folders', {
    path: pathSpec,
  });
  return res.folder.id;
}

export async function listFoldersByParentId(
  bearer: string,
  parentId: number
): Promise<FolderSummary[]> {
  const res = await api<{ folders: FolderSummary[] }>(
    bearer,
    'GET',
    `/os/folders?parentId=${parentId}`
  );
  return (res.folders ?? []).filter((folder) => Number(folder.parentId) === parentId);
}

export async function listNotes(bearer: string, folderName: string): Promise<NoteSummary[]> {
  try {
    const res = await api<{ notes: NoteSummary[] }>(
      bearer,
      'GET',
      `/os/notes?folderName=${encodeURIComponent(folderName)}&limit=200`
    );
    return res.notes ?? [];
  } catch (error) {
    // Folder not created yet (first-time user) → no notes.
    if (error instanceof AicooError && error.status === 404) return [];
    throw error;
  }
}

export async function listNotesByFolderId(
  bearer: string,
  folderId: number
): Promise<NoteSummary[]> {
  const res = await api<{ notes: NoteSummary[] }>(
    bearer,
    'GET',
    `/os/notes?folderId=${folderId}&limit=200`
  );
  return res.notes ?? [];
}

export async function createNote(
  bearer: string,
  args: { title: string; content: string; folderId?: number }
): Promise<{ success: boolean; result?: { note?: { id?: number } }; note?: { id?: number } }> {
  return api(bearer, 'POST', '/os/notes', args);
}

export async function createNoteAndGetId(
  bearer: string,
  args: { title: string; content: string; folderId?: number }
): Promise<number> {
  const created = await createNote(bearer, args);
  const noteId = created.result?.note?.id ?? created.note?.id;
  if (typeof noteId !== 'number') {
    throw new Error(`Aicoo created "${args.title}" without returning its note id.`);
  }
  return noteId;
}

export async function findNoteInFolder(
  bearer: string,
  folderId: number,
  title: string
): Promise<NoteSummary | null> {
  return (await listNotesByFolderId(bearer, folderId)).find((note) => note.title === title) ?? null;
}

/**
 * Aicoo stores note bodies as rich-text HTML. Collapse block tags to
 * newlines and strip the rest so app-level parsers see plain text again.
 */
export function noteHtmlToText(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|tr|div|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getNote(bearer: string, noteId: number): Promise<string> {
  const res = await api<{ result: unknown }>(bearer, 'GET', `/os/notes/${noteId}`);
  // Tool results come back as { success, note: { content } } — sometimes
  // pre-serialized as a JSON string.
  let result: unknown = res.result ?? res;
  if (typeof result === 'string') {
    const raw: string = result;
    try {
      result = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  const note = (result as { note?: { content?: string }; content?: string }) ?? {};
  const html = note.note?.content ?? note.content ?? '';
  return noteHtmlToText(html);
}

export async function editNote(
  bearer: string,
  noteId: number,
  args: { content?: string; title?: string }
): Promise<unknown> {
  return api(bearer, 'PATCH', `/os/notes/${noteId}`, args);
}

/** Find a note by exact title within a folder; create it if missing. */
export async function upsertNote(
  bearer: string,
  folderPath: string,
  title: string,
  content: string
): Promise<number> {
  const folderId = await ensureFolder(bearer, folderPath);
  const existing = await findNoteInFolder(bearer, folderId, title);

  if (existing) {
    await editNote(bearer, existing.id, { content });
    return existing.id;
  }

  return createNoteAndGetId(bearer, { title, content, folderId });
}

// ─── Snapshots (proof log) ──────────────────────────────────────────

export async function saveSnapshot(
  bearer: string,
  noteId: number,
  label: string
): Promise<unknown> {
  return api(bearer, 'POST', `/os/snapshots/${noteId}`, { label });
}

export async function listSnapshots(bearer: string, noteId: number): Promise<unknown> {
  return api(bearer, 'GET', `/os/snapshots/${noteId}?limit=50`);
}

// ─── Scoped share links & anonymous guest agent ────────────────────

export async function createShareLink(
  bearer: string,
  args: {
    folderId: number;
    label: string;
    linkPolicy: string;
    noteId?: number;
    expiresIn?: string;
    requireSignIn?: boolean;
    allowedTools?: string[];
  }
): Promise<{ id: string; token: string; agentUrl: string }> {
  const res = await api<{
    shareLink: { id: string; token: string; agentUrl?: string; url: string };
  }>(bearer, 'POST', '/os/share', {
    scope: 'folders',
    access: 'read',
    notesAccess: 'read',
    folderIds: [args.folderId],
    ...(args.noteId ? { noteId: args.noteId } : {}),
    label: args.label,
    expiresIn: args.expiresIn ?? '7d',
    requireSignIn: args.requireSignIn ?? true,
    identity: { loadCoo: false, loadUser: false, loadPolicy: false },
    email: { read: false },
    todos: { read: false, create: false },
    tools: { allowedTools: args.allowedTools ?? [] },
    linkPolicy: args.linkPolicy,
  });
  return {
    id: String(res.shareLink.id),
    token: res.shareLink.token,
    agentUrl: res.shareLink.agentUrl ?? res.shareLink.url,
  };
}

export async function revokeShareLink(bearer: string, linkId: string): Promise<void> {
  await api(bearer, 'DELETE', `/os/share/${encodeURIComponent(linkId)}`);
}

export interface GuestAgentReply {
  sessionKey: string;
  agentName: string;
  ownerName: string;
  response: string;
  elapsedMs?: number;
}

/**
 * Invoke a server-held, unlisted share capability without an Authorization
 * header. This is intentional for Virtual N1 Fighter sessions: guest-v04
 * currently attaches owner↔guest relationship memory whenever the caller is
 * authenticated, even when every declared link capability is denied.
 *
 * The token must stay server-side. The link itself is read-only, restricted to
 * one synthetic Fighter folder, short-lived, and contains no user identity
 * files or integration capabilities. Aicoo ignores caller-provided session
 * keys for anonymous guests, so callers must use a fresh token per encounter.
 */
export async function messageAnonymousScopedAgent(args: {
  token: string;
  message: string;
}): Promise<GuestAgentReply> {
  return aicooJson(null, 'POST', '/api/chat/guest-v04', {
    token: args.token,
    message: args.message,
    stream: false,
    mode: 'agent',
  });
}
