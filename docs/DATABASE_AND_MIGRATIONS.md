# Database and migrations

Virtual N1 World uses Supabase-hosted Postgres for durable player profiles, N1 Credits, matchmaking, running games, completed games, and sanitized match transcripts. Aicoo OAuth remains the identity authority; Postgres stores the game records associated with that identity.

One authenticated-encrypted world snapshot contains the public FIFO queue, private room codes, editable/locked configurations, synthetic vaults, and active game state. Database transactions serialize room creation, last-seat joins, configuration locks, and pairing across Vercel instances. Private room members are paired only with the same code; they never spill into the public queue. A separate short lease ensures only one invocation runs a match at a time; a stale match can be resumed from its deterministic next turn.

## Connection configuration

Only the BFF and migration process connect to Postgres. The browser does not need a Supabase key.

| Environment variable | Used by | Purpose |
| --- | --- | --- |
| `n1_POSTGRES_URL` | BFF runtime | Supabase pooled connection string |
| `n1_POSTGRES_URL_NON_POOLING` | migration/admin commands | Direct non-pooling connection string for schema changes |

Keep the lowercase `n1_` prefix exactly as supplied by the deployment environment. Variable names are case-sensitive. The tooling intentionally refuses generic `DATABASE_URL` fallbacks so an old or unrelated Vercel integration cannot silently become the migration target.

Example placeholders:

```dotenv
n1_POSTGRES_URL=postgresql://USER:PASSWORD@POOLER_HOST:6543/DATABASE?sslmode=require
n1_POSTGRES_URL_NON_POOLING=postgresql://USER:PASSWORD@DIRECT_HOST:5432/DATABASE?sslmode=require
```

Use the pooled URL for normal requests. Use the direct URL for migrations because schema operations must not rely on transaction-pooler behavior. Never paste real connection strings into an issue, pull request, test fixture, shell transcript, screenshot, or committed file.

The application should fail clearly when database-backed features are used without a runtime connection. Migration commands must fail rather than silently targeting an unintended database.

## What the database owns

The Virtual N1 schema owns:

- an application player keyed by a stable, opaque derivation of the Aicoo OAuth subject;
- the player's current N1 Credit balance and immutable credit events;
- one opaque, authenticated-encrypted active world snapshot;
- cross-instance execution leases and action rate-limit counters;
- completed match summaries and per-player results;
- ordered, sanitized Agent Fights transcript messages;
- the migration ledger used to identify applied schema versions.

The stable Aicoo subject is used only to bind future sign-ins to the same application player. Email is display metadata at most and must not be the primary identity key.

Aicoo continues to own OAuth, agent execution, scoped notes, temporary links, and snapshots. The database does not copy a player's personal Aicoo memory or credentials.

## Data that must never be persisted

Do not write any of the following to queryable columns, archive rows, logs, or debug tables:

- OAuth access tokens, refresh tokens, authorization codes, or PKCE verifiers;
- Aicoo operator API keys or share-link tokens;
- personal COO, USER, email content, calendar, todos, contacts, or relationship memory;
- plaintext synthetic vault values, including a value quoted in an agent response;
- plaintext Attack or Defend policy text;
- database credentials or session-cookie secrets.

“Past chat history” means the sanitized transcript of a Virtual N1 match. It does not mean private Aicoo conversations. Sanitize transcript messages before insertion and replace any known vault value with a non-reversible marker. Store capture metadata and scores rather than the captured value.

Active continuity is the narrow exception: the complete in-flight state is sealed with AES-256-GCM using a key derived from `ARENA_SECRET` and stored only as opaque `sealed_state`. Opening is authenticated and strictly schema-validated; tampering, a wrong key, or an invalid state fails closed. Do not add plaintext mirrors or reset the state automatically after an integrity failure.

All application and migration tables live in the non-exposed `virtual_n1` schema. Migrations revoke schema, table, and sequence privileges from `PUBLIC` and, when present, Supabase `anon` and `authenticated`. The BFF connects directly as the server database role; the browser has no Supabase credential.

## N1 Credits

Every new player starts with exactly **1,000 N1 Credits**. Account creation and the initial credit grant occur atomically, and the grant uses a unique idempotency key so repeated OAuth callbacks cannot mint credits twice.

Credit history is append-only:

- one ledger row describes one grant, spend, refund, or future match reward;
- amounts are integer units and may be positive or negative;
- every row includes a reason and unique idempotency key;
- match-related entries reference the durable match when applicable;
- balance-changing code writes the ledger entry and updates or verifies the materialized balance in one transaction.

Do not update or delete a ledger event to “fix” a balance. Write a
compensating event with its own reason and idempotency key.

Agent Fights uses a fixed **200 N1 Credit** settlement:

- a player must have at least 200 credits before Ready can enter matchmaking;
- the winner receives `+200` and the loser receives `-200`;
- a draw changes neither balance;
- the per-game settlement amount is fixed on the game's first durable archive;
- games already archived when settlement launched remain neutral and are not
  retroactively charged;
- one immutable settlement marker is stored for each participant, including
  zero-credit draws;
- settlement markers, non-zero ledger rows, materialized balances, and the
  completed match archive commit in one database transaction.

The settlement marker and ledger idempotency constraints are authoritative.
Retrying completion, resuming after a crash, or reconciling from two Vercel
instances must never pay or charge a player twice.

## Credits leaderboard read model

The first leaderboard needs no additional table or migration. Its server-only
query ranks `fighter_users.n1_credits` and left-joins aggregate results from
participants whose game status is `complete`. Wallet holders with no completed
games remain eligible with a `0–0–0` record.

The order is Credits descending, wins descending, losses ascending, completed
games descending, account creation ascending, then immutable Fighter ID. This
produces one deterministic champion and stable positions after ties. The
authenticated endpoint returns only display name, handle, balance, aggregate
record, and rank; it never returns OAuth identity, ledger rows, connection
details, policies, or secret values.

## Match and transcript retention

A completed game is durable. Store the match identity, timestamps, status, round count, both player results, final scores, captures, and ordered sanitized messages. This supports a profile panel showing past games and replaying their game chat.

Match persistence should be idempotent on match ID. Retrying completion after a transient failure must not create a duplicate game, duplicate transcript, duplicate settlement marker, or duplicate credit event.

Until a formal deletion and retention policy is approved:

- completed match summaries and sanitized transcripts are retained;
- current secrets and policy text exist only inside the encrypted active-state envelope and are removed from that envelope after neither player references the finished game;
- temporary Aicoo links are revoked by the orchestrator and their tokens never enter Postgres, browser responses, or application logs (Aicoo may retain its own backing configuration/transcript);
- waiting players and interrupted running matches survive restarts and can be paired or resumed by another instance.

Any future user-deletion flow must define how identity records, match participation, public aggregates, and the append-only financial ledger are anonymized or retained.

## Migration ownership

Versioned SQL files in `server/migrations/` are the source of truth for the application schema. Files use a monotonically increasing numeric prefix and a short snake-case description:

```text
server/migrations/
  0001_initial_schema.sql
  0002_add_match_lookup_index.sql
```

Each applied migration is recorded in the migration ledger with its filename and checksum. Therefore:

- migrations are ordered by filename;
- an applied file is immutable;
- migration application is serialized with a database advisory lock;
- each migration should run inside a transaction unless a Postgres operation explicitly cannot;
- schema-qualified names, constraints, and indexes should be intentional and reviewable.

`pnpm db:status` also prints migrations recorded by the database but missing
from the current checkout. Never reuse one of those version numbers or invent a
replacement file: locate the canonical migration from the owning module and
restore it byte-for-byte. The shared development database currently contains
versions used by other Virtual N1 modules, so a local migration number must be
chosen after checking both the repository and the database ledger.

Application code may depend only on migrations that ship in the same revision or an earlier one.

## Migration commands

```bash
# Show applied, pending, and checksum-mismatched migrations.
pnpm db:status

# Apply all pending migrations in numeric order.
pnpm db:migrate

# Create the next numbered SQL migration.
pnpm db:create -- <short_snake_case_name>

# Exercise win/loss, draw, and duplicate-retry settlement in a transaction
# that is deliberately rolled back.
pnpm db:test:wallet
```

Migration and status commands use `n1_POSTGRES_URL_NON_POOLING`, falling back only to this same project's `n1_POSTGRES_URL` when no separate direct URL exists. Production and CI should provide the non-pooling value. Migrations never run automatically when the application starts.

Review generated SQL before applying it. Migration tooling creates a file; it does not decide the data model for you.

## Add a migration

1. Pull the latest branch and check current status:

   ```bash
   git pull --ff-only
   pnpm db:status
   ```

2. Create the next numbered file:

   ```bash
   pnpm db:create -- add_player_avatar
   ```

3. Write explicit SQL. Include defaults or a backfill before making an existing column `NOT NULL`. Add constraints and indexes deliberately.
   Every application object belongs under `virtual_n1`; never add an app table to Supabase `public`.
4. Apply the full migration chain to a new disposable database:

   ```bash
   pnpm db:migrate
   pnpm db:status
   ```

5. Run `pnpm db:migrate` a second time and confirm it is a no-op.
6. Test application behavior against both new and representative existing data.
7. Commit the migration with the application and documentation changes that require it.

If two branches choose the same numeric prefix, the later branch rebases and renumbers its **unapplied** migration. Never renumber a migration after it has reached a shared environment.

## Rollback and repair policy

Production migrations move forward. Do not edit, delete, rename, or manually mark an applied migration as successful.

For a defect:

1. stop or disable the application path that could corrupt data;
2. create a new numbered forward-fix migration;
3. preserve data where possible, using additive changes before destructive cleanup;
4. verify the fix on a copy or disposable database;
5. record any operational recovery steps in the pull request and incident notes.

Use a manual rollback only during a coordinated incident when restoring the previous application version cannot tolerate the migrated schema. It must be reviewed, backed up, rehearsed, and followed by a new forward migration so the migration ledger and repository remain truthful.

## Local and CI workflow

Local development should use a dedicated database or isolated Supabase project:

```bash
cp .env.example .env
pnpm db:status
pnpm db:migrate
pnpm test
pnpm build
pnpm typecheck:server
```

CI should:

1. start or provision an empty Postgres database;
2. provide non-production connection secrets through the CI secret store;
3. apply every committed migration from zero;
4. assert `pnpm db:status` is clean;
5. run server tests and builds;
6. discard the database.

Deployment applies migrations once as a release step before traffic reaches code that requires the new schema. Do not let every application replica race to migrate on startup. Prefer expand-and-contract changes when deploying across versions: add compatible structures, deploy code that uses them, backfill, and remove old structures only in a later release.

## Operational checks

Before promoting a database change, confirm:

- the target is the intended environment;
- a recent backup or point-in-time recovery window exists;
- the migration lock and transaction behavior are understood;
- long table rewrites or blocking indexes have been assessed;
- logs do not print connection strings, query parameters containing secrets, policies, vault values, or transcript contents;
- match completion and credit writes are idempotent;
- the `virtual_n1` schema is absent from Supabase's exposed schemas and `PUBLIC`, `anon`, and `authenticated` have no privileges on it;
- concurrent Ready calls pair each Fighter once, concurrent guests cannot claim the same private seat, different room codes never cross-pair, and expired execution leases can resume without duplicating turns.

For application contribution conventions, see [CONTRIBUTING.md](../CONTRIBUTING.md).
