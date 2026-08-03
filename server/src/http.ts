/**
 * What every route needs before it can be a route.
 *
 * These lived in `index.ts` alongside the routes that used them, which was fine
 * while there was one file. There are two route families now — the Fighter world
 * and the square — and the square is being lifted into its own module, so the
 * pieces they share have to sit somewhere neither owns.
 *
 * Nothing here knows about either game. That is the test for whether something
 * belongs on this page.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getSession, setSession, type Session } from './session.js';
import { refreshTokens } from './oauth.js';

/** The one error shape the API speaks. */
export function jsonError(c: Context, status: number, message: string) {
  return c.json({ error: true, message }, status as ContentfulStatusCode);
}

/**
 * The caller's Aicoo bearer, refreshed if it is about to expire.
 *
 * The session is a stateless encrypted cookie, so this is the only place a
 * usable access token exists for a signed-in player. Access tokens last fifteen
 * minutes and are refreshed within a minute of expiry rather than on failure,
 * which keeps a slow request from racing its own credential.
 *
 * Returns null rather than throwing: not signed in and refresh-was-rejected are
 * the same answer to a route — this caller cannot act.
 */
export async function resolveBearer(c: Context): Promise<{
  bearer: string;
  session: Session;
} | null> {
  const session = await getSession(c);
  if (!session) return null;

  if (session.authType === 'oauth' && session.accessToken) {
    const stale =
      !session.accessTokenExpiresAt || session.accessTokenExpiresAt - Date.now() < 60_000;
    if (!stale) return { bearer: session.accessToken, session };

    if (!session.refreshToken) return null;
    try {
      const tokens = await refreshTokens(session.refreshToken);
      const updated: Session = {
        ...session,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
      };
      await setSession(c, updated);
      return { bearer: updated.accessToken!, session: updated };
    } catch {
      console.warn('[auth] refresh failed.');
      return null;
    }
  }

  return null;
}

/** `resolveBearer`, but as a guard — returns the 401 for a route to return. */
export async function requireBearer(
  c: Context
): Promise<{ bearer: string; session: Session } | Response> {
  const resolved = await resolveBearer(c);
  if (!resolved) return jsonError(c, 401, 'Not signed in (or session expired).');
  return resolved;
}
