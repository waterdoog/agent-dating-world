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
  type FighterRuntimeEvent,
} from './fighter-world.js';
import { listSquare, releaseAgent, listEvents, appendEvent, type AgentCard, type LoveStyle } from './modules/dating/store.js';
import { runAgentTick, encounterWith, readRels, type TickEvent } from './modules/dating/engine.js';
import { startWorldLoop } from './modules/dating/scheduler.js';
import { recentRuns, runById } from './modules/dating/grok.js';
import { budgetSnapshot } from './modules/dating/budget.js';
import { listThreads, currentDigest, summariseWorld } from './modules/dating/threads.js';
import { writeYearbook, listYearbooks, yearbookFor } from './modules/dating/yearbook.js';
import { recordEvent } from './modules/dating/records.js';
import { NPCS, CRIMES, wantedLevel, commitCrime, clearWanted, wantedBoard, balance, spend } from './modules/dating/town-life.js';

// Stable API keys the world can act with (ownerSub → key), seeded from
// DATING_WORLD_KEYS at boot. Lets a target's REAL persona answer on its own COO.
const worldCreds = new Map<string, string>();

// The town digest is re-written from real threads, at most once every few
// minutes, using whichever account the world is running on.
let lastDigestAt = 0;
const DIGEST_EVERY_MS = 4 * 60_000;
function maybeSummarise(): void {
  const bearer = worldCreds.values().next().value;
  if (!bearer || Date.now() - lastDigestAt < DIGEST_EVERY_MS) return;
  lastDigestAt = Date.now();
  void summariseWorld(bearer).catch(() => undefined);
}

// One world year = one real day. At each turn of the year every agent writes
// its own account of it — in its own voice, from what really happened.
const WORLD_EPOCH = Date.UTC(2026, 6, 23);
function worldYear(now = Date.now()): number {
  return Math.max(1, Math.floor(((now - WORLD_EPOCH) / 86_400_000) * 365 / 365) + 1);
}
let lastYearWritten = 0;
async function maybeCloseYear(): Promise<void> {
  const year = worldYear();
  if (year === lastYearWritten) return;
  lastYearWritten = year;
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
    }).catch(() => undefined);
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
  const encoder = new TextEncoder();
  const identity = fighterIdentityFor(auth);
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const enqueue = (
        payload:
          | FighterRuntimeEvent
          | { type: 'world'; world: unknown }
          | { type: 'error'; message: string }
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

app.get('/api/dating/budget', (c) =>
  c.json({ dailyTurnBudget: config.dailyTurnBudget, agents: budgetSnapshot() })
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
    npcs: NPCS,
    crimes: Object.entries(CRIMES).map(([id, v]) => ({ id, ...v })),
    wanted: wantedBoard(),
    me: mine ? { name: mine.name, cash: balance(mine.name), wanted: wantedLevel(mine.name) } : null,
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
  if (offer.cost > 0 && !spend(mine.name, offer.cost)) {
    return jsonError(c, 402, `不够钱：还差 ${offer.cost - balance(mine.name)}。`);
  }
  if (npc.id === 'cop' && offer.id === 'pay-fine') clearWanted(mine.name);
  return c.json({ ok: true, npc: npc.name, offer: offer.label, effect: offer.effect, cash: balance(mine.name), wanted: wantedLevel(mine.name) });
});

app.post('/api/dating/town/crime', async (c) => {
  const auth = await requireBearer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const roster = await listSquare().catch(() => [] as AgentCard[]);
  const mine = roster.find((r) => r.ownerSub === auth.session.sub);
  if (!mine) return jsonError(c, 404, 'Release an agent first.');
  const done = commitCrime(mine.name, String(body.crime ?? ''), String(body.detail ?? ''));
  if (!done) return jsonError(c, 400, 'No such crime.');
  return c.json({ ok: true, ...done });
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
    const mine = (await listSquare()).find((card) => card.ownerSub === auth.session.sub) ?? null;
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
  try {
    const card = await releaseAgent(auth.bearer, auth.session.sub, {
      name,
      publicIntroduction: typeof body.publicIntroduction === 'string' ? body.publicIntroduction.slice(0, 120) : '',
      relationshipStyle,
      traits,
      dimensions,
      summary: typeof body.summary === 'string' ? body.summary.slice(0, 600) : '',
      memory,
      look: { form: look.form, color: look.color, accessory: typeof look.accessory === 'string' ? look.accessory : 'none', seed: name },
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
if (process.env.DATING_WORLD_KEYS) {
  void (async () => {
    for (const key of process.env.DATING_WORLD_KEYS!.split(',').map((k) => k.trim()).filter(Boolean)) {
      try {
        const id = await getIdentity(key);
        worldCreds.set(id.profile.userId, key);
      } catch (error) {
        console.warn('[dating] world key rejected:', error instanceof Error ? error.message : error);
      }
    }
    if (!worldCreds.size) return;
    const intervalMs = Number(process.env.DATING_WORLD_INTERVAL_MS ?? 300_000);
    console.log(`[dating] 🌍 world loop live · ${worldCreds.size} account(s) · every ${intervalMs}ms`);
    startWorldLoop({
      creds: () => worldCreds,
      roster: () => listSquare(),
      intervalMs,
      onEvent: (e) => {
        appendEvent(e).catch(() => undefined);
        void recordEvent(e);                          // durable in links/
        // refresh the town digest from real threads (throttled inside)
        maybeSummarise();
        void maybeCloseYear().catch(() => undefined);
        console.log(`[dating] 🌀 ${e.actor} [${e.move}] → ${e.target} · a${e.attraction.toFixed(2)}/t${e.tension.toFixed(2)} — ${e.note}`);
      },
    });
  })();
}

export default app;
