/**
 * Stateless session: an encrypted JWE cookie. No server-side session store —
 * the cookie carries the Aicoo OAuth credentials.
 */
import { EncryptJWT, jwtDecrypt } from 'jose';
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';

const SESSION_COOKIE = 'af_session';
const FLOW_COOKIE = 'af_oauth_flow';

const key = createHash('sha256').update(config.sessionSecret).digest();

export interface Session {
  authType: 'oauth';
  /** Canonical Aicoo user id from the OIDC UserInfo response. */
  sub: string;
  username?: string;
  displayName?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when accessToken expires. */
  accessTokenExpiresAt?: number;
}

/** Short-lived state for the authorize→callback dance. */
export interface OAuthFlowState {
  state: string;
  codeVerifier: string;
  /** Validated same-origin SPA route to restore after the provider callback. */
  returnTo?: string;
}

async function encrypt(payload: object, expiresIn: string): Promise<string> {
  return new EncryptJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .encrypt(key);
}

async function decrypt<T>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtDecrypt(token, key);
    return payload as T;
  } catch {
    return null;
  }
}

export async function setSession(c: Context, session: Session): Promise<void> {
  setCookie(c, SESSION_COOKIE, await encrypt(session, '30d'), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: config.publicUrl.startsWith('https'),
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function getSession(c: Context): Promise<Session | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  return decrypt<Session>(raw);
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function setFlowState(c: Context, flow: OAuthFlowState): Promise<void> {
  setCookie(c, FLOW_COOKIE, await encrypt(flow, '10m'), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: config.publicUrl.startsWith('https'),
    maxAge: 600,
  });
}

export async function consumeFlowState(c: Context): Promise<OAuthFlowState | null> {
  const raw = getCookie(c, FLOW_COOKIE);
  if (!raw) return null;
  deleteCookie(c, FLOW_COOKIE, { path: '/' });
  return decrypt<OAuthFlowState>(raw);
}
