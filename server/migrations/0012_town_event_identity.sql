-- One event per turn, and one feed for every process.
--
-- The feed was a 25-entry array in each process, hydrated once at boot and
-- written back to a single Aicoo note in full on every append. Two processes
-- appending in the same moment each wrote their own copy of the whole array,
-- so the later write silently dropped the earlier one's event — a lost update
-- against a document store standing in for a database.
--
-- Postgres already had the events; nothing read them. Only the world loop
-- called saveEvent, so manual ticks, chance encounters and the director's beats
-- never landed here at all, and every detector that queries by pair, by place
-- or by time was reasoning over a fraction of what happened.
--
-- `operation_id` closes the last gap the turn claim leaves open: a process that
-- inserts an event and dies before marking the turn done leaves a lease that
-- expires, and the turn is legitimately retaken. The unique index means the
-- retry cannot add a second version of a beat that already happened.
--
-- Nullable by design — a hand-driven turn is a distinct event every time and
-- carries no operation id. Postgres treats each NULL as distinct, so those rows
-- are unconstrained while claimed turns are deduplicated.

ALTER TABLE virtual_n1.town_events
  ADD COLUMN IF NOT EXISTS operation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS town_events_operation_idx
  ON virtual_n1.town_events (operation_id)
  WHERE operation_id IS NOT NULL;
