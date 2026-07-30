-- 相亲小镇 · durable world state
--
-- Everything here used to live in module-level Maps (lost on every restart) or
-- in Aicoo notes (a document store standing in for a database). Money, wanted
-- levels, who-knows-what and the event stream are all things the town needs to
-- query by person, by time and by place — that is SQL's job.

CREATE SCHEMA IF NOT EXISTS virtual_n1;

-- ── the public ledger: money and heat ────────────────────────────────
CREATE TABLE IF NOT EXISTS virtual_n1.town_agents (
  agent          text PRIMARY KEY,
  purse          integer NOT NULL DEFAULT 200 CHECK (purse >= 0),
  wanted_level   smallint NOT NULL DEFAULT 0 CHECK (wanted_level BETWEEN 0 AND 5),
  wanted_at      timestamptz,
  wanted_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── what someone is carrying ─────────────────────────────────────────
-- A gift is only possible if the agent really went and bought one first; that
-- trip is the costly signal, not the object.
CREATE TABLE IF NOT EXISTS virtual_n1.town_items (
  id        bigserial PRIMARY KEY,
  agent     text NOT NULL,
  item      text NOT NULL,
  bought_at timestamptz NOT NULL DEFAULT now(),
  spent_on  text,
  spent_at  timestamptz
);
CREATE INDEX IF NOT EXISTS town_items_held_idx
  ON virtual_n1.town_items (agent) WHERE spent_at IS NULL;

-- ── who knows what about whom ────────────────────────────────────────
-- The carrier of information asymmetry: a rumour one agent holds and another
-- does not is the difference between "I heard" and "I can see you from here".
CREATE TABLE IF NOT EXISTS virtual_n1.town_knowledge (
  id     bigserial PRIMARY KEY,
  holder text NOT NULL,
  about  text NOT NULL,
  fact   text NOT NULL,
  source text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS town_knowledge_holder_idx
  ON virtual_n1.town_knowledge (holder, at DESC);

-- ── directed relationship readings ───────────────────────────────────
-- One row per (agent → other): how A feels about B is not how B feels about A.
-- `guess_*` is A's THEORY OF MIND — what it believes B feels back. The gap
-- between the guess and the other row's truth is where misreading, one-sided
-- love and missed timing come from, so the two are stored separately on purpose.
CREATE TABLE IF NOT EXISTS virtual_n1.town_relationships (
  agent            text NOT NULL,
  other            text NOT NULL,
  attraction       real NOT NULL DEFAULT 0.25 CHECK (attraction BETWEEN 0 AND 1),
  trust            real NOT NULL DEFAULT 0.30 CHECK (trust BETWEEN 0 AND 1),
  tension          real NOT NULL DEFAULT 0.15 CHECK (tension BETWEEN 0 AND 1),
  -- reserved for the five-dimension migration (curiosity/attachment/possessiveness);
  -- nullable so existing rows stay valid until they are seeded
  curiosity        real CHECK (curiosity BETWEEN 0 AND 1),
  attachment       real CHECK (attachment BETWEEN 0 AND 1),
  possessiveness   real CHECK (possessiveness BETWEEN 0 AND 1),
  guess_attraction real CHECK (guess_attraction BETWEEN 0 AND 1),
  guess_trust      real CHECK (guess_trust BETWEEN 0 AND 1),
  note             text NOT NULL DEFAULT '',
  beats            integer NOT NULL DEFAULT 0,
  at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, other)
);

-- ── the event stream ─────────────────────────────────────────────────
-- Feed, trajectory detectors and the director all read from here. Every row
-- carries the model run ids, so any line on screen traces back to a real call.
CREATE TABLE IF NOT EXISTS virtual_n1.town_events (
  id               bigserial PRIMARY KEY,
  actor            text NOT NULL,
  target           text,
  act              text,
  move             text,
  silent           boolean NOT NULL DEFAULT false,
  message          text,
  reply            text,
  lines            jsonb,
  observable       text,
  attraction       real,
  trust            real,
  tension          real,
  guess_attraction real,
  guess_trust      real,
  severity         text,
  headline         text,
  summary          text,
  consequence      text,
  followup         text,
  destination      text,
  decide_run_id    text,
  reply_run_id     text,
  status           text,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS town_events_at_idx ON virtual_n1.town_events (at DESC);
CREATE INDEX IF NOT EXISTS town_events_pair_idx ON virtual_n1.town_events (actor, target, at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA virtual_n1 FROM PUBLIC;
