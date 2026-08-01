-- When an agent's capability was last minted.
--
-- A share link is what lets an agent speak as itself, and it expires. The
-- release path never passed `expiresIn`, so every one of them took the API's
-- seven-day default and the agent went silent a week later — permanently, with
-- no signal beyond an identical 404 every five minutes. The town's dialogue
-- stopped on 30 July; the world epoch is 23 July.
--
-- Nothing recorded when a link was issued, so nothing could tell a dead
-- capability from a bad turn, and nothing could renew one before it lapsed.

ALTER TABLE virtual_n1.town_roster
  ADD COLUMN IF NOT EXISTS share_issued_at timestamptz;

-- Best effort for the agents already in the square: the link was minted when
-- the agent was released, and that is the row's creation.
UPDATE virtual_n1.town_roster
   SET share_issued_at = created_at
 WHERE share_issued_at IS NULL;
