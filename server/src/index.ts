/**
 * Virtual N1 World BFF. Each pair gets an isolated Fighter mini-game.
 *
 * Aicoo handles identity, scoped agent turns, notes, and snapshots. This
 * server keeps credentials out of the browser, owns encrypted durable drafts,
 * matchmaking, and round leases, and writes sanitized history to Postgres.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AicooError } from './aicoo.js';
import { authResultUrl, normalizeReturnTo } from './auth-redirect.js';
import { config } from './config.js';
import {
  DatabaseUnavailableError,
  FighterRateLimitError,
  ensureFighterUser,
  readFighterProfile,
} from './database/repository.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  makePkcePair,
  refreshTokens,
  revokeToken,
} from './oauth.js';
import {
  clearSession,
  consumeFlowState,
  getSession,
  setFlowState,
  setSession,
  type Session,
} from './session.js';
import {
  FighterWorldError,
  fighterUserRecordForIdentity,
  getFighterWorldSnapshot,
  joinFighterWorld,
  playFighterWorldAgain,
  readyFighterWorld,
  resumeFighterWorld,
  updateFighterWorldConfig,
  type FighterIdentity,
} from './fighter-world.js';

export const app = new Hono();
const isMainModule = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

app.use('*', cors({ origin: config.spaUrl, credentials: true }));
app.use('*', async (c, next) => {
  const contentLength = Number(c.req.header('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return jsonError(c, 413, 'Request body is too large.');
  }
  await next();
});

// ─── Session credential resolution (with silent refresh) ───────────

async function resolveBearer(c: Context): Promise<{
  bearer: string;
  session: Session;
} | null> {
  const session = await getSession(c);
  if (!session) return null;

  if (session.authType === 'oauth' && session.accessToken) {
    // 15-minute access tokens: refresh when within 60s of expiry.
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

function jsonError(c: Context, status: number, message: string) {
  return c.json({ error: true, message }, status as ContentfulStatusCode);
}

function worldError(c: Context, error: unknown) {
  if (error instanceof FighterWorldError) return jsonError(c, error.status, error.message);
  if (error instanceof DatabaseUnavailableError) {
    return jsonError(c, 503, error.message);
  }
  if (error instanceof FighterRateLimitError) {
    return jsonError(c, 429, error.message);
  }
  if (error instanceof AicooError) {
    console.warn(`[fighter-world] Aicoo request failed (${error.status}).`);
    if (error.status === 401) {
      return jsonError(c, 503, 'The isolated Fighter runtime credential is unavailable.');
    }
    if (error.status === 403) {
      return jsonError(c, 502, 'Aicoo rejected the isolated Fighter capability.');
    }
    if (error.status === 429) return jsonError(c, 429, 'Aicoo is rate limiting the world. Try again shortly.');
    return jsonError(c, 502, 'Aicoo could not complete the world request.');
  }
  // Driver/provider errors can carry connection or request metadata.
  console.error('[fighter-world] request failed.');
  return jsonError(c, 500, 'Virtual N1 World could not complete the request.');
}

async function requireBearer(c: Context): Promise<{ bearer: string; session: Session } | Response> {
  const resolved = await resolveBearer(c);
  if (!resolved) return jsonError(c, 401, 'Not signed in (or session expired).');
  return resolved;
}

// ─── Auth: Login with Aicoo ─────────────────────────────────────────

app.get('/auth/login', async (c) => {
  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = makePkcePair();
  await setFlowState(c, {
    state,
    codeVerifier: verifier,
    returnTo: normalizeReturnTo(c.req.query('return_to')),
  });
  return c.redirect(await buildAuthorizeUrl(state, challenge));
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const oauthError = c.req.query('error');

  const flow = await consumeFlowState(c);
  if (!state || !flow || flow.state !== state) {
    return jsonError(c, 400, 'OAuth state mismatch or missing code — restart login.');
  }

  if (oauthError) {
    return c.redirect(authResultUrl(config.spaUrl, flow.returnTo, { loginError: oauthError }));
  }

  if (!code) {
    return c.redirect(authResultUrl(config.spaUrl, flow.returnTo, { loginError: 'missing_code' }));
  }

  try {
    const tokens = await exchangeCode(code, flow.codeVerifier);
    const info = await fetchUserInfo(tokens.access_token);

    // OIDC UserInfo proves identity without touching the user's Aicoo
    // workspace or loading COO/USER/POLICY files.
    await setSession(c, {
      authType: 'oauth',
      sub: info.sub,
      username: info.preferred_username,
      displayName: info.name ?? info.preferred_username ?? 'Aicoo player',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
    });

    return c.redirect(authResultUrl(config.spaUrl, flow.returnTo, { login: 'ok' }));
  } catch {
    console.error('[auth] callback failed.');
    return c.redirect(
      authResultUrl(config.spaUrl, flow.returnTo, { loginError: 'token_exchange_failed' })
    );
  }
});

app.post('/auth/logout', async (c) => {
  const session = await getSession(c);
  if (session) {
    const tokens = [session.refreshToken, session.accessToken].filter(
      (token): token is string => Boolean(token)
    );
    await Promise.allSettled(tokens.map((token) => revokeToken(token)));
  }
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ signedIn: false });
  return c.json({
    signedIn: true,
    authType: session.authType,
    username: session.username ?? null,
    displayName: session.displayName ?? null,
  });
});

function fighterIdentityFor(auth: { session: Session }): FighterIdentity {
  return {
    subject: auth.session.sub,
    username: auth.session.username,
    displayName: auth.session.displayName,
  };
}

app.get('/api/profile', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const identity = fighterIdentityFor(auth);
  const user = fighterUserRecordForIdentity(identity);
  try {
    // Signup credit creation and profile-name refresh are idempotent.
    await ensureFighterUser(user);
    return c.json(await readFighterProfile(user.id));
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return jsonError(c, 503, error.message);
    }
    // Do not print driver errors: they can contain connection metadata.
    console.error('[profile] database request failed.');
    return jsonError(c, 503, 'Your persistent Fighter profile is temporarily unavailable.');
  }
});

// ─── Symmetric Virtual N1 Fighter World ────────────────────────────

app.get('/api/world', async (c) => {
  const session = await getSession(c);
  try {
    return c.json(
      await getFighterWorldSnapshot(
        session
          ? {
              subject: session.sub,
              username: session.username,
              displayName: session.displayName,
            }
          : null
      )
    );
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/join', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    // The user's bearer proves identity only. Join creates an encrypted
    // database draft; Aicoo is touched only when it is explicitly locked.
    return c.json(await joinFighterWorld(fighterIdentityFor(auth)));
  } catch (error) {
    return worldError(c, error);
  }
});

app.put('/api/world/config', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object') {
    return jsonError(c, 400, 'Attack and defense policies are required.');
  }
  const input = body as Record<string, unknown>;
  try {
    return c.json(
      await updateFighterWorldConfig(fighterIdentityFor(auth), {
        attackPolicy: input.attackPolicy,
        defensePolicy: input.defensePolicy,
      })
    );
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/ready', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    // Policies and the synthetic vault are persisted and snapshotted in
    // separate role folders before this Fighter can enter matchmaking.
    return c.json(await readyFighterWorld(fighterIdentityFor(auth)));
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/run', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    // The browser supplies no round text. It only asks the server scheduler
    // to claim or resume this player's current deterministic match.
    return c.json(await resumeFighterWorld(fighterIdentityFor(auth)));
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/play-again', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    return c.json(await playFighterWorldAgain(fighterIdentityFor(auth)));
  } catch (error) {
    return worldError(c, error);
  }
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'virtual-n1-world' }));

app.all('/api/*', (c) => jsonError(c, 404, 'API route not found.'));
app.all('/auth/*', (c) => jsonError(c, 404, 'Auth route not found.'));

// A production process can serve the Vite build and BFF from one origin.
if (process.env.NODE_ENV === 'production' && isMainModule) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

if (isMainModule) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[virtual-n1-world] BFF listening on http://localhost:${info.port}`);
    console.log(`[virtual-n1-world] Aicoo backend: ${config.aicooBaseUrl}`);
  });
}

export default app;
