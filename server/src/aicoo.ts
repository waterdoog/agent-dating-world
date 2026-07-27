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
    message?: string,
    public retryAfterMs?: number
  ) {
    super(message ?? `Aicoo API error ${status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Parse the standard Retry-After response header. Aicoo may return either a
 * number of seconds or an HTTP date, so normalize both forms for callers.
 */
export function parseRetryAfterMs(
  retryAfter: string | null,
  nowMs = Date.now()
): number | undefined {
  const value = retryAfter?.trim();
  if (!value) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1_000) : undefined;
  }

  const retryAtMs = Date.parse(value);
  return Number.isFinite(retryAtMs)
    ? Math.max(0, retryAtMs - nowMs)
    : undefined;
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
    throw new AicooError(
      res.status,
      text,
      undefined,
      parseRetryAfterMs(res.headers.get('retry-after'))
    );
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
  if (!res.ok) {
    throw new AicooError(
      res.status,
      text,
      undefined,
      parseRetryAfterMs(res.headers.get('retry-after'))
    );
  }
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

// ─── Identity ───────────────────────────────────────────────────────

export interface AicooIdentity {
  success: boolean;
  profile: {
    userId: string;
    username: string | null;
    name: string;
    agentName: string | null;
    email: string | null;
  };
}

/** Validate a bearer credential and resolve the caller's Aicoo identity. */
export async function getIdentity(bearer: string): Promise<AicooIdentity> {
  return api(bearer, 'GET', '/identity');
}

// ─── Own-COO chat (turn composition) ────────────────────────────────

export interface CooChatReply {
  conversationId: string;
  response: string;
}

/** Ask the caller's own COO to compose a turn. */
export async function cooChat(
  bearer: string,
  message: string,
  conversationId?: string
): Promise<CooChatReply> {
  const res = await api<CooChatReply & { type?: string; error?: string; message?: string }>(
    bearer,
    'POST',
    '/chat',
    { message, stream: false, ...(conversationId ? { conversationId } : {}) }
  );
  // Aicoo returns HTTP 200 with an error-shaped body for things like quota
  // exhaustion — surface it instead of handing back an undefined response.
  if (res.type === 'error') {
    throw new AicooError(402, JSON.stringify(res), res.message || res.error || 'Aicoo COO error');
  }
  return res;
}

// ─── Agent messaging ────────────────────────────────────────────────

export interface AgentReply {
  success: boolean;
  mode?: string;
  agentName?: string;
  ownerName?: string;
  response: string | null;
  conversationId?: number;
}

export async function messageAgent(
  bearer: string,
  to: string,
  message: string,
  intent: 'query' | 'inform' = 'query'
): Promise<AgentReply> {
  return api(bearer, 'POST', '/agent/message', { to, message, intent });
}

// ─── Scoped share links & signed-in guest agent ────────────────────

export interface ShareLinkSummary {
  id: string;
  agentUrl: string;
  label: string | null;
  scope?: string;
  access?: string;
  notesAccess?: string;
  requireSignIn: boolean;
  isActive: boolean;
  expiresAt: string | null;
  identity?: { loadCoo?: boolean; loadUser?: boolean; loadPolicy?: boolean };
}

export async function listShareLinks(bearer: string): Promise<ShareLinkSummary[]> {
  const res = await api<{ links?: ShareLinkSummary[] }>(
    bearer,
    'GET',
    '/os/share/list?status=active&limit=50'
  );
  return res.links ?? [];
}

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
    shareLink: {
      id: string;
      token: string;
      agentUrl?: string;
      url: string;
      requireSignIn?: boolean;
      requireSignInForced?: boolean;
    };
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
  if (
    args.requireSignIn === false &&
    (res.shareLink.requireSignIn !== false ||
      res.shareLink.requireSignInForced === true)
  ) {
    await api(
      bearer,
      'DELETE',
      `/os/share/${encodeURIComponent(String(res.shareLink.id))}`
    ).catch(() => undefined);
    throw new AicooError(
      403,
      'Aicoo did not grant an anonymous isolated Fighter capability.'
    );
  }
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

export interface GuestAgentStreamDelta {
  delta: string;
  response: string;
}

/**
 * Authenticated, folder-scoped guest turn. Unlike the anonymous variant below,
 * the caller supplies its own bearer, so Aicoo runs the turn against that
 * account's workspace and honours a caller-supplied session key — which is what
 * 相亲小镇 needs for an agent to answer in its own owner's COO across turns.
 */
export async function messageScopedAgent(
  bearer: string,
  args: { token: string; message: string; sessionKey?: string }
): Promise<GuestAgentReply> {
  return aicooJson(bearer, 'POST', '/api/chat/guest-v04', {
    token: args.token,
    message: args.message,
    stream: false,
    mode: 'agent',
    ...(args.sessionKey ? { sessionKey: args.sessionKey } : {}),
  });
}

interface GuestAgentStreamEvent {
  type?: string;
  textDelta?: string;
  content?: string;
  sessionKey?: string;
  agentName?: string;
  ownerName?: string;
  error?: string;
  message?: string;
  metadata?: { elapsedMs?: number; terminationReason?: string };
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
  const reply = await aicooJson<unknown>(null, 'POST', '/api/chat/guest-v04', {
    token: args.token,
    message: args.message,
    stream: false,
    mode: 'agent',
  });
  if (
    typeof reply !== 'object' ||
    reply === null ||
    typeof (reply as Record<string, unknown>).sessionKey !== 'string' ||
    typeof (reply as Record<string, unknown>).agentName !== 'string' ||
    typeof (reply as Record<string, unknown>).ownerName !== 'string' ||
    typeof (reply as Record<string, unknown>).response !== 'string' ||
    !(reply as Record<string, string>).response.trim()
  ) {
    throw new AicooError(502, 'Aicoo returned an invalid Fighter response.');
  }
  return reply as GuestAgentReply;
}

/**
 * Streams the same anonymous, folder-scoped guest runtime as
 * messageAnonymousScopedAgent. Aicoo labels the response text/event-stream,
 * but the wire format is newline-delimited JSON rather than `data:` SSE.
 *
 * The complete response is still returned so callers can validate, persist,
 * and score only after Aicoo emits a successful terminal response.
 */
export async function streamAnonymousScopedAgent(args: {
  token: string;
  message: string;
  onDelta?: (
    event: GuestAgentStreamDelta
  ) => void | Promise<void>;
}): Promise<GuestAgentReply> {
  const startedAt = Date.now();
  const res = await fetch(`${config.aicooBaseUrl}/api/chat/guest-v04`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: args.token,
      message: args.message,
      stream: true,
      mode: 'agent',
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    throw new AicooError(
      res.status,
      await res.text(),
      undefined,
      parseRetryAfterMs(res.headers.get('retry-after'))
    );
  }
  if (!res.body) {
    throw new AicooError(502, '', 'Aicoo returned an empty Fighter stream.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let streamedResponse = '';
  let legacyResponse = '';
  let sessionKey = '';
  let agentName = 'Virtual N1 Fighter';
  let ownerName = 'Virtual N1 World';
  let elapsedMs: number | undefined;
  let streamError = '';
  let completed = false;

  const acceptEvent = async (event: GuestAgentStreamEvent): Promise<void> => {
    if (typeof event.sessionKey === 'string' && event.sessionKey) {
      sessionKey = event.sessionKey;
    }
    if (typeof event.agentName === 'string' && event.agentName) {
      agentName = event.agentName;
    }
    if (typeof event.ownerName === 'string' && event.ownerName) {
      ownerName = event.ownerName;
    }
    if (event.type === 'text-delta' && typeof event.textDelta === 'string') {
      streamedResponse += event.textDelta;
      await args.onDelta?.({
        delta: event.textDelta,
        response: streamedResponse,
      });
      return;
    }
    // guest-v04 currently emits a duplicate legacy `content` event after each
    // text delta. Retain it only as a fallback for older deployments.
    if (!event.type && typeof event.content === 'string') {
      legacyResponse += event.content;
    }
    if (event.type === 'error') {
      streamError =
        (typeof event.message === 'string' && event.message) ||
        (typeof event.error === 'string' && event.error) ||
        'Aicoo Fighter stream failed.';
    }
    if (
      event.type === 'completion' &&
      typeof event.metadata?.elapsedMs === 'number'
    ) {
      elapsedMs = event.metadata.elapsedMs;
    }
    if (event.type === 'completion') {
      // Agent v0.4 has several terminal-but-unsuccessful outcomes
      // (timeouts, step/error limits, cancellation, and stuck recovery).
      // Only its explicit success reason is safe to persist as a game turn.
      if (event.metadata?.terminationReason === 'complete') {
        completed = true;
      } else {
        streamError = 'Aicoo Fighter stream did not complete successfully.';
      }
    }
  };

  const acceptLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      await acceptEvent(JSON.parse(trimmed) as GuestAgentStreamEvent);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new AicooError(
          502,
          trimmed,
          'Aicoo returned an invalid Fighter stream event.'
        );
      }
      throw error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) await acceptLine(line);
  }
  buffered += decoder.decode();
  await acceptLine(buffered);

  if (streamError) throw new AicooError(502, streamError, streamError);
  if (!completed) {
    throw new AicooError(
      502,
      '',
      'Aicoo Fighter stream ended before completion.'
    );
  }
  const response = (streamedResponse || legacyResponse).trim();
  if (!sessionKey || !response) {
    throw new AicooError(502, '', 'Aicoo returned an invalid Fighter stream.');
  }
  if (!streamedResponse && legacyResponse) {
    await args.onDelta?.({ delta: response, response });
  }

  return {
    sessionKey,
    agentName,
    ownerName,
    response,
    elapsedMs: elapsedMs ?? Date.now() - startedAt,
  };
}
