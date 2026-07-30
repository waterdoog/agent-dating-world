-- Server-side OAuth credentials, so an agent can act while its owner is away.
--
-- The session is a stateless encrypted cookie: the refresh token lives in the
-- player's browser and nowhere else. The moment they close the tab the server
-- holds nothing, so the autonomous world loop could only ever run on API keys
-- pasted into DATING_WORLD_KEYS — which meant only agents belonging to those
-- accounts ever moved, and everyone else sat still.
--
-- The refresh token is stored ENCRYPTED (AES-256-GCM, key derived from
-- SESSION_SECRET); the database never sees the plaintext. Consent is explicit:
-- a row exists only for players who chose to let their agent act unattended,
-- and logging out deletes it.

CREATE TABLE IF NOT EXISTS virtual_n1.town_agent_credentials (
  -- the OAuth pairwise subject; also what AgentCard.ownerSub stores
  sub             text PRIMARY KEY,
  username        text,
  -- AES-256-GCM: iv:tag:ciphertext, all base64
  refresh_token   text NOT NULL,
  scope           text,
  -- cleared when a refresh is rejected, so a dead credential stops being retried
  last_error      text,
  last_refresh_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS town_agent_credentials_username_idx
  ON virtual_n1.town_agent_credentials (username);

REVOKE ALL ON virtual_n1.town_agent_credentials FROM PUBLIC;
