import { randomBytes } from 'node:crypto';
import { database, isDatabaseConfigured } from './client.js';
import { DatabaseUnavailableError } from './repository.js';

const EXECUTION_LEASE_MS = 330_000;

function leaseExpiry(): string {
  return new Date(Date.now() + EXECUTION_LEASE_MS).toISOString();
}

/**
 * Claims one match runner across every Vercel instance. A crashed invocation
 * leaves only a short lease, so either player's next observer poll can resume
 * the deterministic turn sequence after it expires.
 */
export async function claimGameExecution(
  gameId: string
): Promise<string | null> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  try {
    const leaseToken = randomBytes(24).toString('base64url');
    const rows = await database()<Array<{ lease_token: string }>>`
      INSERT INTO virtual_n1.fighter_game_execution_leases AS current_lease (
        game_id,
        lease_token,
        lease_expires_at
      )
      VALUES (${gameId}, ${leaseToken}, ${leaseExpiry()})
      ON CONFLICT (game_id) DO UPDATE SET
        lease_token = EXCLUDED.lease_token,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = now()
      WHERE current_lease.lease_expires_at < now()
      RETURNING lease_token
    `;
    return rows[0]?.lease_token === leaseToken ? leaseToken : null;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    throw new DatabaseUnavailableError('The Fighter match runner is unavailable.');
  }
}

export async function renewGameExecution(
  gameId: string,
  leaseToken: string
): Promise<boolean> {
  if (!isDatabaseConfigured()) throw new DatabaseUnavailableError();
  try {
    const rows = await database()<Array<{ game_id: string }>>`
      UPDATE virtual_n1.fighter_game_execution_leases
      SET lease_expires_at = ${leaseExpiry()},
          updated_at = now()
      WHERE game_id = ${gameId}
        AND lease_token = ${leaseToken}
      RETURNING game_id
    `;
    return rows.length === 1;
  } catch {
    throw new DatabaseUnavailableError('The Fighter match lease could not be renewed.');
  }
}

export async function releaseGameExecution(
  gameId: string,
  leaseToken: string
): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    await database()`
      DELETE FROM virtual_n1.fighter_game_execution_leases
      WHERE game_id = ${gameId}
        AND lease_token = ${leaseToken}
    `;
  } catch {
    // Lease expiry remains the recovery backstop. Never log a driver error,
    // because connection errors can include server metadata.
    console.error(`[fighter-world] could not release the runner lease for ${gameId}.`);
  }
}
