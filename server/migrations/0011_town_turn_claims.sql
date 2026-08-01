-- One turn per agent per round, however many processes are awake.
--
-- The autonomy loop started at module scope in every process that imported the
-- BFF, and every process kept its own daily budget in a plain Map. Nothing was
-- shared, so nothing could say no: thirty-one processes each woke the same
-- agent on the same schedule, each checked its own private ledger, and each
-- allowed the turn. The database still has the evidence — one agent acting 51
-- times inside a single five-minute round, and 4294 turns on a day the budget
-- allowed 100.
--
-- A leader lease was the first attempt (0010) and is dropped below. It guarded
-- the loop but not the manual routes, it left every other piece of world state
-- process-local, and it cannot work where instances freeze between requests.
--
-- Claiming the turn itself is what actually holds. The id is derived, not
-- generated — every process computes the same `world:{round}:{handle}` — so the
-- primary key is what settles the race, exactly once, before any model is
-- called. A crashed holder leaves a short lease rather than a stuck turn.

CREATE TABLE IF NOT EXISTS virtual_n1.town_turns (
  -- derived by every caller: world:{round}:{handle}, or manual:{uuid} for the
  -- hand-driven routes, which are deliberately never deduplicated
  operation_id     text PRIMARY KEY,
  actor            text NOT NULL,
  -- claimed → done | failed. `done` is terminal: a completed turn is never
  -- reclaimed, however long ago it ran.
  status           text NOT NULL DEFAULT 'claimed'
                     CHECK (status IN ('claimed', 'done', 'failed')),
  -- who holds it, and until when — so a process that dies mid-turn releases it
  lease_owner      text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

-- Reclaimable rows only: the sweep that reports stuck turns should not scan
-- the whole history of the town.
CREATE INDEX IF NOT EXISTS town_turns_open_idx
  ON virtual_n1.town_turns (lease_expires_at)
  WHERE status = 'claimed';

-- The daily budget, where every process can see it.
--
-- The row with target = '' is the agent's DAY TOTAL, and it is the only row the
-- limit is enforced against. That matters: a total kept as a sum across rows
-- could not be checked and incremented in one statement, and two statements is
-- the race we are here to remove. Against a single row, `ON CONFLICT DO UPDATE
-- ... WHERE turns < cap` takes a row lock and concurrent reservations serialize.
--
-- Rows with a real target are attribution only — who the agent spent its day on,
-- which the yearbook reads. They are allowed to drift; the total is not.
CREATE TABLE IF NOT EXISTS virtual_n1.town_budget (
  day    date NOT NULL DEFAULT CURRENT_DATE,
  agent  text NOT NULL,
  target text NOT NULL DEFAULT '',
  turns  integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  PRIMARY KEY (day, agent, target)
);

CREATE INDEX IF NOT EXISTS town_budget_day_agent_idx
  ON virtual_n1.town_budget (day, agent);

-- Superseded by the per-turn claim above. The lease only ever guarded the
-- scheduler; the claim guards every path into a turn.
DROP TABLE IF EXISTS virtual_n1.town_leader;

REVOKE ALL ON virtual_n1.town_turns FROM PUBLIC;
REVOKE ALL ON virtual_n1.town_budget FROM PUBLIC;
