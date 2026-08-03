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
import { AicooError, getIdentity } from './aicoo.js';
import { authResultUrl, normalizeReturnTo } from './auth-redirect.js';
import { jsonError, requireBearer, resolveBearer } from './http.js';
import { config } from './config.js';
import {
  DatabaseUnavailableError,
  FighterRateLimitError,
  ensureFighterUser,
  readFighterProfile,
  readN1CreditLeaderboard,
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
  leaveFighterWorldQueue,
  playFighterWorldAgain,
  readyFighterWorld,
  resumeFighterWorld,
  updateFighterWorldConfig,
  type FighterIdentity,
  type FighterReadyIntent,
  type FighterRuntimeEvent,
} from './fighter-world.js';
import { listSquare, listEvents, appendEvent, renewShare, isDeadCapability, type AgentCard } from './modules/dating/store.js';
import { readRels, type TickEvent } from './modules/dating/engine.js';
import { CredentialBook } from './modules/dating/engine-core.js';
import { startWorldLoop } from './modules/dating/scheduler.js';
import { datingRoutes } from './modules/dating/routes.js';
import { loadTownState, flushTownState } from './modules/dating/town-state.js';
import { isDatabaseConfigured } from './database/client.js';
import { releaseClaims, claimTurn, completeTurn } from './modules/dating/turn-lock.js';
import { storeCredential, forgetCredential, liveCredentials } from './modules/dating/credentials.js';
import { summariseWorld, rehydrateThreads } from './modules/dating/threads.js';
import { writeYearbook } from './modules/dating/yearbook.js';
import { recordEvent } from './modules/dating/records.js';
import { wantedLevel, falloutOf, npcNow } from './modules/dating/town-life.js';

// Stable API keys the world can act with (ownerSub → key), seeded from
// DATING_WORLD_KEYS at boot. Lets a target's REAL persona answer on its own COO.
const worldCreds = new Map<string, string>();

/**
 * Everything the world can currently act as — API keys plus the stored OAuth
 * credentials of players who signed in.
 *
 * The routes used to hand out `worldCreds` directly, which holds only the keys
 * pasted into DATING_WORLD_KEYS. The autonomy loop meanwhile built a merged map
 * including every signed-in player and kept it to itself, so a hand-driven turn
 * saw a strictly smaller town than a scheduled one: an agent whose owner had
 * signed in could act on its own schedule and yet be treated as credential-less
 * the moment its player pressed the button.
 *
 * One book, refreshed in place by the loop, read by everyone.
 */
let liveBook = new CredentialBook(worldCreds);

// The town digest is re-written from real threads, at most once every few
// minutes, using whichever account the world is running on.
/**
 * An agent whose share link has died gets a new one — not a retry loop.
 *
 * A capability that expires looks exactly like a turn that failed, and it stays
 * that way forever: 8586 identical 404s landed in a single day because nothing
 * distinguished "this turn did not work" from "this agent can no longer speak".
 * The signature is unambiguous, so treat it as what it is and re-mint.
 *
 * Minting a capability is a real action on the owner's account, so it is
 * bounded twice over: the hour is claimed, so only one process across the whole
 * town tries, and the claim is terminal, so a failure is not retried until the
 * next hour. Combined with the scheduler's failure throttle, a permanently dead
 * link costs one attempt an hour rather than one every round.
 */
async function maybeRenewShare(e: TickEvent): Promise<void> {
  if (!isDeadCapability(e.note ?? '')) return;
  // Whose capability actually failed. A beat can die on either side: the actor's
  // own decision call, or the reply, which runs on the TARGET's share link. This
  // looked only at the actor, so when Bravo's link was the dead one it renewed
  // SmokeCat's — spending the hour's single attempt on the agent that was fine
  // and never touching the one that was not.
  const replyFailed = (e.summary ?? '').startsWith('对方的回合');
  const whose = replyFailed ? e.target : e.actor;
  if (!whose) return;
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const card = roster.find((c) => c.name === whose);
  const bearer = card && liveBook.of(card);
  if (!card || !bearer) return;
  const hour = `share:${card.handle}:${Math.floor(Date.now() / 3_600_000)}`;
  if (!(await claimTurn(hour, 'share'))) return;
  try {
    await renewShare(bearer, card);
  } finally {
    await completeTurn(hour);
  }
}

const DIGEST_EVERY_MS = 9 * 60_000;   // keep the digest well clear of agent turns
/**
 * Write the town digest — once per window, across every process.
 *
 * This was a module-level timestamp, so each process ran its own digest on its
 * own schedule and overwrote the last one with a differently-worded version of
 * the same town. Claiming the window makes it one call by whoever gets there
 * first; `completeTurn` makes that terminal, so an expiring lease cannot let a
 * second process narrate the same window again.
 */
function maybeSummarise(): void {
  const bearer = worldCreds.values().next().value;
  if (!bearer) return;
  const window = `digest:${Math.floor(Date.now() / DIGEST_EVERY_MS)}`;
  void (async () => {
    if (!(await claimTurn(window, 'digest'))) return;
    try {
      // the narrator runs in an agent's sandbox too, so it never touches a personal chat
      const roster = await listSquare();
      await summariseWorld(bearer, roster[0]?.shareToken);
    } finally {
      await completeTurn(window);
    }
  })().catch(() => undefined);
}

// One world year = one real day. At each turn of the year every agent writes
// its own account of it — in its own voice, from what really happened.
const WORLD_EPOCH = Date.UTC(2026, 6, 23);
function worldYear(now = Date.now()): number {
  return Math.max(1, Math.floor(((now - WORLD_EPOCH) / 86_400_000) * 365 / 365) + 1);
}
/**
 * Close the year once, not once per process.
 *
 * `lastYearWritten` was a module-level number, so every process wrote every
 * agent's yearbook for the same year — each one a separate model call producing
 * a different account of the same twelve months. The claim is terminal, so the
 * year stays closed however many processes come and go.
 */
async function maybeCloseYear(): Promise<void> {
  const year = worldYear();
  if (!(await claimTurn(`yearbook:${year}`, 'yearbook'))) return;
  try {
    const roster = await listSquare().catch(() => [] as AgentCard[]);
    const events = (await listEvents().catch(() => [])) as unknown as TickEvent[];
    for (const card of roster) {
      const bearer = liveBook.of(card);
      if (!bearer) continue;
      await writeYearbook({
        agent: card.name,
        persona: card.persona || card.oneline || card.name,
        year: year - 1,
        rels: await readRels(bearer, card.name).catch(() => []),
        events,
        bearer,
        shareToken: card.shareToken,   // narrate inside the agent's own sandbox
      }).catch(() => undefined);
    }
  } finally {
    await completeTurn(`yearbook:${year}`);
  }
}

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

    // Keep the refresh token server-side so this player's agent keeps living
    // after they close the tab. Without it the world loop can only drive
    // accounts whose API key was pasted into DATING_WORLD_KEYS, which left most
    // of the town frozen. Deleted again on logout.
    if (tokens.refresh_token) {
      void storeCredential(info.sub, tokens.refresh_token, info.preferred_username, tokens.scope).catch(() => undefined);
    }

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
    // Consent withdrawn: the agent stops acting unattended.
    await forgetCredential(session.sub).catch(() => undefined);
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

app.get('/api/leaderboard', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const identity = fighterIdentityFor(auth);
  const user = fighterUserRecordForIdentity(identity);
  try {
    await ensureFighterUser(user);
    const leaderboard = await readN1CreditLeaderboard(
      user.id,
      c.req.query('limit')
    );
    c.header('Cache-Control', 'private, no-store');
    return c.json(leaderboard);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return jsonError(c, 503, error.message);
    }
    console.error('[leaderboard] database request failed.');
    return jsonError(c, 503, 'The N1 Credits leaderboard is temporarily unavailable.');
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
        agentLanguage: input.agentLanguage,
      })
    );
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/ready', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  let intent: FighterReadyIntent = { mode: 'random' };
  const rawBody = await c.req.text();
  if (rawBody.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonError(c, 400, 'Request body must be valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError(c, 400, 'A matchmaking mode is required.');
    }
    const input = body as Record<string, unknown>;
    if (input.mode === 'random') {
      intent = { mode: 'random' };
    } else if (input.mode === 'room' && input.action === 'create') {
      intent = { mode: 'room', action: 'create' };
    } else if (
      input.mode === 'room' &&
      input.action === 'join' &&
      typeof input.roomCode === 'string'
    ) {
      intent = { mode: 'room', action: 'join', roomCode: input.roomCode };
    } else {
      return jsonError(
        c,
        400,
        'Choose random matchmaking, create a room, or provide a room code to join.'
      );
    }
  }
  try {
    // Policies and the synthetic vault are persisted and snapshotted in
    // separate role folders before this Fighter can enter matchmaking. Room
    // reservation and pairing remain atomic inside the durable world lock.
    return c.json(await readyFighterWorld(fighterIdentityFor(auth), intent));
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/leave-queue', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    return c.json(await leaveFighterWorldQueue(fighterIdentityFor(auth)));
  } catch (error) {
    return worldError(c, error);
  }
});

app.post('/api/world/run', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const encoder = new TextEncoder();
  const identity = fighterIdentityFor(auth);
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const enqueue = (
        payload:
          | FighterRuntimeEvent
          | { type: 'world'; world: unknown }
          | {
              type: 'error';
              message: string;
              code?: 'aicoo_rate_limit';
              retryAfterMs?: number;
            }
      ) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        // The browser supplies no round text. It only observes whitelisted
        // provisional attack deltas while the server owns scheduling,
        // validation, persistence, and deterministic scoring.
        const world = await resumeFighterWorld(identity, (event) => enqueue(event));
        enqueue({ type: 'world', world });
      } catch (error) {
        let message = 'The server scheduler paused this match.';
        if (error instanceof FighterWorldError) message = error.message;
        else if (error instanceof FighterRateLimitError) message = error.message;
        else if (error instanceof AicooError && error.status === 429) {
          message = 'Aicoo is rate limiting the world. Try again shortly.';
          enqueue({
            type: 'error',
            message,
            code: 'aicoo_rate_limit',
            retryAfterMs: Math.min(
              24 * 60 * 60_000,
              Math.max(1_000, error.retryAfterMs ?? 30_000)
            ),
          });
          return;
        } else if (error instanceof AicooError) {
          message = 'Aicoo could not complete the isolated Fighter turn.';
        }
        enqueue({ type: 'error', message });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // The observing browser may have disconnected mid-round.
          }
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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

// ─── Agent Dating · 相亲角 ───────────────────────────────────────────
// Twenty-four routes, lifted into their own module. `book` is passed as an
// accessor rather than a value: the world loop replaces it whenever a player
// signs in or out, and a captured snapshot would leave the routes serving a
// smaller town than the loop — which this codebase has already done once.
app.route('/', datingRoutes({ book: () => liveBook }));


app.get('/api/health', (c) => c.json({ ok: true, service: 'virtual-n1-world' }));

app.all('/api/*', (c) => jsonError(c, 404, 'API route not found.'));
app.all('/auth/*', (c) => jsonError(c, 404, 'Auth route not found.'));

// A production process can serve the Vite build and BFF from one origin.
if (process.env.NODE_ENV === 'production' && isMainModule) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

/**
 * The town must outlive a bad minute.
 *
 * A Postgres read timeout surfaced as an unhandled rejection and killed the
 * whole BFF — every agent stopped, the feed froze, and the only symptom was a
 * dead port. Nothing in a long-running world simulation is worth taking the
 * process down for: a failed call is a beat that did not happen, which the
 * engine already knows how to report honestly.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[world] unhandled rejection (continuing):', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  // Except the one failure that means this process should not exist. Swallowing
  // EADDRINUSE turned a loud "the port is taken" into a silent second world
  // driver: thirty-one of them accumulated over three days, each one invisible
  // because none of them was serving HTTP, and together they drove one agent
  // 51 times inside a single round.
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`[world] port ${config.port} is already served by another process — exiting`);
    process.exit(1);
  }
  console.error('[world] uncaught exception (continuing):', error.message);
});

// Restore wanted levels and purses before anything can read them. Best-effort:
// a failure here starts the town clean rather than blocking the boot.
void loadTownState();
// Story threads and who-knows-what were module-level state, so they reset on
// every restart. Both rebuild from the event stream rather than needing tables.
void rehydrateThreads();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    // Whatever happens in here, this process is leaving. A shutdown step that
    // throws used to be caught by the global handler above and "continued",
    // which meant the process never exited and had to be force-killed after
    // five seconds — losing the town state flush it was in the middle of.
    const leave = () => process.exit(0);
    try {
      void releaseClaims()          // hand back in-flight turns, or the agents
        .catch(() => undefined)     // in them stand still until the lease lapses
        .then(() => flushTownState())
        .catch(() => undefined)
        .finally(leave);
    } catch {
      leave();
    }
    // A step that hangs must not hold the process open either.
    setTimeout(leave, 4_000).unref?.();
  });
}

if (isMainModule) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[virtual-n1-world] BFF listening on http://localhost:${info.port}`);
    console.log(`[virtual-n1-world] Aicoo backend: ${config.aicooBaseUrl}`);
  });
}

// The world's heartbeat — opt-in. Set DATING_WORLD_KEYS to a comma-separated list
// of aicoo API keys (the accounts whose agents should self-run) and the square
// runs on its own: every interval each agent wakes, decides, and acts. In prod
// this is fed by aicoo heartbeat (once os.heartbeat lands) or per-user stored keys.
/**
 * The world runs on the players' own OAuth credentials.
 *
 * `DATING_WORLD_KEYS` is now a fallback for accounts that never signed in
 * through the UI: anyone who has logged in has their refresh token stored
 * server-side (encrypted), so their agent keeps living after they close the tab.
 * Before this, only agents belonging to a pasted API key ever moved — four of
 * six agents in the town were permanently frozen, which biased every
 * behavioural signal the detectors produce.
 *
 * `isMainModule` gates it for the same reason `serve()` above does: importing
 * the BFF should not start a world. A serverless handler imports this file on
 * every cold start, and a resident loop inside a function that gets frozen
 * between invocations is not a heartbeat — it is an extra claimant. Correctness
 * no longer depends on this (each turn is claimed), but nothing should be doing
 * work it cannot finish.
 */
if (isMainModule && (process.env.DATING_WORLD_KEYS || isDatabaseConfigured())) {
  void (async () => {
    for (const key of (process.env.DATING_WORLD_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)) {
      try {
        const id = await getIdentity(key);
        // index under both identifiers so an agent released via OAuth is still
        // drivable by the world key for the same account
        worldCreds.set(id.profile.userId, key);
        if (id.profile.username) worldCreds.set(id.profile.username, key);
      } catch (error) {
        console.warn('[dating] world key rejected:', error instanceof Error ? error.message : error);
      }
    }

    // Access tokens expire in 15 minutes, so they are minted per round rather
    // than cached. A player who signed out, or whose refresh was rejected, is
    // simply absent from the map — their agent goes quiet instead of faking.
    const withOauth = async (): Promise<Map<string, string>> => {
      const merged = new Map(worldCreds);
      for (const cred of await liveCredentials().catch(() => [])) {
        merged.set(cred.sub, cred.bearer);
        if (cred.username) merged.set(cred.username, cred.bearer);
      }
      return merged;
    };

    const initial = await withOauth();
    if (!initial.size) {
      console.log('[dating] world loop idle — no world keys and nobody has opted in yet');
      return;
    }
    const intervalMs = Number(process.env.DATING_WORLD_INTERVAL_MS ?? 300_000);
    // Refreshed each round so a player who signs in mid-session joins the world
    // without a restart, and one who signs out drops out of it. Written into the
    // module-level book rather than a local, so the hand-driven routes see the
    // same town the loop does.
    liveBook = new CredentialBook(initial);
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, intervalMs));
        liveBook = await withOauth().then((m) => new CredentialBook(m)).catch(() => liveBook);
      }
    })();
    // Any number of processes may run this. Each round is claimed per agent in
    // the database before a model is called, so a second loop finds every turn
    // already taken and goes quiet — rather than doubling the town.
    console.log(`[dating] 🌍 world loop live · ${initial.size} identifier(s) · every ${intervalMs}ms`);
    startWorldLoop({
      creds: () => liveBook,
      roster: () => listSquare(),
      intervalMs,
      onEvent: (e) => {
        // `appendEvent` is the durable write — it is what puts the beat in
        // Postgres, where the feed, the trajectory detectors and the director
        // all query it by pair, by place and by time.
        appendEvent(e).catch((err) => console.warn('[town] appendEvent:', err?.message));
        void recordEvent(e).catch(() => undefined);      // durable in links/
        void maybeRenewShare(e);                          // a dead capability, not a bad turn
        maybeSummarise();                                 // throttled inside
        void maybeCloseYear().catch(() => undefined);
        console.log(`[dating] 🌀 ${e.actor} [${e.move}] → ${e.target} · a${e.attraction.toFixed(2)}/t${e.tension.toFixed(2)} — ${e.note}`);
      },
    });
  })();
}

export default app;
