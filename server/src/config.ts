/** BFF configuration. Credentials and connection details come from env. */
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

const sessionSecret = required(
  'SESSION_SECRET',
  process.env.NODE_ENV === 'production' ? undefined : 'agent-fights-dev-secret-change-me'
);

export const config = {
  /** Aicoo deployment this app runs against. */
  aicooBaseUrl: (process.env.AICOO_BASE_URL ?? 'https://www.aicoo.io').replace(/\/$/, ''),

  /** Pre-registered confidential OAuth client credentials. */
  clientId: process.env.AICOO_CLIENT_ID ?? '',
  clientSecret: process.env.AICOO_CLIENT_SECRET ?? '',

  port: Number(process.env.PORT ?? 8787),
  publicUrl: (process.env.BFF_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(
    /\/$/,
    ''
  ),
  spaUrl: (process.env.SPA_URL ?? 'http://localhost:3000').replace(/\/$/, ''),

  /** Secret for encrypting the session cookie (any long random string). */
  sessionSecret,

  /** Secret for opaque player ids. Use a separate value in production. */
  arenaSecret: required(
    'ARENA_SECRET',
    process.env.NODE_ENV === 'production' ? undefined : sessionSecret
  ),

  /** Operator Aicoo account API key — owns the roster and proof ledger. */
  operatorApiKey: process.env.AICOO_OPERATOR_API_KEY ?? '',

  /**
   * The town's single model configuration. EVERY agent-facing call — target
   * selection, decisions, conversation, memory, relationship updates, story
   * threads, feed summaries — goes through this. Never hardcode a model
   * anywhere else.
   */
  model: {
    /**
     * The town's model, served through Aicoo's own /api/v1/chat, so every turn
     * is a real Aicoo agent execution rather than a side-channel to another
     * provider. Defaults to Aicoo Standard ("default"), which every account can
     * run — the whole town works, not just Grok-enabled accounts. Set
     * TOWN_MODEL="grok-4" for accounts with Grok access (Pro/Business or BYOK).
     */
    provider: 'aicoo' as const,
    name: process.env.TOWN_MODEL ?? process.env.GROK_MODEL ?? 'default',
    /** Optional direct-to-xAI fallback. When empty, calls go through Aicoo. */
    apiKey: process.env.XAI_API_KEY ?? process.env.GROK_API_KEY ?? '',
    baseUrl: (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, ''),
    timeoutMs: Number(process.env.GROK_TIMEOUT_MS ?? 90_000),
    maxRetries: Number(process.env.GROK_MAX_RETRIES ?? 2),
  },

  /** Hard cap on real conversation turns per agent per calendar day. */
  dailyTurnBudget: Number(process.env.TOWN_DAILY_TURNS ?? 100),
};

export const oauthPaths = {
  authorize: `${config.aicooBaseUrl}/api/auth/oauth2/authorize`,
  token: `${config.aicooBaseUrl}/api/auth/oauth2/token`,
  register: `${config.aicooBaseUrl}/api/auth/oauth2/register`,
  userinfo: `${config.aicooBaseUrl}/api/auth/oauth2/userinfo`,
  revoke: `${config.aicooBaseUrl}/api/auth/oauth2/revoke`,
};

export const redirectUri = process.env.AICOO_REDIRECT_URI ?? `${config.publicUrl}/auth/callback`;

/** RFC 8707 resource: makes Aicoo mint a JWT access token audienced to /api/v1. */
export const v1Resource = `${config.aicooBaseUrl}/api/v1`;

/**
 * For Agent Fights, login only proves who owns the public Fighter — synthetic
 * capsules and encounter links live in the dedicated operator account, so the
 * OIDC scopes below were enough.
 *
 * 相亲小镇 is decentralised on purpose: an agent's persona, memory, and
 * relationships live in ITS OWNER's workspace, written with that owner's own
 * bearer. That means the os.* scopes are required — Aicoo gates /api/v1/os/*
 * on them and returns 403 insufficient_scope otherwise:
 *   os.notes:read   GET  /os/folders, /os/notes, /os/notes/{id}
 *   os.notes:write  POST /os/folders, POST /os/notes, PATCH /os/notes/{id}
 *   os.share:write  POST /os/share   (the agent's scoped share link)
 *
 * Aicoo allows these but never grants them by default — an app must ask for
 * them explicitly. Changing this list changes what the consent screen asks
 * for, so existing sessions keep their old, narrower grant until the user
 * signs out and re-consents; a token refresh does NOT widen scope.
 */
export const APP_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'os.notes:read',
  'os.notes:write',
  'os.share:write',
] as const;
