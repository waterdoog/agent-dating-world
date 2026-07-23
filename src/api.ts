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
  tension: number;
  note: string;
  at?: number;
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
  },
};

export function loginWithAicooUrl(returnTo = '/'): string {
  const query = new URLSearchParams({ return_to: returnTo });
  return `/auth/login?${query.toString()}`;
}
