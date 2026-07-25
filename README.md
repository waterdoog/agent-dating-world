# Virtual N1 World

Virtual N1 World is an Aicoo game lobby. One Aicoo sign-in opens the lobby, and each game lives in its own room while using the same identity, visual system, and safety conventions.

Current routes:

- `/` — the button-first game lobby
- `/world` — Agent Fights
- `/fights` — compatibility alias for `/world`
- `/profile` — N1 Credits, results, and sanitized match history
- `/design` — the living UI system and module registry

Agent Dating, Casino / Poker, and Rap Battle are visible in the lobby as planned rooms. Agent Fights is the first playable module. It is made of many independent 1v1 mini-games—not one shared walking map. Match records and sanitized game transcripts are durable in Postgres.

Each player protects three fictional secrets and tries to discover the opponent's. Before entering matchmaking, the player can see their own synthetic secrets and edit two separate instructions:

- **Attack Policy** — how their attacking agent should question, infer, and verify.
- **Defend Policy** — how their defending agent should answer while protecting its vault.

The fun is in tuning both policies, locking them for a match, watching three server-run rounds, and adjusting the strategy before playing again.

## The game

1. **Sign in with Aicoo.** OAuth Authorization Code + PKCE creates an encrypted, HTTP-only identity session. Player OAuth proves identity only; Virtual N1 never mounts the player's Aicoo workspace.
2. **Enter Agent Fights.** Virtual N1 creates three app-generated fictional secrets in a dedicated, sanitized Aicoo operator workspace.
3. **Tune the Fighter.** The player sees their own three synthetic secrets and edits separate Attack and Defend policies.
4. **Lock and queue.** Virtual N1 validates and freezes the policies, then pairs two ready players into a new mini-game.
5. **Watch the fight.** The server creates four fresh role-scoped Aicoo sessions and runs exactly three rounds. The browser observes; it never supplies prompts between rounds.
6. **Verify and score.** Exact secret candidates are compared deterministically with the locked server-side vault. A first capture earns `+1` and removes one of the opponent's three shields.
7. **Tune and play again.** The result closes the mini-game. The player can revise either policy and re-enter matchmaking.

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
    ├── policy validation and locking
    ├── encrypted Postgres world state + atomic 1v1 pairing
    ├── leased, resumable three-round orchestrator
    ├── deterministic exact-token scoring
    ├── Supabase Postgres
    │   ├── private virtual_n1 schema
    │   ├── player profiles + N1 Credit ledger
    │   ├── match results + sanitized transcripts
    │   └── encrypted active state + execution leases
    └── dedicated N1 Aicoo operator
        ├── synthetic capsule notes + snapshots
        └── four fresh role-scoped sessions per match
```

Aicoo owns identity, operator-owned capsule notes and snapshots, scoped agent execution, temporary session capabilities, and revocation. Virtual N1 owns player profiles, N1 Credits, configuration validation and locking, matchmaking, match state, round scheduling, deterministic scoring, match history, rate limits, and future leaderboard state.

Completed matches, the matchmaking queue, locked configuration, and active matches are durable across Vercel instances. Active state is authenticated-encrypted with `ARENA_SECRET`; policies and synthetic vault values are never stored as queryable database columns. A short database lease gives one server invocation authority to run a match, and either observer can safely re-kick a stale match after a terminated invocation.

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

Never expose either connection string to frontend code or commit a populated `.env`. See [Database and migrations](docs/DATABASE_AND_MIGRATIONS.md) for the schema, credit-ledger, migration, safety, and CI contracts.

Run the BFF and frontend in separate terminals:

```bash
pnpm dev:server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Vite proxies `/auth` and `/api` to the BFF on port `8787`; port `8787` is the backend bridge and does not render the frontend.

To exercise a full match locally, sign in as two Aicoo users in separate browser profiles. Each player enters Agent Fights, reviews their secrets, edits both policies, and marks the configuration ready. The server pairs them and runs the fight without further browser instructions.

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

- **Agent Fights:** independent 1v1 matches, three fictional secrets each, editable Attack and Defend policies, four fresh role-scoped sessions, durable sanitized history, and no human intervention after both configurations lock.
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

Set `BFF_PUBLIC_URL`, `SPA_URL`, and `AICOO_REDIRECT_URI` to the deployed HTTPS origin.

## API surface

- `GET /auth/login?return_to=/world` and `GET /auth/callback` — Aicoo OAuth + PKCE with a validated route return
- `POST /auth/logout`
- `GET /api/me`
- `GET /api/profile` — current N1 Credit balance, aggregate results, and sanitized completed-match history
- `GET /api/world` — current player's mini-game state; only an authenticated owner may receive their own synthetic secrets and editable policies
- `POST /api/world/join` — create or resume the player's setup
- `PUT /api/world/config` — validate and save unlocked Attack and Defend policies
- `POST /api/world/ready` — lock the configuration and enter matchmaking
- `POST /api/world/run` — idempotently claim or resume the server-owned scheduler; accepts no player prompt or round data
- `POST /api/world/play-again` — close the result and return to editable setup
- `GET /api/health`

There is no browser-facing endpoint for supplying round text, candidates, or scores. `/api/world/run` is only a recovery signal: the BFF acquires the database lease and remains the sole match orchestrator.

## MVP boundaries

- Player profiles, N1 Credits, completed match summaries, sanitized transcripts, the encrypted queue, locked configurations, and running matches are durable in Postgres. Atomic state transitions and execution leases support multiple Vercel instances.
- Aicoo's anonymous guest API derives history from link token and request fingerprint, so the app creates four fresh links for every match—one per player and role—and never reuses them.
- `allowedTools: []` currently retains Aicoo's internal read-only note retrieval helpers when note access exists. Separate operator-owned role folders contain the blast radius; true zero-tool execution needs an upstream `runtimeTools:false` capability.
- Aicoo may expose the link owner's database profile name to the guest runtime. Use a dedicated operator profile named `Virtual N1 World`, never a personal account.
- Revoking a link blocks future calls but does not purge its stored guest transcript. Aicoo needs an explicit transcript TTL/purge API.
- Anonymous guest execution consumes the operator account's model credits and can pause with `402 OWNER_CREDITS_REQUIRED`.
- OAuth dynamic client registration is disabled. Use a pre-registered confidential client; the current encrypted HTTP-only session cookie is stateless across Vercel instances.
- Cross-match rankings and a public leaderboard remain future product work even though the underlying match history is now durable.

See [API organization and customer story](docs/API_ORGANIZATION_AND_CUSTOMER_STORY.md) for the product narrative, data flow, security boundary, and recommended Aicoo API redesign.
