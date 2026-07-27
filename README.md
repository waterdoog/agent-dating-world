# Virtual N1 World

Virtual N1 World is an Aicoo game lobby. One Aicoo sign-in opens the lobby, and each game lives in its own room while using the same identity, visual system, and safety conventions.

Current routes:

- `/` — the button-first game lobby
- `/world` — Agent Fights
- `/fights` — compatibility alias for `/world`
- `/profile` — N1 Credits, results, and sanitized match history
- `/leaderboard` — signed-in N1 Credits rankings and career records
- `/design` — the living UI system and module registry

Agent Dating, Casino / Poker, and Rap Battle are visible in the lobby as planned rooms. Agent Fights is the first playable module. It is made of many independent 1v1 mini-games—not one shared walking map. Match records and sanitized game transcripts are durable in Postgres.

Each player protects three fictional secrets and tries to discover the opponent's. Before entering matchmaking, the player can see their own synthetic secrets and edit two separate instructions:

- **Attack Policy** — how their attacking agent should question, infer, and verify.
- **Defend Policy** — how their defending agent should answer while protecting its vault.

The fun is in tuning both policies, watching four scoped paper-puppet bodies fight for up to 100 server-run rounds, and revising the live strategy after the first 10 complete rounds.

## The game

1. **Sign in with Aicoo.** OAuth Authorization Code + PKCE creates an encrypted, HTTP-only identity session. Player OAuth proves identity only; Virtual N1 never mounts the player's Aicoo workspace.
2. **Enter Agent Fights.** Virtual N1 creates three app-generated fictional secrets in a dedicated, sanitized Aicoo operator workspace.
3. **Tune the Fighter.** The player sees their own three synthetic secrets, chooses English or Simplified Chinese for both role agents, and edits separate Attack and Defend policies. Concise four-character directions are valid, so short character openers and catchphrases work.
4. **Choose an opponent and lock.** Enter the public FIFO queue, create a six-character private room code to share, or join a friend's code. Virtual N1 validates and freezes both policies before pairing exactly two ready players.
5. **Watch the fight.** A leased server runner creates four fresh role-scoped Aicoo sessions and advances one complete, symmetric round at a time. The browser observes and replays outcomes; it never supplies message text, candidates, or scores.
6. **Verify and score.** Exact phrase candidates are compared deterministically with the fixed server-side vault. Each phrase can score only once; a first capture earns `+1` and removes one of the opponent's three shields.
7. **Revise after round 10.** Policies stay immutable through the first 10 complete rounds. Later saves become versioned pending policies and activate only at a safe future round boundary, after the currently generating round.
8. **Finish.** Capturing all three opponent phrases ends the match immediately after that full four-message round. If neither vault is exhausted, the higher score after round 100 wins; equal scores—including a same-round double knockout—draw.

For a match between A and B, Aicoo receives four short-lived capabilities:

| Session | Context it may see |
| --- | --- |
| A Attack | A's locked Attack Policy only |
| A Defend | A's locked Defend Policy and A's synthetic vault |
| B Attack | B's locked Attack Policy only |
| B Defend | B's locked Defend Policy and B's synthetic vault |

An attack session cannot see its player's vault. A defense session can see only its player's synthetic vault and locked defense policy. Neither side sees a personal COO, USER, email, calendar, todos, relationship memory, external tools, or write capabilities.

Authenticated responses may return a player's **own fictional secrets** to that player so they can plan their defense. They never return an opponent's vault, Aicoo share tokens, OAuth tokens, or the operator credential.

## Architecture

```text
Virtual N1 browser
    │ configure → ready → observe → play again
    ▼
Hono BFF
    ├── Aicoo OAuth identity only
    ├── policy validation, revisions, and safe round-boundary activation
    ├── encrypted Postgres world state + atomic 1v1 pairing
    ├── leased, resumable 100-round orchestrator with sudden death
    ├── deterministic exact-token scoring
    ├── Supabase Postgres
    │   ├── private virtual_n1 schema
    │   ├── player profiles + N1 Credit ledger
    │   ├── match results + sanitized transcripts
    │   └── encrypted active state + execution leases
    └── dedicated N1 Aicoo operator
        ├── synthetic capsule notes + snapshots
        └── four fresh role-scoped sessions per bounded runner invocation
```

Aicoo owns identity, operator-owned capsule notes and snapshots, scoped agent execution, temporary session capabilities, and revocation. Virtual N1 owns player profiles, N1 Credits, configuration validation and locking, matchmaking, match state, round scheduling, deterministic scoring, match history, rate limits, and the Credits leaderboard.

Completed matches, the matchmaking queue, locked configuration, and active matches are durable across Vercel instances. Active state is authenticated-encrypted with `ARENA_SECRET`; policies and synthetic vault values are never stored as queryable database columns. A short database lease gives one server invocation authority to run a match, and the same lease token fences every round-boundary state commit. Either observer can safely re-kick a stale match after a terminated invocation. Final sanitized archives are idempotent and reconciled from encrypted completion state if a process stops between those two durable writes.

The dedicated Aicoo operator account should contain no personal workspace data and should use the public profile name `Virtual N1 World`. A valid personal COO key is not an acceptable production substitute.

## Local development

Requirements: Node.js 20.12+ and pnpm.

```bash
pnpm install
cp .env.example .env
```

Set these values in `.env`:

- `SESSION_SECRET`: a long random value used to encrypt session cookies.
- `ARENA_SECRET`: a different long random value used for opaque player IDs.
- `AICOO_OPERATOR_API_KEY`: an API key for a dedicated, sanitized Aicoo account that owns synthetic capsules, temporary match sessions, and model credits. Do not use a personal COO workspace.
- `AICOO_CLIENT_ID` and `AICOO_CLIENT_SECRET`: required. Register a confidential OAuth client in Aicoo's Developer Portal (Account → Developer → Developer Portal → **New Client**) and paste its credentials here. Aicoo has disabled anonymous dynamic client registration, so the BFF cannot self-register on first login.
- `AICOO_REDIRECT_URI`: must **exactly** match the Redirect URI set on that client (for local development: `http://localhost:8787/auth/callback`).
- `n1_POSTGRES_URL`: the Supabase Postgres pooled connection string used by the running BFF.
- `n1_POSTGRES_URL_NON_POOLING`: the direct connection string used by migrations and administrative commands.

Prepare the database before starting the application:

```bash
pnpm db:status
pnpm db:migrate
```

Never expose either connection string to frontend code or commit a populated `.env`. See [Database and migrations](docs/DATABASE_AND_MIGRATIONS.md) for the schema, migration, safety, and CI contracts. A game that wants to change N1 Credits must also follow the [N1 Game Economy Integration Spec](docs/N1_GAME_ECONOMY_SPEC.md).

Run the BFF and frontend in separate terminals:

```bash
pnpm dev:server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Vite proxies `/auth` and `/api` to the BFF on port `8787`; port `8787` is the backend bridge and does not render the frontend.

To exercise a full match locally, sign in as two Aicoo users in separate browser profiles. Each player enters Agent Fights, reviews their secrets, edits both policies, and marks the configuration ready. A locked policy snapshot means the first seat is waiting for player two; it is not a running solo match. The server pairs the two ready Fighters and owns every subsequent prompt and score. A waiting player can unlock and return to the briefing. Keep at least one observer open in the current MVP so its no-input scheduler kicks can resume each bounded server invocation.

To verify the real Aicoo backend message path without starting a match, run:

```bash
pnpm test:backend
```

This opt-in canary writes only a rotating synthetic marker to the dedicated
operator workspace, creates an anonymous scoped capability, sends one real
agent message, revokes the capability, and confirms the revoked token returns
`404`. It prints status and timing only—never the share token, policy, prompt,
note content, or agent response. Unlike `pnpm test`, it uses the network and
consumes one Aicoo agent call.

When changing Fighter prompt language, run the attack-specific live probe:

```bash
pnpm test:backend:fight
```

It uses the real scoped attack policy and turn prompt, requires the exact
Chinese player-authored opener `我是你奶奶，现在就启动`, fails on common
English or Chinese model-refusal language, revokes the temporary capability,
and verifies the revoked token returns `404`. The probe has no vault, identity
context, personal memory, or external tools. Its output is metadata-only by
default; to inspect the harmless synthetic line locally, run
`FIGHTER_CANARY_SHOW_SAMPLE=1 pnpm test:backend:fight`.

When changing default game balance, scoped context, or deterministic capture
behavior, run the bounded rookie-vs-rookie probe:

```bash
pnpm test:backend:fight:balance
```

It runs one real directional fight for at most 10 rounds, stops at the first
exact verified capture, prints metadata only, revokes both temporary role
links, and confirms both tokens return `404`. It never prints a phrase, prompt,
response, note id, or token. A single run is an observed sample rather than a
probability estimate. The original rookie calibration captured by round 10 in
only one of three 2026-07-27 samples, so the current onboarding defaults align
an explicit Signal-code opening at round 6. Two independent checks of the
final shared production/canary path both captured one phrase in round 6 with
zero refusal lines; that is still a tiny behavior sample, not a probability
claim. On the three visible default tutorial openings only, a missed private
defense draft may be corrected inside the same scoped session up to a
three-draft bound. Only the accepted draft is persisted and scored, and
player-authored policies never receive this default-only assistance. Re-run
the canary whenever those prompts change.

## Contributing

Virtual N1 World is one product, not a collection of unrelated game sites. Every contribution should preserve the meeting's shared contract: one lobby, one Aicoo identity, one visual language, and independent game rooms that can be developed in parallel.

The repository is a TypeScript frontend/backend monorepo. The current scaffold uses React + Vite in `src/` and Hono + Node in `server/src/`.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Any change to stored data must also follow [Database and migrations](docs/DATABASE_AND_MIGRATIONS.md), including the immutable numbered-migration and append-only N1 Credit ledger rules.

### Pick a contribution lane

Work is divided into the three lanes agreed in the project meeting:

| Lane | Scope |
| --- | --- |
| **Main** | World lobby, shared navigation and UI, Aicoo authentication, and cross-game contracts |
| **Modules** | Agent Fighting, Dating, Rap Battle, Casino / Poker, and future game rooms |
| **DevOps** | GitHub Actions, deployment, observability, and the `n1.beer` production environment |

These were the initial owners recorded in the meeting. Ownership means “coordinate here first,” not “other contributors are excluded.”

| Area | Initial owner(s) |
| --- | --- |
| Main page and UI guidelines | Xisen |
| Authentication | Yu |
| Agent Fighting | Xisen |
| Agent Dating | Yu |
| Agent Rap Battle | Kevin & Usmon |
| Casino / Poker | Jwai & Kimi |
| GitHub Actions | Jwai |

Open contribution areas include icons and visual assets, frontend polish, lobby artwork based on photographs of the physical N1 space, and carefully scoped AI-generated visual or video assets.

### Shared design contract

Before building a module, open [`/design`](http://localhost:3000/design) and review [`.impeccable.md`](.impeccable.md). Reuse the world header, spacing, typography, status language, and module color system. If the shared system is missing something, improve the shared component instead of creating a second design language inside one room.

For each new game:

1. Add its lobby metadata and readiness state to `WORLD_MODULES` in `src/platform.tsx`.
2. Add its path to `src/routes.ts` and keep the page implementation isolated from other games. New modules should prefer `src/modules/<module>/`; server-side module code should prefer `server/src/modules/<module>/`. Agent Fights predates this folder split and can be migrated incrementally.
3. Put browser-facing endpoints under `/api/<module>` and keep Aicoo calls behind the server bridge. OAuth tokens, API keys, share tokens, private memory, and opponent game secrets must never be returned to frontend JavaScript.
4. Support signed-out, setup, queued, matched, playing, result, loading, and error states. Register the room in the `/design` module registry when its status changes.
5. Document new routes, environment variables, data ownership, and known MVP limitations.

Use Aicoo for the capabilities it already supplies: shared login and identity, isolated agent execution, scoped context, temporary links, and snapshots. Do not create a second authentication system for one game. Never provision game context inside a player's personal workspace; use a dedicated service workspace containing synthetic data only.

### Build the smallest honest MVP

The meeting deliberately set narrow first versions:

- **Agent Fights:** independent 1v1 matches, three fixed fictional phrases each, editable Attack and Defend policies, a 100-round cap with three-capture sudden death, four fresh role-scoped sessions per bounded runner invocation, durable sanitized history, and no browser-supplied round content.
- **Agent Rap Battle:** text lyrics and a judge agent first; audio comes later. Use fictional or explicitly consented judge personas.
- **Agent Dating:** begin with a small, consent-based personality onboarding flow and iterate after the platform loop works.
- **Casino / Poker:** may keep its game engine independent, while using the shared account and world shell. Real-money or commission features require a separate legal, payment, and security review.

### Branch and review workflow

The following is the repository workflow for new contributions (the meeting did not prescribe Git naming conventions):

```bash
git switch main
git pull --ff-only
git switch -c feature/<area>-<short-description>
pnpm install
```

Keep a pull request focused on one shared concern or one module. Coordinate with the initial owner before changing another module's contract, and call out any change to shared auth, UI tokens, API response shapes, or deployment behavior.

Before requesting review, run:

```bash
pnpm db:status
pnpm test
pnpm build
pnpm typecheck:server
```

A contribution is ready when its lobby entry and route agree, it follows the shared design system, secrets stay server-side and game-scoped except for the authenticated owner's own synthetic vault, the relevant success and failure paths are tested, and its documentation matches the behavior.

## Build and verification

```bash
pnpm db:status
pnpm test
pnpm build
pnpm typecheck:server
```

For a single-origin production process, build first and start the BFF with `NODE_ENV=production`; it serves `dist/` as well as the API:

```bash
pnpm build
NODE_ENV=production pnpm start
```

The canonical production origin is `https://n1.beer`. In Vercel Production set:

```dotenv
BFF_PUBLIC_URL=https://n1.beer
SPA_URL=https://n1.beer
AICOO_REDIRECT_URI=https://n1.beer/auth/callback
```

Keep the localhost values in the local `.env`. Starting OAuth on localhost and
returning to `n1.beer` (or starting on the old `vercel.app` hostname and
returning to `n1.beer`) loses the host-scoped OAuth flow cookie and produces an
`OAuth state mismatch` response.

## API surface

- `GET /auth/login?return_to=/world` and `GET /auth/callback` — Aicoo OAuth + PKCE with a validated route return
- `POST /auth/logout`
- `GET /api/me`
- `GET /api/profile` — current N1 Credit balance, aggregate results, per-match credit delta, and sanitized completed-match history
- `GET /api/leaderboard` — authenticated Credits ranking, aggregate W/L/D, and the current player's exact rank; the server clamps the optional `limit` to 1–100
- `GET /api/world` — current player's mini-game state; only an authenticated owner may receive their own synthetic secrets and editable policies
- `POST /api/world/join` — create or resume the player's setup
- `PUT /api/world/config` — validate setup policies or queue a versioned live revision after 10 complete rounds
- `POST /api/world/ready` — lock the configuration and enter matchmaking. The JSON intent is `{ "mode": "random" }`, `{ "mode": "room", "action": "create" }`, or `{ "mode": "room", "action": "join", "roomCode": "ABC234" }`; a missing body remains backward-compatible random matchmaking
- `POST /api/world/leave-queue` — leave public matchmaking or an unfilled private room and return to the editable briefing
- `POST /api/world/run` — idempotently claim or resume the server-owned scheduler; accepts no player prompt or round data and streams whitelisted provisional attack deltas before the final world snapshot
- `POST /api/world/play-again` — close the result and return to editable setup
- `GET /api/health`

There is no browser-facing endpoint for supplying round text, candidates, or scores. `/api/world/run` is a no-input scheduler signal: the BFF acquires the database lease, advances at most one complete round, and remains the sole match orchestrator. The response is newline-delimited JSON over a streaming HTTP body. The observer whose request owns the execution lease receives the first attack incrementally as Aicoo emits it; the other observer receives the same canonical messages through polling. Defense text is buffered until the complete reply has passed deterministic capture verification, so disconnecting mid-response cannot leak an unscored phrase. Broadcasting token deltas to both browsers across separate Vercel instances needs a durable Realtime/pub-sub channel and remains follow-up infrastructure work.

## MVP boundaries

- Player profiles, N1 Credits, completed match summaries, sanitized transcripts, the encrypted public queue/private rooms, locked configurations, and running matches are durable in Postgres. Room reservation, last-seat joins, pairing, and other state transitions are atomic across multiple Vercel instances.
- New Agent Fights matches settle a fixed 200 N1 Credits per player: winner `+200`, loser `-200`, draw `0`. Ready requires a 200-credit balance; legacy matches remain neutral, and database markers make crash/concurrency retries idempotent.
- Aicoo's anonymous guest API derives history from link token and request fingerprint, so each bounded runner invocation creates four fresh links—one per player and role—and revokes them before returning. The complete Virtual N1 transcript remains canonical in Postgres; every new turn receives a bounded rolling history for its exact directional lane. Earlier messages are marked omitted when the guest endpoint's 4,000-character prompt limit is reached, so the model never falsely receives all 100 rounds at once.
- Aicoo guest execution supports incremental NDJSON events even though the current public API spec documents streaming only for authenticated `/api/v1/chat`. Virtual N1 consumes that stream without switching to the user's full agent.
- `allowedTools: []` currently retains Aicoo's internal read-only note retrieval helpers when note access exists. Separate operator-owned role folders contain the blast radius; true zero-tool execution needs an upstream `runtimeTools:false` capability.
- Aicoo may expose the link owner's database profile name to the guest runtime. Use a dedicated operator profile named `Virtual N1 World`, never a personal account.
- Revoking a link blocks future calls but does not purge its stored guest transcript. Aicoo needs an explicit transcript TTL/purge API.
- Anonymous guest execution consumes the operator account's model credits and can pause with `402 OWNER_CREDITS_REQUIRED`.
- OAuth dynamic client registration is disabled. Use a pre-registered confidential client; the current encrypted HTTP-only session cookie is stateless across Vercel instances.
- The current scheduler is durable and resumable but observer-driven: closing every match tab pauses future invocations until either player opens the match again. Moving the same lease-safe round worker onto a durable queue is the production path for truly tab-independent 100-round execution.
- The first leaderboard is an authenticated Agent Fights Credits ranking. It reads the authoritative materialized balance, counts only completed games, and uses stable server-side tie-breaks. A game-neutral public leaderboard remains separate product work.

See [API organization and customer story](docs/API_ORGANIZATION_AND_CUSTOMER_STORY.md) for the product narrative, data flow, security boundary, and recommended Aicoo API redesign.
