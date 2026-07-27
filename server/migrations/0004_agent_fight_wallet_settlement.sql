ALTER TABLE virtual_n1.fighter_games
  ADD COLUMN n1_stake bigint NOT NULL DEFAULT 0 CHECK (n1_stake >= 0);

CREATE TABLE virtual_n1.fighter_game_credit_settlements (
  game_id text NOT NULL,
  fighter_id text NOT NULL,
  amount bigint NOT NULL,
  settlement_version smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, fighter_id),
  FOREIGN KEY (game_id, fighter_id)
    REFERENCES virtual_n1.fighter_game_participants (game_id, fighter_id),
  CHECK (
    (settlement_version = 0 AND amount = 0)
    OR
    (settlement_version = 1 AND amount IN (-200, 0, 200))
  )
);

-- Matches completed before wallet settlement launched remain neutral. This
-- marker prevents a later archive reconciliation from charging them.
INSERT INTO virtual_n1.fighter_game_credit_settlements (
  game_id,
  fighter_id,
  amount,
  settlement_version
)
SELECT
  game.id,
  participant.fighter_id,
  0,
  0
FROM virtual_n1.fighter_games AS game
JOIN virtual_n1.fighter_game_participants AS participant
  ON participant.game_id = game.id
ON CONFLICT (game_id, fighter_id) DO NOTHING;

ALTER TABLE virtual_n1.n1_credit_ledger
  DROP CONSTRAINT IF EXISTS n1_credit_ledger_reason_check;

ALTER TABLE virtual_n1.n1_credit_ledger
  ADD CONSTRAINT n1_credit_ledger_reason_check
  CHECK (
    reason IN (
      'signup_grant',
      'game_reward',
      'game_settlement',
      'admin_adjustment'
    )
  );

CREATE UNIQUE INDEX n1_credit_ledger_game_settlement_idx
  ON virtual_n1.n1_credit_ledger (game_id, fighter_id, reason)
  WHERE game_id IS NOT NULL AND reason = 'game_settlement';

COMMENT ON COLUMN virtual_n1.fighter_games.n1_stake IS
  'Per-player N1 Credit settlement amount fixed when the game is first archived. Existing games remain at zero.';

COMMENT ON TABLE virtual_n1.fighter_game_credit_settlements IS
  'One immutable wallet outcome per game participant, including zero-credit draws and legacy matches.';
