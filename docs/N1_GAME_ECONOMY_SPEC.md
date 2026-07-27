# N1 Game Economy Integration Spec

Status: **v1 integration contract**
Reference implementation: **Agent Fights**

This document defines how a Virtual N1 mini-game may read and change N1
Credits. N1 Credits are closed-loop game points, not cash, cryptocurrency, or a
withdrawable asset.

## The contract

Each game owns its rules and authoritative result. The shared economy layer
owns balances, immutable accounting, duplicate protection, and settlement
history.

| Game responsibility | Economy responsibility |
| --- | --- |
| Matchmaking, legal actions, result, and score | Player balance and signup grant |
| Locking the economic configuration for a match | Append-only credit ledger |
| Producing deterministic per-player outcomes | One settlement marker per participant |
| Deciding whether the game is zero-sum or has a house | Atomic, idempotent balance updates |
| Showing the returned settlement in its UI | Wallet history and reconciliation |

The browser may submit a legal game action, such as Ready or Place Bet. It must
never submit a winner, credit delta, resulting balance, or “settled” flag.

## Required game definition

Before a game can affect N1 Credits, it must publish a versioned definition:

```ts
interface N1GameEconomyDefinition {
  gameKey: string;
  settlementVersion: number;
  funding: 'minimum_balance' | 'reservation';
  minimumBalance: number;
  conservation: 'zero_sum' | 'house_account' | 'explicit_mint_burn';
}
```

Only `zero_sum` is supported by the current implementation. A house account or
explicit mint/burn changes total supply and requires separate platform
approval, abuse controls, and a supporting migration before use.

The definition must also specify:

- the durable game ID and participant IDs;
- when the economic configuration becomes immutable;
- how a server-owned result maps to one integer delta per participant;
- draw, cancellation, timeout, and abandoned-game behavior;
- whether replaying the same game ID is a retry or a new game;
- whether players may have more than one funded game at once.

Changing an amount or payout rule requires a new `settlementVersion`. A running
game keeps the version and amounts it locked when it started.

## Settlement lifecycle

Every game follows this sequence:

1. Resolve the Aicoo OAuth subject to the stable internal player ID. Email,
   display name, and username are not wallet keys.
2. Create the durable game record and lock its economy version and amounts.
3. Check funding before accepting Ready or the equivalent committed action.
4. Run the game without changing balances between ordinary turns.
5. Derive the final result server-side.
6. In one database transaction, in foreign-key dependency order:
   - upsert the durable game, participants, and sanitized archive records;
   - lock the game and participant result rows;
   - lock player wallet rows in stable player-ID order;
   - insert one immutable settlement marker per participant;
   - insert append-only ledger rows for non-zero deltas;
   - update materialized balances only for ledger rows inserted in this
     transaction;
   - commit the archive, markers, ledger, and balances together.
7. Return the resulting per-player delta from the server for history and UI.

A retry with the same `(gameKey, gameId, playerId, settlementVersion)` must
return the existing outcome without changing a balance again. A conflicting
retry must fail closed.

Zero-delta results still need settlement markers. The ledger intentionally
rejects zero-value rows, so a draw cannot use absence of a ledger event as its
only completion signal.

Every settlement must also satisfy these invariants:

- all balances, stakes, reservations, and deltas are safe integers;
- participant IDs are distinct and each participant has exactly one outcome;
- a `zero_sum` settlement's deltas add to exactly zero;
- a committed result cannot make any player balance negative;
- the materialized balance remains equal to the sum of that player's ledger.

## Funding models

### Minimum balance

Use this only when a player can participate in at most one funded match and no
other path can spend the same credits while that match is active.

- Check `balance >= requiredAmount` before matchmaking.
- Re-check under a wallet row lock during settlement.
- If the balance invariant is violated, roll back the entire settlement.

Agent Fights v1 uses this model.

This is safe only because one Fighter cannot occupy overlapping funded
matches. If Virtual N1 later permits simultaneous cross-room play, Agent Fights
must move to reservations before that feature ships.

### Reservation

Use this for variable bets, simultaneous games, tournaments, or any game in
which another action may spend credits before the result.

- Drafting a bet does not move credits.
- Committing the bet creates an idempotent reservation.
- Available balance excludes active reservations.
- Completion consumes the reservation and writes the payout atomically.
- Cancellation releases it through an immutable release event.

Do not represent escrow with a frontend number or an untracked balance update.

## Reference definitions

| Game | Funding | Locked rule | Settlement |
| --- | --- | --- | --- |
| Agent Fights v1 | Minimum balance | 200 N1 per player | Winner `+200`, loser `-200`, draw `0` |
| Blackjack | Reservation required | Committed bet per round | Consume bet once, then apply a versioned win/push/loss payout |
| Rap Battle | Product decision | Fixed stake or tournament entry | Publish a versioned deterministic scoring-to-payout rule first |
| Social/date experiences | None by default | N/A | No credit effect unless a separate economy definition is approved |

For Blackjack, the DOM balance and visual chip stack are presentation only.
The server must own the reservation, hand result, payout multiplier, rounding
rule, and house accounting.

## Current schema and the next shared migration

The shipped reference implementation predates the shared contract and uses
Agent Fights names:

| Current table/field | Shared concept |
| --- | --- |
| `fighter_users.n1_credits` | Player wallet balance |
| `fighter_games.n1_stake` | Locked game economy amount |
| `fighter_game_credit_settlements` | Per-player settlement marker |
| `n1_credit_ledger` | Append-only wallet events |

The current ledger's `game_id` foreign key points to `fighter_games`.
Therefore, another game must **not** insert fake Fighter records or write
directly to these tables. Before the second credit-bearing game ships, add an
additive shared-schema migration with:

- a game-neutral player wallet identity;
- `(game_key, game_id, economy_version)` on game economy records;
- game-neutral per-player settlement markers;
- ledger references to the game-neutral record;
- a server-only repository API used by game adapters.

Agent Fights should then migrate behind that API without changing historical
balances or replaying its version-1 settlements.

Suggested server-only interface:

```ts
interface N1EconomyRepository {
  readAvailableBalance(playerId: string): Promise<number>;
  lockGameEconomy(input: LockedGameEconomy): Promise<void>;
  reserve(input: CreditReservation): Promise<void>;
  settle(input: DeterministicGameSettlement): Promise<StoredSettlement>;
  cancel(input: GameCancellation): Promise<StoredSettlement>;
}
```

No wallet endpoint or database credential is exposed directly to browser code.
Schema and operational requirements remain governed by
[Database and migrations](DATABASE_AND_MIGRATIONS.md).

## Migration and deployment rules

- Add a numbered forward-only migration; never edit an applied migration.
- Run `pnpm db:status` and account for database-only versions before choosing a
  migration number.
- Backfill existing games with an explicit legacy/neutral settlement version;
  never retroactively charge old history by accident.
- Apply the additive migration before deploying code that queries its columns.
- Deploy application code only after migration status has no pending or
  checksum-mismatched local migrations.
- Use compensating ledger events for corrections. Never update or delete a
  historical ledger row.

## Acceptance tests for every game adapter

A game is not wallet-ready until tests prove:

- a win/loss produces the exact expected deltas and conservation behavior;
- a draw, push, or cancellation creates explicit zero/refund outcomes;
- sequential and concurrent retries change balances exactly once;
- a retry with a changed amount, player, or settlement version fails closed;
- an invalid or contradictory result rolls back every participant;
- insufficient funding is rejected before the expensive game begins;
- concurrent different-game spending cannot overbook the same balance;
- a crash before, during, and after settlement can be reconciled safely;
- the materialized wallet balance equals the sum of its immutable ledger;
- profile/history APIs return the stored delta rather than recalculating it in
  the browser;
- logs, API responses, and ledger metadata contain no OAuth token, email,
  private Aicoo memory, or synthetic secret value.

The rollback-only Agent Fights database canary is the baseline:

```bash
pnpm db:test:wallet
```
