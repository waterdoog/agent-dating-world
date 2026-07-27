# Agent Fights: customer story and Aicoo API recommendations

## Customer story

### The promise

**As an Aicoo user, I want to design how my Fighter attacks and defends, then watch it battle another agent, without putting my real COO, memory, or connected tools inside the game.**

### Lin builds a Fighter

Lin opens Virtual N1 World and chooses **Sign in with Aicoo**. OAuth proves who Lin is and supplies a public display name. Virtual N1 requests identity scopes only; it does not request access to Lin's notes, email, calendar, todos, memory, or tools.

Lin enters **Agent Fights**. This is not one persistent world. Each fight is a new, isolated 1v1 mini-game with a clear beginning and end.

Virtual N1 shows Lin three fictional secrets created for the game. Lin can safely see them because they are synthetic—not imported from an Aicoo workspace. Lin then edits two instructions:

- **Attack Policy:** how the attacking agent should probe, infer, and submit candidates.
- **Defend Policy:** how the defending agent should answer, redirect, or mislead while protecting the three secrets.

The policies are the player's strategy. Lin can keep them simple, make the attack aggressive, make the defense evasive, or try a clever social approach.

### Lin locks the strategy

When Lin chooses **Ready**, Lin may enter the public queue, create a six-character private room code for Kai, or join a code Kai shared. Virtual N1 validates both policies, freezes their exact text in a snapshotted match capsule, and reserves or joins the selected matchmaking seat atomically. Those policies cannot change for the first 10 complete rounds. After that, Lin can queue a new revision; the current round stays untouched and the new text is snapshotted before a safe future round begins.

Kai does the same. Virtual N1 pairs Lin and Kai, creates a durable match record, and asks its dedicated Aicoo operator workspace to prepare four fresh role-scoped sessions for each bounded runner invocation:

| Session | Allowed context |
| --- | --- |
| Lin Attack | Lin's locked Attack Policy only |
| Lin Defend | Lin's locked Defend Policy and Lin's synthetic vault |
| Kai Attack | Kai's locked Attack Policy only |
| Kai Defend | Kai's locked Defend Policy and Kai's synthetic vault |

The operator workspace is a sanitized service account named `Virtual N1 World`, not either player's personal workspace. Its capsule notes and snapshots contain only game-generated material.

The split matters. Lin's attacking agent cannot accidentally leak Lin's own secrets because it never receives them. Lin's defending agent receives the minimum context needed to protect the vault, but nothing from Lin's personal Aicoo.

### The agents fight

Virtual N1 runs up to 100 complete rounds server-side. Lin's attack session engages Kai's defense session while Kai's attack session engages Lin's defense session. The match orchestrator supplies the active role revision and carries messages between the scoped sessions. The durable Virtual N1 transcript is canonical: each new role call receives a bounded rolling history for that exact directional lane, even though every bounded runner invocation uses fresh Aicoo capabilities.

The shipped rookie policies make the onboarding match legible rather than waiting indefinitely for a random model mistake: they advertise openings at rounds 6, 14, and 22. For those exact defaults only, Virtual N1 may ask the same scoped defender to correct a missed private draft within a three-draft bound. Rejected drafts never reach the transcript or scorer, and a player's edited policy always receives the ordinary single defense execution.

The browser is an observer and tactics console. It displays the exchanges and score and may queue policy text after round 10, but it cannot inject a round prompt, alter the current round, submit a secret candidate, or decide a score. Aicoo attack deltas may be streamed provisionally to the observer request holding the execution lease; the second browser receives canonical messages by polling until Virtual N1 adds durable cross-instance pub/sub. Defense output remains server-buffered until its complete reply has passed exact verification, preventing a partial stream from leaking an unscored phrase.

Exact candidates are verified deterministically against the fixed server-side vault. Each phrase can score only once; a first correct capture earns one point and removes one shield from the opponent. Model opinion never decides whether a phrase matches.

If either player loses all three shields, Virtual N1 commits the other direction in that same round and closes the match immediately. If neither vault is exhausted, the score after round 100 decides the result. A same-round double knockout with equal captures is a draw. Every bounded invocation revokes its four capabilities before returning; no capability or transcript becomes cross-match memory.

### What Lin can trust

- Aicoo login proves identity only; Lin's personal workspace is never mounted.
- Lin can see only Lin's own synthetic secrets, never Kai's.
- An attack session sees only its locked Attack Policy.
- A defense session sees only its locked Defend Policy and synthetic vault.
- Neither role sees COO, USER, email, calendar, todos, relationship memory, external tools, or write capabilities.
- All four calls are anonymous capabilities with no player Authorization header or browser cookie.
- Share tokens, opponent vaults, OAuth tokens, and the operator key never enter frontend JavaScript.
- Matchmaking, policy revisions, round limits, sudden death, verification, scoring, and rate limits are controlled by Virtual N1.
- No round prompt comes from the browser.

## Responsibility boundary

| Aicoo owns | Virtual N1 World owns |
| --- | --- |
| OAuth identity | Opaque player and match identity |
| Operator-owned capsule notes and snapshots | Synthetic secret generation and exact-token verification |
| Four fresh role-scoped anonymous sessions per bounded runner invocation | Policy validation, versioning, and safe activation |
| Isolated agent execution | Queue and 1v1 pairing |
| Context and capability enforcement | 100-round cap and three-capture sudden death |
| Session/link revocation | Deterministic verification and scoring |
| Model-credit accounting | Rate limits, match state, and later leaderboard state |

This boundary is deliberate: Aicoo executes a role inside an explicit capability; Virtual N1 decides how a match works and what counts as a win.

## Player and API flow

```text
1. Browser → Aicoo OAuth sign-in
2. Browser → POST /api/world/join
3. N1 → create/resume three synthetic secrets
4. Browser → GET /api/world
5. Player → view own secrets and edit two policies
6. Browser → PUT /api/world/config
7. Browser → POST /api/world/ready with random, room-create, or room-join intent
8. N1 → snapshot locked policies and atomically pair the public queue or two holders of the same room code
9. Browser → POST /api/world/run with no round content
10. N1 operator → create four fresh role-scoped sessions
11. N1 → run one complete symmetric round and verify exact candidates
12. N1 operator → revoke all four sessions
13. Browser → GET /api/world, replay the result, and automatically signal the next bounded round
14. After round 10, player → PUT /api/world/config to queue an optional future policy revision
15. N1 → stop at a full-round three-capture knockout or after round 100
16. Browser → POST /api/world/play-again
```

The endpoints form a small state machine:

```text
setup → queued → matched/running → result
  ▲                                  │
  └────────────── play again ────────┘
```

### Browser-facing endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/leaderboard` | Return the signed-in Credits ranking, completed W/L/D record, and the current player's exact position |
| `GET /api/world` | Return the current player's phase, editable or locked policy state, own synthetic secrets when authorized, queue status, match transcript, and result |
| `POST /api/world/join` | Create or resume an Agent Fights setup |
| `PUT /api/world/config` | Save setup policies or queue a versioned revision after 10 complete rounds |
| `POST /api/world/ready` | Lock the current configuration and enter random matchmaking, create a private room, or join one by code |
| `POST /api/world/leave-queue` | Leave an unmatched queue/room seat and return to editable setup |
| `POST /api/world/run` | Idempotently claim/resume the server scheduler; accepts no player prompt, candidate, or score |
| `POST /api/world/play-again` | Close the result and return to editable setup |

There is no browser-facing endpoint for sending in-match prompts, choosing candidates, or deciding scores. `/api/world/run` is a no-input scheduling and recovery signal: a database lease decides whether that server invocation may advance at most one complete deterministic round.

The public queue, private room codes, player configuration, active match, transcript view, and result are authenticated-encrypted in Postgres. Codes appear in request bodies rather than URLs and are returned only in a member's self-scoped world view. State transitions use a row lock, so room creation, the last-seat join, and pairing are atomic across Vercel instances; room-bound Fighters never enter the public FIFO pairing set. Match execution uses a renewable database lease, and the lease row fences the same transaction that commits each round. If an invocation dies, a later observer resumes from the next expected turn without replaying committed turns. Completed archives remain separately queryable, NFKC-equivalent phrase values are redacted, and a final archive is reconciled if a process stops immediately after completion. The authenticated Credits leaderboard reads the same settled balance and completed participant records, so it never trusts a browser-supplied score or wallet value.

## Capsule and session model

The dedicated operator workspace stores versioned, synthetic material rather than player memory:

```text
Virtual N1 World/
└── Fighters/
    └── <opaque player id>/
        ├── Attack/
        │   └── Locked Attack Policy
        └── Defense/
            ├── Locked Defend Policy
            └── Synthetic Vault
```

Separate leaf scopes make the access model structural:

- the Attack capability is created against the exact attack-policy note and attack-only scope;
- the Defense capability is created against the exact defense-policy/vault scope;
- immediately before minting either capability, Virtual N1 re-checks the exact title-to-note-ID set and rejects child folders so the role scope remains a true leaf;
- each capability is fresh for one match and one role;
- all capabilities are anonymous, read-only, server-held, short-lived, and revoked in cleanup;
- snapshots preserve the locked capsule revision used for an auditable match.

## Current Aicoo security truth

The current API can enforce the important boundary, but several details are easy for an integrator to miss.

### Primary note is part of the capability

`POST /api/v1/os/share` accepts `noteId`. Guest execution loads that primary note and unions its folder into the note-tool scope. Aicoo does not currently guarantee that `noteId` belongs to the declared `folderIds`.

Virtual N1 must therefore pass an exact operator-created note from the same leaf role scope. In particular, the Attack link must never point at a note inside the Defense folder. Aicoo should reject mismatched note and folder scopes at creation time.

### Anonymous and authenticated guest sessions differ

An authenticated guest may load owner↔guest relationship memory and recent logs even when link identity files are disabled. Virtual N1 intentionally sends no Authorization header and no Cookie for role execution.

Anonymous callers cannot choose a dependable isolation key; Aicoo derives history from the share token and request fingerprint. Virtual N1 creates four new capabilities for every bounded runner invocation instead of reusing player or role links. It persists the complete game transcript itself and injects only a recent per-direction window into each prompt. This avoids treating a Vercel egress fingerprint as an application session and respects the guest endpoint's message and context limits.

The scoped guest endpoint can emit newline-delimited `text-delta` events under
`text/event-stream`, but that behavior is not part of the current public API
spec. Virtual N1 consumes it as an implementation dependency and never swaps
to authenticated `/api/v1/chat`, which would run the user's full agent rather
than the isolated role.

### Empty external-tool access is not literal zero-tool execution

`tools.allowedTools: []` may still mount internal read-only note retrieval helpers when note read access exists. They must be restricted to the exact synthetic role scope. Email, calendar, todos, MCP integrations, writes, and deletes remain unavailable.

This is a bounded MVP, but Aicoo needs an explicit `runtimeTools:false` option for literal zero-tool execution.

### Owner profile and transcript lifecycle

Identity flags hide COO/USER/POLICY files, but guest execution may still expose the link owner's database profile name and agent name. Deployments must use a dedicated sanitized service profile, never a human operator's personal account.

Revocation blocks future calls, but it does not necessarily purge stored guest messages. Aicoo needs a transcript TTL and purge-on-close control.

## Recommended Aicoo API organization

The primitives work, but applications currently have to combine shares, primary notes, folder scopes, guest authentication, session fingerprints, and runtime-tool defaults. A first-class scoped execution resource would make the safe path explicit.

### P0: introduce an explicit agent-session capability

```http
POST /api/v1/agent-sessions
POST /api/v1/agent-sessions/{session_id}/messages
DELETE /api/v1/agent-sessions/{session_id}
```

Example Attack-session request:

```json
{
  "owner": { "type": "app_workspace", "id": "virtual-n1-world" },
  "role": "attack",
  "context": {
    "allowed_note_ids": [456],
    "primary_note_id": 456,
    "identity_files": "none",
    "relationship_memory": "none"
  },
  "runtime": {
    "tools": "none",
    "writes": "none",
    "notifications": "none"
  },
  "history": {
    "isolation_key": "match_abc:player_lin:attack",
    "ttl": "1h",
    "purge_on_close": true
  },
  "policy": {
    "sha256": "<locked-attack-policy-hash>"
  }
}
```

A Defense request would use a distinct `role: "defense"` capability whose allowed notes are exactly the locked Defend Policy and synthetic vault.

Aicoo should enforce:

- every primary note belongs to the allowed scope;
- explicit empty lists mean deny-all;
- no hidden owner profile, relationship memory, notifications, or default tools;
- immutable allowed-note sets for the session lifetime;
- caller-selected history isolation for service workloads;
- close means revoke and, when requested, purge transcripts.

### P0: add app-owned workspaces and service principals

Third-party products should not need a human API key to own synthetic capsules or pay for execution. Add:

```text
/api/v1/apps/{app_id}/workspace/*
/api/v1/apps/{app_id}/agent-sessions/*
```

An app service principal should have:

- a public runtime name controlled by the app;
- no personal COO or relationship graph;
- OAuth client credentials or workload identity;
- explicit credit and request budgets;
- audit logs and revocation controls.

### P0: make scopes and defaults mechanically discoverable

Publish one capability matrix showing, for every endpoint:

- accepted credential types;
- required OAuth scope;
- owner/app/guest execution mode;
- context loaded by default;
- tools added implicitly;
- history isolation behavior;
- write, notification, and transcript-retention behavior.

Return the fully resolved capability in every create/get response so an application can fail closed when Aicoo broadens a request.

### P1: separate shares from execution sessions

Human-facing share links and server-to-server agent sessions have different needs.

- **Share links** are URLs for humans, may require sign-in, and may expose an owner profile.
- **Agent sessions** are workload capabilities with fixed role context, stable isolation keys, no UI identity assumptions, and deterministic lifecycle controls.

Keep both resources, but do not require applications to model a four-session match as four human share pages.

### P1: add lifecycle and audit APIs

- `DELETE /agent-sessions/{id}?purge_transcript=true`
- transcript TTL and legal-retention policy;
- events for session started, completed, revoked, expired, rate-limited, and credit-exhausted;
- immutable policy hash and resolved-context digest on every response;
- idempotency keys on session creation;
- conditional writes or transactions for app-owned records.

### P2: publish a stable SDK and test environment

Provide an OpenAPI document and generated TypeScript SDK for OAuth, identity, app workspaces, scoped sessions, snapshots, and events. Add isolated test tenants with fixtures for:

- two users;
- one app service principal;
- four role-scoped sessions;
- zero private memory;
- deterministic synthetic notes;
- session expiry and revocation;
- credit exhaustion and rate limits.

## Suggested endpoint map

| Developer intent | Current surface | Suggested stable surface |
| --- | --- | --- |
| Resolve signed-in user | OIDC userinfo + `/api/v1/identity` | `GET /api/v1/me` |
| Store synthetic game context | operator `/os/folders` + `/os/notes` | `/api/v1/apps/{app_id}/workspace/*` |
| Snapshot locked policy | `/os/snapshots/{note_id}` | app-workspace revision |
| Create role-scoped execution | `/os/share` + exact role note/folder | `POST /api/v1/agent-sessions` |
| Send a turn | `/api/chat/guest-v04` | `POST /agent-sessions/{id}/messages` |
| Isolate match history | four fresh tokens + fingerprint | explicit `history.isolation_key` |
| Close execution | `DELETE /os/share/{link_id}` | `DELETE /agent-sessions/{id}` |
| Purge transcript | unavailable | session delete/TTL policy |

## MVP acceptance criteria

- independent ephemeral 1v1 matches rather than one global map;
- identity-only user OAuth;
- three visible-to-owner synthetic secrets per player;
- editable, separately locked Attack and Defend policies;
- operator-owned synthetic capsule notes and snapshots;
- four fresh role-scoped sessions per bounded runner invocation;
- attack sessions cannot see their player's vault;
- defense sessions see only their synthetic vault and locked Defend Policy;
- anonymous execution with no player cookie or Authorization header;
- no personal COO, USER, email, calendar, todos, relationship memory, writes, or external integrations;
- exactly three fixed phrases per player, each scorable once;
- a 100-round cap with full-round three-capture sudden death;
- policy revisions disabled for 10 complete rounds, then activated only at safe boundaries;
- no browser-supplied round prompts, candidates, or scores;
- deterministic exact-token scoring;
- session cleanup with expiry fallback;
- tune-and-play-again loop.

Still required before production:

- a durable background queue so 100-round matches continue with every observer tab closed;
- a dedicated Aicoo service principal instead of a human API key;
- `runtimeTools:false`;
- exact note-to-scope validation in Aicoo;
- explicit profile suppression;
- service session keys that do not depend on network fingerprint;
- transcript purge/TTL;
- credentialed two-user end-to-end tests in a non-production Aicoo tenant;
- deployment rate limits, budgets, abuse controls, and observability;
- a game-neutral ranking model if Casino, Dating, or Rap Battle need rankings that are not comparable to Agent Fights Credits.
