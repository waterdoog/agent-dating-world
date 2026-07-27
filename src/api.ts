export interface Me {
  signedIn: boolean;
  authType?: 'oauth' | 'api-key';
  username?: string | null;
  displayName?: string | null;
}

export type VaultSlotId = 'signal' | 'hideout' | 'relic';

export interface ArenaPlayer {
  id: string;
  handle: string;
  displayName: string;
  joinedAt: string;
  score: number;
  shields: number;
  defeated: boolean;
  isSelf: boolean;
  slots: Array<{
    id: VaultSlotId;
    label: string;
    captured: boolean;
    capturedBySelf: boolean;
  }>;
}

export interface ArenaView {
  game: 'agent-fights';
  enrolled: boolean;
  me: ArenaPlayer | null;
  opponents: ArenaPlayer[];
  leaderboard: ArenaPlayer[];
  limits: {
    attacksPerOpponent: number;
    verificationAttemptsPerOpponent: number;
  };
}

export interface AttackResult {
  attackerLine: string;
  defenderLine: string;
  attackerConversationId?: string;
  defenderSessionKey: string;
  attacksRemaining: number;
  elapsedMs?: number;
}

export interface VerifyResult {
  correct: boolean;
  capturedSlot?: { id: VaultSlotId; label: string };
  attemptsRemaining: number;
  arena: ArenaView;
}

export interface DatingLook {
  form: string;
  color: string;
  mood?: string;
  accessory?: string;
  seed?: string;
  avatar?: string;
}

export interface ReleaseInput {
  name: string;
  publicIntroduction: string;
  relationshipStyle: string;
  traits: string[];
  dimensions: { honesty: number; attachment: number; aggression: number; disclosure: number };
  summary: string;
  memory: { source: string; publicBackground: string; hiddenMemories: string[] };
  look: DatingLook;
}

export interface PublicAgent {
  handle: string;
  name: string;
  ownerSub: string;
  look: DatingLook;
  loveStyle: string;
  oneline: string;
}

export interface DatingTickEvent {
  actor: string;
  target: string;
  move: string;
  message: string;
  reply: string;
  attraction: number;
  trust?: number;
  tension: number;
  note: string;
  severity?: 'ambient' | 'relationship' | 'drama';
  headline?: string;
  summary?: string;
  consequence?: string;
  followup?: string;
  decideRunId?: string;
  replyRunId?: string;
  turnsLeft?: number;
  status?: string;
  at?: number;
}

export interface StoryThreadInfo {
  id: string;
  cast: string[];
  title: string;
  arc: string;
  openQuestion: string;
  runId?: string;
  updatedAt: number;
  beats: Array<{
    actor: string; target: string; move: string; headline: string;
    message: string; reply: string;
    attraction: number; trust: number; tension: number; at: number;
  }>;
}

export interface WorldDigestInfo {
  lines: Array<{ headline: string; shift: string; detail: string }>;
  runId?: string;
  at: number;
}

export interface YearbookInfo {
  agent: string;
  year: number;
  headline: string;
  story: string;
  verdicts: Array<{ who: string; line: string }>;
  dramas: string[];
  stillWaiting: string;
  spent: Array<{ target: string; turns: number }>;
  runId?: string;
  at: number;
}

export interface ModelRunInfo {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  agent?: string;
  input: string;
  output: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  status: string;
  error?: string;
  attempts: number;
  elapsedMs: number;
  at: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data?.message ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  apiKeyLogin: (apiKey: string) =>
    request<{ ok: boolean; username?: string }>('POST', '/auth/apikey', { apiKey }),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
  arena: () => request<ArenaView>('GET', '/api/fights'),
  joinArena: () => request<ArenaView>('POST', '/api/fights/join'),
  attack: (input: {
    targetId: string;
    tactic: string;
    attackerConversationId?: string;
    defenderSessionKey?: string;
    previousDefenderReply?: string;
  }) => request<AttackResult>('POST', '/api/fights/attack', input),
  verify: (targetId: string, guess: string) =>
    request<VerifyResult>('POST', '/api/fights/verify', { targetId, guess }),
  dating: {
    square: () => request<{ agents: PublicAgent[] }>('GET', '/api/dating/square'),
    mine: () => request<{ agent: PublicAgent | null }>('GET', '/api/dating/mine'),
    release: (input: ReleaseInput) => request<{ agent: PublicAgent }>('POST', '/api/dating/release', input),
    tick: () => request<{ event: DatingTickEvent | null; note?: string }>('POST', '/api/dating/tick'),
    encounter: (target: string) => request<{ event: DatingTickEvent | null }>('POST', '/api/dating/encounter', { target }),
    feed: () => request<{ events: DatingTickEvent[] }>('GET', '/api/dating/feed'),
    run: (id: string) => request<{ run: ModelRunInfo }>('GET', `/api/dating/runs?id=${encodeURIComponent(id)}`),
    threads: () => request<{ threads: StoryThreadInfo[]; digest: WorldDigestInfo | null }>('GET', '/api/dating/threads'),
    yearbooks: () => request<{ yearbooks: YearbookInfo[] }>('GET', '/api/dating/yearbooks'),
    budget: () => request<{ dailyTurnBudget: number; agents: Array<{ agent: string; used: number; left: number; top?: string }> }>('GET', '/api/dating/budget'),
  },
};

export function loginWithAicooUrl(returnTo = '/'): string {
  const query = new URLSearchParams({ return_to: returnTo });
  return `/auth/login?${query.toString()}`;
}
