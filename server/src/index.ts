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
import { listSquare, releaseAgent, updateAgent, readSpec, stampOwnerName, listEvents, appendEvent, type AgentCard, type LoveStyle } from './modules/dating/store.js';
import { runAgentTick, encounterWith, readRels, writeRels, type TickEvent } from './modules/dating/engine.js';
import { startWorldLoop } from './modules/dating/scheduler.js';
import { loadTownState, flushTownState, townStateHealth } from './modules/dating/town-state.js';
import { isDatabaseConfigured } from './database/client.js';
import { collectSignals } from './modules/dating/detectors.js';
import { turnHealth, releaseClaims, claimTurn, completeTurn } from './modules/dating/turn-lock.js';
import { storeCredential, forgetCredential, liveCredentials, credentialHealth } from './modules/dating/credentials.js';
import { recentRuns, runById } from './modules/dating/grok.js';
import { budgetSnapshot } from './modules/dating/budget.js';
import { listThreads, currentDigest, summariseWorld, recordKnowledge, knownTo, rehydrateThreads } from './modules/dating/threads.js';
import { writeYearbook, listYearbooks, yearbookFor } from './modules/dating/yearbook.js';
import { recordEvent } from './modules/dating/records.js';
import { requestFriend, friends, recall, searchMemory, memoryStats } from './modules/dating/memory.js';
import { NPCS, CRIMES, wantedLevel, commitCrime, clearWanted, wantedBoard, balance, spend, falloutOf, walletBalance, npcNow, reportPositions, resolveOffer} from './modules/dating/town-life.js';

// Stable API keys the world can act with (ownerSub → key), seeded from
// DATING_WORLD_KEYS at boot. Lets a target's REAL persona answer on its own COO.
const worldCreds = new Map<string, string>();

// The town digest is re-written from real threads, at most once every few
// minutes, using whichever account the world is running on.
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
      const bearer = worldCreds.get(card.ownerSub);
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

const LOVE_STYLES = ['open', 'exclusive', 'devoted', 'hunter', 'dependent', 'chaotic', 'strategic'];

/** Never leak the scoped-share token to the browser. */
function publicCard(card: AgentCard) {
  const { shareToken, ...rest } = card;
  void shareToken;
  return rest;
}

function datingError(c: Context, error: unknown) {
  if (error instanceof AicooError) {
    console.warn(`[dating] Aicoo request failed (${error.status}):`, error.body.slice(0, 300));
    if (error.status === 401) return jsonError(c, 401, 'Your Aicoo session expired. Sign in again.');
    if (error.status === 403) return jsonError(c, 403, 'Aicoo did not grant a required capability.');
    if (error.status === 429) return jsonError(c, 429, 'The square is busy. Try again shortly.');
    if (error.status === 402) return jsonError(c, 402, `Your agent's Aicoo COO is out of budget: ${error.message}`);
    return jsonError(c, 502, 'Aicoo could not complete the square request.');
  }
  console.error('[dating] request failed:', error);
  return jsonError(c, 500, 'The square could not complete the request.');
}

app.get('/api/dating/square', async (c) => {
  try {
    const cards = await listSquare();
    return c.json({ agents: cards.map(publicCard) });
  } catch (error) {
    return datingError(c, error);
  }
});

// Traceability: every town event carries the model run ids that produced it.
// These expose the run ledger and today's conversation budget behind them.
app.get('/api/dating/runs', (c) => {
  const id = c.req.query('id');
  if (id) {
    const run = runById(id);
    return run ? c.json({ run }) : jsonError(c, 404, 'No such model run.');
  }
  return c.json({
    provider: config.model.provider,
    model: config.model.name,
    runs: recentRuns(Number(c.req.query('limit') ?? 50)),
  });
});

app.get('/api/dating/budget', async (c) =>
  c.json({ dailyTurnBudget: config.dailyTurnBudget, agents: await budgetSnapshot() })
);

// Continuous story lines woven from real beats, plus the town digest.
app.get('/api/dating/yearbooks', (c) => {
  const agent = c.req.query('agent');
  const year = Number(c.req.query('year') ?? 0);
  if (agent && year) {
    const book = yearbookFor(agent, year);
    return book ? c.json({ yearbook: book }) : jsonError(c, 404, 'No yearbook for that agent and year.');
  }
  return c.json({ yearbooks: listYearbooks(Number(c.req.query('limit') ?? 20)) });
});

// ─── town life: NPCs, crime, wanted level, pocket money ───────────
app.get('/api/dating/town', async (c) => {
  const auth = await resolveBearer(c);
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = auth ? roster.find((r) => r.ownerSub === auth.session.sub) : undefined;
  return c.json({
    npcs: NPCS.map((n) => { const now = npcNow(n.id); return now ? { ...n, x: now.x, y: now.y, doing: now.doing } : n; }),
    crimes: Object.entries(CRIMES).map(([id, v]) => ({ id, ...v })),
    wanted: wantedBoard(),
    me: mine ? { name: mine.name, cash: await walletBalance(auth?.session.sub, mine.name), wanted: wantedLevel(mine.name) } : null,
  });
});

app.post('/api/dating/town/deal', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const npc = NPCS.find((n) => n.id === body.npc);
  const offer = npc?.offers.find((o) => o.id === body.offer);
  if (!npc || !offer) return jsonError(c, 404, 'No such offer.');
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = roster.find((r) => r.ownerSub === auth.session.sub);
  if (!mine) return jsonError(c, 404, 'Release an agent first.');
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (offer.kind === 'report' && !subject) return jsonError(c, 400, '要举报谁？');
  if (offer.cost > 0 && !spend(mine.name, offer.cost)) {
    return jsonError(c, 402, `不够钱：还差 ${offer.cost - balance(mine.name)}。`);
  }
  // The offer now RESOLVES against real world state instead of echoing a
  // sentence describing what it would have done.
  const events = (await listEvents().catch(() => [])) as Array<{ actor: string; target: string; act?: string; destination?: string; headline?: string }>;
  const result = await resolveOffer(offer.kind, mine.name, {
    events,
    knownToBuyer: knownTo(mine.name).map((k) => ({ about: k.about, fact: k.fact, source: k.source })),
    subject,
  });
  if (!result.ok) return jsonError(c, 400, '这笔买卖没做成。');
  if (offer.kind === 'plant-rumour') {
    const claim = typeof body.claim === 'string' ? body.claim.trim().slice(0, 160) : '';
    if (!claim) return jsonError(c, 400, '你要放出去的是什么消息？');
    for (const other of roster.filter((r) => r.name !== mine.name)) {
      recordKnowledge({ holder: other.name, about: subject || mine.name, fact: claim, source: '镇上传开的' });
    }
  }
  return c.json({
    ok: true, npc: npc.name, offer: offer.label,
    effect: result.fact ?? result.applied ?? offer.effect,
    cash: balance(mine.name), wanted: wantedLevel(mine.name),
  });
});

app.post('/api/dating/town/crime', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = roster.find((r) => r.ownerSub === auth.session.sub);
  if (!mine) return jsonError(c, 404, 'Release an agent first.');
  const crimeId = String(body.crime ?? '');
  const victimName = String(body.victim ?? '').trim();
  // Without a victim the fallout block below was dead code: the UI raised the
  // actor's own wanted level and nothing else ever happened. A crime has to land
  // on somebody.
  if (!victimName) return jsonError(c, 400, '要对谁下手？先选一个人。');
  const done = commitCrime(mine.name, crimeId, victimName || String(body.detail ?? ''));
  if (!done) return jsonError(c, 400, 'No such crime.');

  // A crime is only interesting if it lands on someone's feelings: apply the
  // fallout to the VICTIM's own relationship record, and let the town hear it.
  let fallout = null;
  const victim = roster.find((r) => r.name.toLowerCase() === victimName.toLowerCase());
  if (victim) {
    const f = falloutOf(crimeId, mine.name, victim.name);
    const victimKey = worldCreds.get(victim.ownerSub);
    if (f && victimKey) {
      const rels = await readRels(victimKey, victim.name).catch(() => []);
      const cur = rels.find((r) => r.handle.toLowerCase() === mine.name.toLowerCase());
      const next = rels.filter((r) => r.handle.toLowerCase() !== mine.name.toLowerCase());
      next.push({
        handle: mine.handle,
        attraction: Math.max(0, Math.min(1, (cur?.attraction ?? 0.3) + f.attractionDelta)),
        trust: Math.max(0, Math.min(1, (cur?.trust ?? 0.3) + f.trustDelta)),
        tension: Math.max(0, Math.min(1, (cur?.tension ?? 0.2) + f.tensionDelta)),
        note: f.rumour.slice(0, 60),
      });
      await writeRels(victimKey, victim.name, next).catch(() => undefined);
      // the town remembers, and the victim now KNOWS
      recordKnowledge({ holder: victim.name, about: mine.name, fact: f.rumour, source: '小镇上传开的' });
      const ev = {
        actor: mine.name, target: victim.name, move: 'CRIME', message: '', reply: '',
        attraction: 0, trust: 0, tension: 0, note: done.label,
        severity: 'drama' as const,
        headline: f.rumour,
        summary: `${mine.name} ${done.label}。${victim.name} 现在知道了，信任 ${f.trustDelta.toFixed(2)}、张力 +${f.tensionDelta.toFixed(2)}。`,
        consequence: 'a crime lands on someone who can feel it',
        followup: `${victim.name} 会当面质问，还是先按住不说？`,
        status: 'ok' as const,
      };
      await appendEvent(ev).catch(() => undefined);
      void recordEvent(ev as never).catch(() => undefined);
      fallout = f;
    }
  }
  return c.json({ ok: true, ...done, fallout });
});

// ─── relationship memory, kept in each owner's own Aicoo notes ────
app.get('/api/dating/memory', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = roster.find((r) => r.ownerSub === auth.session.sub);
  if (!mine) return jsonError(c, 404, 'Release an agent first.');
  const about = c.req.query('about');
  const q = c.req.query('q');
  if (q) return c.json({ hits: await searchMemory(auth.bearer, q) });
  if (about) return c.json({ agent: mine.name, about, memory: await recall(auth.bearer, mine.name, about) });
  const all = await Promise.all(
    roster.filter((r) => r.name !== mine.name)
      .map(async (r) => ({ about: r.name, memory: await recall(auth.bearer, mine.name, r.name, 300) }))
  );
  return c.json({ agent: mine.name, memories: all.filter((m) => m.memory) });
});

/**
 * Is memory actually working? Writes used to be fire-and-forget and reads
 * swallowed every error, so an empty memory folder looked identical to a
 * healthy one. This reports the raw counters.
 */
app.get('/api/dating/memory-health', (c) => c.json(memoryStats()));

/** Did the town's durable state survive the last restart? */
app.get('/api/dating/town-health', (c) => c.json(townStateHealth()));

/**
 * What the town noticed — behaviour the dialogue never shows: someone circling a
 * place without speaking, a pair going quiet, one person always opening, a gift
 * that was really bought. All measured from the event stream; nothing invented.
 */
app.get('/api/dating/signals', async (c) => c.json({ signals: await collectSignals() }));

/** How many agents can act unattended, and how many credentials went stale. */
app.get('/api/dating/autonomy-health', async (c) => c.json(await credentialHealth()));

/**
 * Whether the town is still acting twice.
 *
 * `duplicateRounds` is the number the whole claim mechanism exists to hold at
 * zero: agents that took more than one turn inside a single round in the last
 * day. It was 51 at its worst.
 */
app.get('/api/dating/turn-health', async (c) => c.json(await turnHealth()));

app.get('/api/dating/friends', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  return c.json({ friends: await friends(auth.bearer) });
});

app.post('/api/dating/friends', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!to) return jsonError(c, 400, 'Who do you want to befriend?');
  const ok = await requestFriend(auth.bearer, to);
  return ok ? c.json({ ok: true, to }) : jsonError(c, 502, 'Aicoo rejected the friend request.');
});

// the plaza reports where everyone is standing, so agents know who is nearby
app.post('/api/dating/positions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (Array.isArray(body.agents)) {
    reportPositions(
      body.agents
        .filter((a: unknown): a is { name: string; x: number; y: number } =>
          Boolean(a && typeof (a as { name?: unknown }).name === 'string')
        )
        .map((a: { name: string; x: number; y: number }) => ({ name: a.name, x: Number(a.x), y: Number(a.y) }))
    );
  }
  return c.json({ ok: true });
});

app.get('/api/dating/threads', (c) =>
  c.json({ threads: listThreads(Number(c.req.query('limit') ?? 12)), digest: currentDigest() })
);

app.get('/api/dating/feed', async (c) => {
  try {
    return c.json({ events: await listEvents() });
  } catch (error) {
    return datingError(c, error);
  }
});

app.get('/api/dating/mine', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    const ids = new Set([auth.session.sub, auth.session.username].filter(Boolean) as string[]);
    const mine = (await listSquare()).find((card) => ids.has(card.ownerSub)) ?? null;
    // Agents released before cards carried an account name are invisible to the
    // world loop, which can only resolve API-key identities. The signed-in
    // session is authoritative about who owns this one, so stamp it now.
    if (mine && !mine.ownerName && auth.session.username) {
      void stampOwnerName(mine.handle, auth.session.username).catch(() => undefined);
    }
    return c.json({ agent: mine ? publicCard(mine) : null });
  } catch (error) {
    return datingError(c, error);
  }
});

app.post('/api/dating/release', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 24) : '';
  if (!name) return jsonError(c, 400, 'Give your agent a name.');
  const look = body.look;
  if (!look || typeof look.form !== 'string' || typeof look.color !== 'string') {
    return jsonError(c, 400, 'Your agent needs an appearance.');
  }
  const relationshipStyle = (LOVE_STYLES.includes(body.relationshipStyle) ? body.relationshipStyle : 'open') as LoveStyle;
  const traits: string[] = Array.isArray(body.traits)
    ? body.traits.filter((t: unknown): t is string => typeof t === 'string').slice(0, 5)
    : [];
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));
  const dim = body.dimensions ?? {};
  const dimensions = { honesty: clamp(dim.honesty), attachment: clamp(dim.attachment), aggression: clamp(dim.aggression), disclosure: clamp(dim.disclosure) };
  const mem = body.memory ?? {};
  const memory = {
    source: typeof mem.source === 'string' ? mem.source : 'empty',
    publicBackground: typeof mem.publicBackground === 'string' ? mem.publicBackground.slice(0, 2000) : '',
    hiddenMemories: Array.isArray(mem.hiddenMemories)
      ? mem.hiddenMemories.filter((h: unknown): h is string => typeof h === 'string').slice(0, 12)
      : [],
  };
  const ids = new Set([auth.session.sub, auth.session.username].filter(Boolean) as string[]);
  const already = (await listSquare().catch(() => [] as AgentCard[])).find((c) => ids.has(c.ownerSub));
  if (already) {
    return jsonError(c, 409, `You already released ${already.name}. Edit it instead of releasing another.`);
  }
  try {
    const card = await releaseAgent(auth.bearer, auth.session.sub, {
      name,
      publicIntroduction: typeof body.publicIntroduction === 'string' ? body.publicIntroduction.slice(0, 120) : '',
      relationshipStyle,
      traits,
      dimensions,
      summary: typeof body.summary === 'string' ? body.summary.slice(0, 600) : '',
      memory,
      // keep the avatar the player picked — dropping it here made every new
      // agent fall back to the default cube figure
      look: {
        form: look.form,
        color: look.color,
        accessory: typeof look.accessory === 'string' ? look.accessory : 'none',
        seed: name,
        ...(typeof look.avatar === 'string' ? { avatar: look.avatar } : {}),
      },
    }, auth.session.username);
    return c.json({ agent: publicCard(card) });
  } catch (error) {
    return datingError(c, error);
  }
});

/** The structured spec behind the player's own agent, for prefilling the editor. */
app.get('/api/dating/mine/spec', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const ids = new Set([auth.session.sub, auth.session.username].filter(Boolean) as string[]);
  const mine = (await listSquare().catch(() => [] as AgentCard[])).find((card) => ids.has(card.ownerSub));
  if (!mine) return jsonError(c, 404, 'Release an agent first.');
  const spec = await readSpec(auth.bearer, mine.name);
  // Agents released before specs were kept have no spec.json; the editor falls
  // back to the card and says so rather than silently blanking fields.
  return c.json({ name: mine.name, spec, partial: !spec, card: publicCard(mine) });
});

/** Rewrite personality and appearance in place. Name and share token are fixed. */
app.post('/api/dating/mine/update', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const ids = new Set([auth.session.sub, auth.session.username].filter(Boolean) as string[]);
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = roster.find((card) => ids.has(card.ownerSub));
  if (!mine) return jsonError(c, 404, 'Release an agent first.');

  const body = await c.req.json().catch(() => ({}));
  const look = body.look;
  if (!look || typeof look.form !== 'string' || typeof look.color !== 'string') {
    return jsonError(c, 400, 'Your agent needs an appearance.');
  }
  const relationshipStyle = (LOVE_STYLES.includes(body.relationshipStyle) ? body.relationshipStyle : 'open') as LoveStyle;
  const traits: string[] = Array.isArray(body.traits)
    ? body.traits.filter((t: unknown): t is string => typeof t === 'string').slice(0, 5)
    : [];
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));
  const dim = body.dimensions ?? {};
  const mem = body.memory ?? {};
  try {
    const card = await updateAgent(auth.bearer, mine.ownerSub, {
      name: mine.name,                       // fixed: memory notes live under it
      publicIntroduction: typeof body.publicIntroduction === 'string' ? body.publicIntroduction.slice(0, 120) : '',
      relationshipStyle,
      traits,
      dimensions: { honesty: clamp(dim.honesty), attachment: clamp(dim.attachment), aggression: clamp(dim.aggression), disclosure: clamp(dim.disclosure) },
      summary: typeof body.summary === 'string' ? body.summary.slice(0, 600) : '',
      memory: {
        source: typeof mem.source === 'string' ? mem.source : 'empty',
        publicBackground: typeof mem.publicBackground === 'string' ? mem.publicBackground.slice(0, 2000) : '',
        hiddenMemories: Array.isArray(mem.hiddenMemories)
          ? mem.hiddenMemories.filter((h: unknown): h is string => typeof h === 'string').slice(0, 12)
          : [],
      },
      look: {
        form: look.form,
        color: look.color,
        accessory: typeof look.accessory === 'string' ? look.accessory : 'none',
        seed: mine.name,
        ...(typeof look.avatar === 'string' ? { avatar: look.avatar } : {}),
      },
    });
    return c.json({ agent: publicCard(card) });
  } catch (error) {
    return datingError(c, error);
  }
});

app.post('/api/dating/tick', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  try {
    const roster = await listSquare();
    const mine = roster.find((card) => card.ownerSub === auth.session.sub);
    if (!mine) return jsonError(c, 404, 'Release an agent into the square first.');
    // Deliberately unclaimed: a player asking their own agent to act is a
    // distinct event each time, not a scheduled round to be deduplicated.
    const event = await runAgentTick(auth.bearer, mine, roster, worldCreds);
    if (event) await appendEvent(event);
    return c.json(event ? { event } : { event: null, note: 'Your agent held back this round.' });
  } catch (error) {
    return datingError(c, error);
  }
});

app.post('/api/dating/encounter', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const targetHandle = typeof body.target === 'string' ? body.target : '';
  try {
    const roster = await listSquare();
    const mine = roster.find((card) => card.ownerSub === auth.session.sub);
    if (!mine) return jsonError(c, 404, 'Release an agent into the square first.');
    const target = roster.find((card) => card.handle === targetHandle);
    if (!target || target.handle === mine.handle) return jsonError(c, 404, 'No such agent to meet.');
    const event = await encounterWith(auth.bearer, mine, target, worldCreds);
    if (event) await appendEvent(event);
    return c.json({ event });
  } catch (error) {
    return datingError(c, error);
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
    // without a restart, and one who signs out drops out of it.
    let live = initial;
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, intervalMs));
        live = await withOauth().catch(() => live);
      }
    })();
    // Any number of processes may run this. Each round is claimed per agent in
    // the database before a model is called, so a second loop finds every turn
    // already taken and goes quiet — rather than doubling the town.
    console.log(`[dating] 🌍 world loop live · ${initial.size} identifier(s) · every ${intervalMs}ms`);
    startWorldLoop({
      creds: () => live,
      roster: () => listSquare(),
      intervalMs,
      onEvent: (e) => {
        // `appendEvent` is the durable write — it is what puts the beat in
        // Postgres, where the feed, the trajectory detectors and the director
        // all query it by pair, by place and by time.
        appendEvent(e).catch((err) => console.warn('[town] appendEvent:', err?.message));
        void recordEvent(e).catch(() => undefined);      // durable in links/
        maybeSummarise();                                 // throttled inside
        void maybeCloseYear().catch(() => undefined);
        console.log(`[dating] 🌀 ${e.actor} [${e.move}] → ${e.target} · a${e.attraction.toFixed(2)}/t${e.tension.toFixed(2)} — ${e.note}`);
      },
    });
  })();
}

export default app;
