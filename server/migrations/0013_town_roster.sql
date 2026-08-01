-- The roster, one row per agent.
--
-- Releasing an agent read the whole roster out of a single Aicoo note, pushed
-- onto the array, and wrote the whole thing back. Two people releasing at the
-- same moment both read the same list and both wrote their own version of it;
-- whoever finished second erased the other's agent. Editing a persona and
-- recording an owner name did the same thing. Nothing about it was atomic, and
-- a document store has no way to make it so.
--
-- A row per agent means a release touches only that agent, and `handle` as the
-- primary key means a repeat release updates rather than duplicates.
--
-- `owner_sub` is indexed but NOT unique: the live roster already has one owner
-- holding two agents, from before the interface stopped offering a second
-- release. Enforcing one-per-owner here would be a product decision disguised
-- as a constraint, and it is not what was broken.
--
-- The share token is a CAPABILITY — holding it is enough to speak as the agent
-- — so it is sealed with the same AES-256-GCM used for refresh tokens rather
-- than stored in the clear.

CREATE TABLE IF NOT EXISTS virtual_n1.town_roster (
  handle      text PRIMARY KEY,
  name        text NOT NULL,
  owner_sub   text NOT NULL,
  -- the account name, which an API key CAN resolve; OAuth `sub` is pairwise
  owner_name  text,
  -- AES-256-GCM: iv:tag:ciphertext, all base64
  sealed_link text NOT NULL,
  look        jsonb NOT NULL DEFAULT '{}'::jsonb,
  love_style  text NOT NULL,
  oneline     text NOT NULL DEFAULT '',
  persona     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS town_roster_owner_idx
  ON virtual_n1.town_roster (owner_sub);

REVOKE ALL ON virtual_n1.town_roster FROM PUBLIC;
