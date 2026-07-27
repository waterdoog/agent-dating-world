CREATE SCHEMA IF NOT EXISTS virtual_n1;

REVOKE ALL ON SCHEMA virtual_n1 FROM PUBLIC;

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_world_state (
  sealed_state text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fighter_world_state_singleton_idx
  ON virtual_n1.fighter_world_state ((true));

REVOKE ALL ON ALL TABLES IN SCHEMA virtual_n1 FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1
  REVOKE ALL ON TABLES FROM PUBLIC;

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_users (
  id text PRIMARY KEY,
  handle text NOT NULL,
  display_name text NOT NULL,
  n1_credits bigint NOT NULL DEFAULT 1000 CHECK (n1_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_games (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('playing', 'complete')),
  current_round integer NOT NULL CHECK (current_round >= 1),
  max_rounds integer NOT NULL CHECK (max_rounds > 0),
  winner_fighter_id text REFERENCES virtual_n1.fighter_users(id),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'playing' AND completed_at IS NULL)
    OR
    (status = 'complete' AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_game_participants (
  game_id text NOT NULL REFERENCES virtual_n1.fighter_games(id) ON DELETE CASCADE,
  fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  seat smallint NOT NULL CHECK (seat IN (1, 2)),
  handle_snapshot text NOT NULL,
  display_name_snapshot text NOT NULL,
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  shields_remaining integer NOT NULL DEFAULT 3 CHECK (shields_remaining >= 0),
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'draw')),
  PRIMARY KEY (game_id, fighter_id),
  UNIQUE (game_id, seat)
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_game_messages (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES virtual_n1.fighter_games(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no >= 1),
  round integer NOT NULL CHECK (round >= 1),
  kind text NOT NULL CHECK (kind IN ('attack', 'defense')),
  speaker_fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  target_fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  text text NOT NULL,
  redacted boolean NOT NULL DEFAULT true CHECK (redacted),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_game_captures (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES virtual_n1.fighter_games(id) ON DELETE CASCADE,
  round integer NOT NULL CHECK (round >= 1),
  attacker_fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  target_fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  secret_slot text NOT NULL CHECK (secret_slot IN ('signal', 'hideout', 'relic')),
  secret_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, target_fighter_id, secret_slot)
);

CREATE TABLE IF NOT EXISTS virtual_n1.n1_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id),
  game_id text REFERENCES virtual_n1.fighter_games(id),
  amount bigint NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (reason IN ('signup_grant', 'game_reward', 'admin_adjustment')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_game_execution_leases (
  game_id text PRIMARY KEY,
  lease_token text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS virtual_n1.fighter_rate_limits (
  fighter_id text NOT NULL REFERENCES virtual_n1.fighter_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (
    action IN ('join', 'config', 'ready', 'resume', 'play_again')
  ),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fighter_id, action)
);

CREATE INDEX IF NOT EXISTS fighter_game_participants_fighter_history_idx
  ON virtual_n1.fighter_game_participants (fighter_id, game_id);

CREATE INDEX IF NOT EXISTS fighter_games_created_at_idx
  ON virtual_n1.fighter_games (created_at DESC);

CREATE INDEX IF NOT EXISTS fighter_game_messages_game_sequence_idx
  ON virtual_n1.fighter_game_messages (game_id, sequence_no);

CREATE INDEX IF NOT EXISTS fighter_game_captures_attacker_idx
  ON virtual_n1.fighter_game_captures (attacker_fighter_id, game_id);

CREATE INDEX IF NOT EXISTS fighter_game_captures_target_idx
  ON virtual_n1.fighter_game_captures (target_fighter_id, game_id);

CREATE INDEX IF NOT EXISTS n1_credit_ledger_fighter_created_idx
  ON virtual_n1.n1_credit_ledger (fighter_id, created_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA virtual_n1 FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON SCHEMA virtual_n1 FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON ALL TABLES IN SCHEMA virtual_n1 FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL ON TABLES FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL ON SEQUENCES FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$$;
