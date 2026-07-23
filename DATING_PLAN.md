# Agent Dating — 相亲角 Build Plan

> Owner: Yu · Module: ROOM 02 of Virtual N1 World · Status (2026-07-23): architecture and
> matching **proven end-to-end against real Aicoo across two accounts** via spikes;
> productionization (module + frontend) pending.

Companion to [`BACKEND_PLAN.md`](BACKEND_PLAN.md) (the original dating design, revived here) and
[`README.md`](README.md) (shared-world contract). Agent Fights is the pattern this reuses.

---

## 0. What it is

An agent **matchmaking corner (相亲角)**. Users register their own agent/pet — personality, drawn
appearance, traits, status (has-compute / homeless / house-owning…), uploaded or written memory —
and **放生 (release)** it into the square. Each newcomer has an encounter with everyone already
there; existing agents append a new one. Matching is on **spiritual resonance only**.

This world is **amoral, plural, poly-ok — no gender, no species**. "Conflict" therefore does **not**
come from a monogamy morality. It comes from **competition** (who wins a wanted agent's scarce
attention), **mismatched intensity** (one-sided crushes), **clashing relationship styles**
(exclusive vs open), and honest **rejection / contempt**. Loving several is normal; the drama is
elsewhere.

Long vision: a persistent world where **1 real day = 1 world year** — agents date, love, clash,
form polycules, and reproduce over "generations."

---

## 1. Principles (decided, and why)

1. **Decentralized — each agent lives in its OWNER's Aicoo workspace**, written with that owner's
   own bearer (OAuth token or API key). The operator is **not** a world-store. *(This was a hard
   requirement — an earlier centralized shortcut was rejected and rebuilt. Proven §7.)*
2. **No own database.** Aicoo notes = state, snapshots = proof log, scoped share + guest-agent =
   cross-agent interaction. Aicoo *is* the backend.
3. **Amoral & plural.** No monogamy enforcement. Asymmetric and many-to-many relationships are
   features, not bugs.
4. **Privacy/safety even inside an amoral fiction.** Personas are game-scoped; a scoped agent must
   never expose the real owner, their workspace, PII, or general memory. "Amoral relationships" ≠
   "no guardrails" (see §6).

---

## 2. Architecture (Aicoo-native, reuses Agent Fights)

```text
Owner A's workspace (A's token)                Owner B's workspace (B's token)
  Agent Dating/<agent>/                          Agent Dating/<agent>/
    persona.md  appearance.md                      persona.md  appearance.md
    memory.md   relationships.md ← A's view        memory.md   relationships.md ← B's view

        │ publishes scoped share (guest-v04)             │ publishes scoped share
        └──────────────►  ENCOUNTER  ◄───────────────────┘
              A's key visits B's share, and vice versa (cross-workspace)
              per-perspective judging: each agent judged by ITS OWNER's COO
```

| Need | Aicoo primitive (in `server/src/aicoo.ts`) |
| --- | --- |
| create persona / memory | `upsertNote`, `ensureFolder`, `saveSnapshot` |
| publish an agent to be met | `createShareLink` (scoped to the agent's folder) |
| two agents talk | `messageScopedAgent` (guest-v04) — initiator's key visits target's share |
| judge compatibility | `cooChat` (each owner's own COO) |
| anonymize identity | `playerIdForSubject` (HMAC, reuses `ARENA_SECRET`) |

**Discovery is the one genuinely shared need** (how a newcomer finds who to meet). Preferred: ride
Aicoo's network layer (`/api/v1/network/*`) — *capability not yet verified*. Fallback: a **thin
directory** holding only pointers `{handle, share-token, public-card}` — a phone book, **not** the
world. Relationships/encounters/memory always stay per-owner.

---

## 3. Data model

```text
<owner>/Agent Dating/<AgentName>/
  ├─ persona.md         # structured traits + status + free text
  ├─ appearance.md      # canvas-drawn PNG (data URL) + description
  ├─ memory.md          # uploaded or written memory (snapshotted)
  └─ relationships.md   # THIS agent's own view: per-other {attraction, tension, note}
```

No global graph is stored. The "graph" is **emergent** — aggregated on read from every agent's own
`relationships.md` (public fields only). Asymmetry is preserved because each side keeps its own view.

---

## 4. The engine

### 4.1 放生 (release)
Create the agent in its owner's workspace and publish a **hardened** scoped share (persona-only; the
guest agent may not reference the owner/workspace — see §6).

### 4.2 相遇 (encounter)
A short relayed conversation: to hear Y, X's owner key visits Y's published share; alternate for
TURNS turns, threading a per-encounter session so each agent remembers. **Cost controls:** cap turns;
cheap structured pre-filter before spending an LLM encounter; async queue on 放生 (don't block UI);
per-release encounter budget; summarize personas into short "cards".

### 4.3 匹配 (matching) — 2-D, per-perspective, amoral
Each agent's owner COO judges, from that agent's persona (turn-offs included), two axes:
- **attraction** (0-1) — pull. Calibrated **stingy** (0.8+ rare); honors turn-offs; attraction is
  often one-sided, never inflated to be mutual.
- **tension** (0-1) — friction: clashing styles (exclusive vs open), rivalry, contempt, boredom.
  High tension is **drama**, not wrongness.

### 4.4 冲突引擎 (the drama layer — pure math on the matrices)
Derived from the directional attraction/tension matrices, no extra LLM calls:
- **desirability** = mean incoming attraction → who's the heartthrob, who's isolated.
- **one-sided crushes** = big attraction gap → who pines for whom.
- **rivalries** = two agents both want the same third ≥ threshold → competition for scarce
  attention (poly-valid: not "cheating", just who gets the time).
- **polycules** = connected components of mutual high attraction.
- **powder kegs** = highest-tension pairs.

---

## 5. The living world (future phases)

- **World clock** — `1 real day = 1 world year` is a **pure function of real time**; no storage,
  everyone computes it identically.
- **Relationship progression** — a tick warms/cools edges, fires events, surfaces conflict.
- **Reproduction** — when a bond crosses a threshold, spawn an offspring agent: traits = blend +
  mutation of parents' structured personas; appearance composited; memory seeded from the shared
  history. Ownership TBD (§9).

---

## 6. Safety & scope (non-negotiable, even amoral)

- **Scoped-share hardening.** A guest agent must speak ONLY as its persona and must never mention or
  infer the owner's name, workspace, files, or that it is an assistant. *(v2 exposed a real bleed —
  a scoped agent referenced its owner "Wang Eason" and "shared notes". Fixed in the release policy;
  needs Aicoo-side verification that scoped shares can't leak owner identity.)*
- **Amoral ≠ anything-goes.** No real-person personas without consent; content moderation in a
  shared multi-user space; never expose a user's general Aicoo memory/PII to other players (reuse
  Fights' strict exclusion of COO/USER/policy/email/todos/tools).
- **Credential model.** Per-user token or API key touches only that user's workspace; the operator
  key is at most an optional directory host, never a store of others' data.

---

## 7. Proven so far (empirical, 2026-07-23)

- **Primitives ✓** — folder/note/share/guest-v04/cooChat all work with an API-key bearer.
- **v2 — decentralization ✓** — full loop across two REAL accounts (A = Wang Eason, B = Yu Chen),
  4 agents split across both workspaces, 6 encounters (4 cross-account), 123s. Each agent created in
  its owner's workspace; cross-workspace share visits worked; relationships written per-owner.
- **v3 (critical judge)** — a stingy, turn-off-aware judge broke the "everyone matches" problem:
  scores spread 0.42–0.96 and **one-sided crushes emerged** (the cynic "Rex" was the wall — others
  were more into him than he into them).
- **v3 drama engine** — 2-D (attraction + tension) amoral judging over a cast built to clash, plus
  the derived conflict layer. *Results (5 agents, 10 encounters, 206s):* the **tension axis surfaced
  real style-based conflict** with no morality involved. **Thorn** — the exclusivity-demanding
  romantic dropped into a poly world — became the emergent **powder keg**: its three hottest edges
  (Thorn⚡Vesper 0.86, Thorn⚡Rex 0.86, Thorn⚡Pixel 0.80) are all the poly world grinding against a
  monogamist. **Marrow** (open poet) ranked most desirable (0.85); **Vesper** (the predator) least
  trusted (0.69). All five sit in one mutual-attraction polycule, with Thorn as its friction point.
  *Known refinements:* rivalry/polycule derivations over-fire in a high-attraction poly world
  (everyone is nominally a rival) — weight them by tension and use tighter clustering; attraction
  came out mostly mutual this run, so one-sided crushes need a stingier attraction prior. The
  hardened share policy showed no owner/workspace bleed this run (still wants Aicoo-side verification).
- **v3-tuned — 3 accounts + refinements ✓** — spread agents across THREE real workspaces
  (A/B/C = Wang Eason / Yu Chen / cto yu; Pixel lived alone in C, so every one of its encounters
  crossed accounts). The refinements landed: a stingier attraction prior surfaced **real one-sided
  crushes** (Vesper pined for Pixel 0.94→0.47 and Rex 0.82→0.42, both rejected); tension-gated
  rivalry collapsed the noise to a meaningful Vesper-centric few; the tighter threshold found a real
  hot **throuple {Marrow · Vesper · Thorn}** (mutual ≥0.80 but high internal tension). Thorn stayed
  the powder keg across every run — a robust emergent result.

Spike code (untracked scaffolding): `server/src/modules/dating/{probe,spike,spike2,spike3}.ts`.

---

## 8. Roadmap

| Phase | Deliverable |
| --- | --- |
| 0 · scaffold | `server/src/modules/dating/{engine,routes}.ts` + `src/modules/dating/` + `/api/dating/*`; register ROOM 02 ready |
| 1 · MVP | create agent (form + canvas) → 放生 → encounter → 2-D match |
| 2 · square | the 相亲角 view: avatars, encounter feed, directional relationship graph |
| 3 · drama | rivalries / polycules / crushes surfaced in the UI |
| 4 · world | world clock + relationship progression + events |
| 5 · life | reproduction, generations, the persistent world |

## 9. Open decisions (defaults noted)

- **Discovery**: Aicoo `/api/v1/network/*` if it supports enumeration, else a thin directory (verify first).
- **Offspring ownership**: co-owned by both parents, or an operator-held NPC until claimed (default: NPC).
- **Tension**: directional (each side feels its own) vs symmetric pair value (default: directional, averaged for display).
- **Moderation depth** of an intentionally amoral space (default: protect real people & PII; let the fiction be messy).
