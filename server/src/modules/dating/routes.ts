/**
 * Everything the square exposes over HTTP.
 *
 * These twenty-four routes lived in `index.ts` beside the Fighter world, OAuth,
 * sessions and the world loop — 1200 lines in which the only thing the dating
 * routes had in common with their neighbours was the file they were in. Finding
 * where an agent gets released meant scrolling past matchmaking and token
 * refresh.
 *
 * The module takes what it cannot own rather than reaching for it. There is
 * exactly one such thing: the credential book, which the world loop replaces
 * whenever a player signs in or out, so it arrives as an accessor rather than a
 * value. Handing over the map itself would hand over a snapshot, and the routes
 * would quietly serve a smaller town than the loop the moment anyone logged in
 * — which is a bug this codebase has already had once.
 */
import { Hono, type Context } from 'hono';
import { AicooError } from '../../aicoo.js';
import { config } from '../../config.js';
import { jsonError, requireBearer, resolveBearer } from '../../http.js';
import { isDatabaseConfigured } from '../../database/client.js';
import {
  listSquare, releaseAgent, updateAgent, readSpec, stampOwnerName,
  listEvents, appendEvent, type AgentCard, type LoveStyle,
} from './store.js';
import { runAgentTick, encounterWith, readRels, writeRels, type TickEvent } from './engine.js';
import { CredentialBook, makeBeat } from './engine-core.js';
import { townStateHealth } from './town-state.js';
import { collectSignals } from './detectors.js';
import { turnHealth } from './turn-lock.js';
import { credentialHealth } from './credentials.js';
import { recentRuns, runById } from './grok.js';
import { budgetSnapshot } from './budget.js';
import { listThreads, currentDigest, recordKnowledge, knownTo } from './threads.js';
import { listYearbooks, yearbookFor } from './yearbook.js';
import { recordEvent } from './records.js';
import { requestFriend, friends, recall, searchMemory, memoryStats } from './memory.js';
import {
  NPCS, CRIMES, wantedLevel, commitCrime, clearWanted, wantedBoard,
  balance, spend, falloutOf, walletBalance, npcNow, reportPositions, resolveOffer,
} from './town-life.js';

export interface DatingRouteDeps {
  /**
   * Read on every request, never captured. The loop swaps the book out when a
   * player signs in; a captured reference would freeze the town as it was at
   * boot.
   */
  book: () => CredentialBook;
}

export function datingRoutes(deps: DatingRouteDeps): Hono {
  const app = new Hono();

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
      const victimKey = deps.book().of(victim);
      if (f && victimKey) {
        // Read it or do not write it — swallowing the failure into an empty list
        // made `cur` undefined, which rewrote the victim's entire standing with
        // the criminal as a default baseline plus the fallout. See the same guard
        // in engine.ts: a crime that fails to land on the ledger is a beat that
        // did not fully happen, and that is preferable to inventing a reading.
        const rels = await readRels(victimKey, victim.name).catch((err) => {
          console.warn(`[dating] ${victim.name}: fallout not applied, readings unreadable —`, err?.message);
          return null;
        });
        if (rels) {
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
        }
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
      const event = await runAgentTick(auth.bearer, mine, roster, deps.book());
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
      const event = await encounterWith(auth.bearer, mine, target, deps.book());
      if (event) await appendEvent(event);
      return c.json({ event });
    } catch (error) {
      return datingError(c, error);
    }
  });

  return app;
}
