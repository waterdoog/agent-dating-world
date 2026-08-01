-- What the town wrote about itself.
--
-- Beats are facts and already live in `town_events`; a story thread is nothing
-- but its beats and rebuilds from them. But the layer ON TOP of the beats —
-- the title, the arc, the open question, the world digest — is not derived. It
-- is a real model call, and it was held in a module-level Map.
--
-- So it was lost on every restart, and `tsx watch` restarts on every keystroke.
-- The code even said so: "the narrated title/arc is lost on a restart and
-- regenerates on the next beat". That is the whole answer to why the story
-- lines and the yearly summaries appeared to reset themselves — nothing was
-- resetting them, they were never written down.
--
-- It also meant each process narrated its own version of the same thread, so
-- which story you were told depended on which process answered.
--
-- One table for every authored piece, keyed by what it is about:
--
--   thread:{a}~{b}          the narration of one pair's story line
--   digest                  the current world digest
--
-- `value` is jsonb rather than columns because these are three different shapes
-- and none of them is ever queried by field — they are read whole, by key.

CREATE TABLE IF NOT EXISTS virtual_n1.town_narration (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  -- the model run that wrote it, so a line in the feed stays traceable
  run_id     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS town_narration_updated_idx
  ON virtual_n1.town_narration (updated_at DESC);

REVOKE ALL ON virtual_n1.town_narration FROM PUBLIC;
