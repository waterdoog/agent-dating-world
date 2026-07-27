# Contributing to Virtual N1 World

Virtual N1 World is one lobby with shared Aicoo identity, shared interface conventions, and independently developed game rooms. Keep changes focused on either a shared platform concern or one game module.

For database work, read [Database and migrations](docs/DATABASE_AND_MIGRATIONS.md) before changing a query or schema. The database is part of the product contract: schema changes and application code must ship together.

## Set up the repository

Requirements:

- Node.js 20.12 or newer
- pnpm
- an Aicoo OAuth client and a dedicated, sanitized Aicoo operator account
- access to the project Supabase Postgres database, or a separate development database

```bash
pnpm install
cp .env.example .env
pnpm db:status
pnpm db:migrate
pnpm dev:server
```

Run `pnpm dev` in a second terminal, then open [http://localhost:3000](http://localhost:3000).

Never commit `.env`, OAuth credentials, API keys, database passwords, share tokens, or production data. Use placeholders in documentation and `.env.example`.

## Pick a contribution lane

| Lane | Scope |
| --- | --- |
| **Main** | Lobby, shared navigation and UI, Aicoo authentication, profiles, and cross-game contracts |
| **Modules** | Agent Fights, Dating, Rap Battle, Casino / Poker, and future rooms |
| **DevOps** | Database operations, migrations, CI, deployment, and observability |

Coordinate before changing shared authentication, identity, database, UI tokens, or API response shapes. A new room should remain isolated from unrelated game code while reusing the shared shell and identity.

## Branch and review workflow

```bash
git switch main
git pull --ff-only
git switch -c feature/<area>-<short-description>
pnpm install
```

Keep each pull request focused. Call out any change to:

- browser-facing API contracts;
- Aicoo capability scope;
- stored data or retention;
- the N1 Credit ledger;
- migrations or required environment variables.

If a change needs a new database column, table, index, constraint, or enum, add a new numbered migration. Do not edit an already-applied migration. See [Database and migrations](docs/DATABASE_AND_MIGRATIONS.md#add-a-migration).

## Product and data safety

Player OAuth proves identity; it does not authorize Virtual N1 to copy a personal Aicoo workspace. Neither application logs nor Postgres may contain:

- OAuth access or refresh tokens;
- Aicoo API keys or temporary share tokens;
- personal COO, USER, email, calendar, todos, or relationship memory;
- synthetic vault values in plaintext or queryable columns;
- Attack or Defend policy text in plaintext or queryable columns.

Persisted match chat is the Virtual N1 game transcript, not a user's private Aicoo chat history. Sanitize it before insertion so a leaked vault value cannot become durable history.
Redaction must use the same Unicode normalization domain as deterministic
capture scoring; a value that can score must never survive in an equivalent
full-width or compatibility form.

The one exception is active world continuity: the complete in-flight state is authenticated-encrypted into a single opaque `sealed_state` value using `ARENA_SECRET`. Never add plaintext mirrors, JSON policy/vault columns, debug dumps, or a fallback that silently resets state after decryption failure.

Each player receives exactly 1,000 N1 Credits on first creation. Credit changes belong in the append-only ledger and require an idempotency key; never implement a balance change as an untracked update. Agent Fights locks a 200-credit settlement amount on a new game's first archive: winner `+200`, loser `-200`, draw `0`. A player needs at least 200 before Ready. Keep the archive, settlement marker, ledger event, and materialized balance in one transaction; legacy games remain neutral. Any other credit-bearing game must follow the [N1 Game Economy Integration Spec](docs/N1_GAME_ECONOMY_SPEC.md) and must not write fake Fighter records to reuse the current game-specific foreign key.

## Design and module conventions

Open [`/design`](http://localhost:3000/design) and read [`.impeccable.md`](.impeccable.md) before introducing a new screen. Reuse the world header, spacing, typography, state language, and module color system.

New browser endpoints belong under `/api/<module>`. Aicoo calls and database access stay behind the server bridge. Frontend JavaScript must never receive server credentials, database credentials, opponent vault contents, or temporary Aicoo capability tokens.

### Agent Fights rules that must stay deterministic

- Every player has one Attack role, one Defend role, and exactly three fixed synthetic capture phrases for the whole match.
- A complete round is always `A attack → B defend → B attack → A defend`. Both directions may be generated concurrently, but state is committed in that order.
- A phrase scores once. If either player's third phrase is captured, finish only after all four messages in that round are committed. If both third phrases fall in that round, the equal score is a draw.
- Otherwise the match stops after 100 complete rounds and compares total captures.
- Policies are immutable for the first 10 complete rounds. Later edits are pending revisions applied at an untouched future round boundary; never mutate context used by an active scoped link.
- Animations visualize server results only. A shield means no new verified capture in that direction; the red paper-splatter hit appears only for a newly persisted capture.
- The durable Virtual N1 transcript is the history source of truth. Each role receives only the bounded rolling transcript for its own directional lane; never rely on an anonymous Aicoo fingerprint or reuse a capability to carry 100-round history.
- Provisional browser streaming is attack-only and currently local to the request that wins the execution lease. The opponent catches up from canonical polling; do not claim cross-instance broadcast until a durable Realtime/pub-sub channel exists. Buffer defense output until the complete response has been sanitized, appended, and deterministically scored; otherwise a dropped connection could reveal a phrase without recording the capture.
- The shipped rookie defaults have explicit tutorial openings at rounds 6, 14, and 22. Only those exact defaults may use the bounded private defense-draft correction; never apply it to player-authored policies, and never persist or stream a rejected defense draft.

The four bodies are local React/SVG/CSS assets in `src/fight-arena.tsx` and
`src/fight-arena.css`; contributors do not need to download or license a sprite
pack. Preserve the reduced-motion path and animate wrappers with transforms or
opacity rather than changing layout properties.

## Verify a contribution

Run the relevant migration against a disposable development database before testing application code:

```bash
pnpm db:status
pnpm db:migrate
pnpm test
pnpm build
pnpm typecheck:server
```

Prompt or balance changes should also run:

```bash
pnpm test:backend:fight
pnpm test:backend:fight:balance
```

Both are opt-in live Aicoo probes that consume model calls. Their normal output
must remain metadata-only, and every temporary capability must be revoked and
verified as unavailable before the process exits.

For database changes, also verify:

1. applying all migrations to an empty database succeeds;
2. applying them again is a no-op;
3. migration status reports no pending or checksum-mismatched files;
4. existing rows remain valid and sensitive values are not introduced;
5. application behavior works with both an empty history and existing match history.
6. every application table remains under the private `virtual_n1` schema and `PUBLIC`, Supabase `anon`, and Supabase `authenticated` retain no schema/table/sequence privileges.

Do not use a shared production database for local experiments. A contribution is ready when behavior, migrations, tests, and documentation agree.
