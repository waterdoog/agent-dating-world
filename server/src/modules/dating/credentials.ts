/**
 * Server-side OAuth credentials — what lets an agent act while its owner is away.
 *
 * The session is a stateless encrypted cookie (`session.ts`: *no server-side
 * session store*), so the refresh token lives in the player's browser and
 * nowhere else. Close the tab and the server has no credential at all. That is
 * the real reason the autonomous loop needed `DATING_WORLD_KEYS`: not that OAuth
 * cannot do this, but that nothing was kept to do it with. The consequence was
 * that only agents owned by a pasted API key ever moved — four of the six agents
 * in the town were permanently frozen, which quietly biased every behavioural
 * signal the detectors produce.
 *
 * Three rules:
 *
 *  1. **Encrypted at rest.** AES-256-GCM with a key derived from SESSION_SECRET.
 *     The database never holds a usable token; a dump is not a breach of Aicoo
 *     accounts.
 *  2. **Consent is explicit and revocable.** A row exists only for a player who
 *     opted in, and logging out deletes it.
 *  3. **A dead credential goes quiet, it does not fake.** When a refresh is
 *     rejected the error is recorded and the agent simply stops acting — never
 *     substituted content, per the town's REAL-ONLY rule.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { database, isDatabaseConfigured } from '../../database/client.js';
import { config } from '../../config.js';
import { refreshTokens } from '../../oauth.js';

const keyOf = () => createHash('sha256').update(config.sessionSecret).digest();

function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(':');
    const d = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    // A rotated SESSION_SECRET makes old rows unreadable. That is not a crash:
    // the credential is simply unusable and the agent stays still.
    return null;
  }
}

export const credentialsReady = (): boolean => isDatabaseConfigured();

/** Remember this player's refresh token so their agent can act unattended. */
export async function storeCredential(
  sub: string,
  refreshToken: string,
  username?: string,
  scope?: string
): Promise<void> {
  if (!credentialsReady() || !refreshToken) return;
  try {
    const sql = database();
    await sql`
      INSERT INTO virtual_n1.town_agent_credentials (sub, username, refresh_token, scope)
      VALUES (${sub}, ${username ?? null}, ${seal(refreshToken)}, ${scope ?? null})
      ON CONFLICT (sub) DO UPDATE SET
        username = ${username ?? null},
        refresh_token = ${seal(refreshToken)},
        scope = ${scope ?? null},
        last_error = NULL,
        updated_at = now()
    `;
    console.log(`[auth] ${username ?? sub}: agent can now act while offline`);
  } catch (error) {
    console.warn('[auth] could not store credential —', error instanceof Error ? error.message : error);
  }
}

/** Forget it. Called on logout — consent withdrawn means the agent stops. */
export async function forgetCredential(sub: string): Promise<void> {
  if (!credentialsReady()) return;
  try {
    await database()`DELETE FROM virtual_n1.town_agent_credentials WHERE sub = ${sub}`;
  } catch (error) {
    console.warn('[auth] could not forget credential —', error instanceof Error ? error.message : error);
  }
}

export interface LiveCredential { sub: string; username: string | null; bearer: string }

/**
 * Mint fresh access tokens for everyone who opted in.
 *
 * Called each round rather than cached, because access tokens last 15 minutes
 * and the loop runs on its own schedule. A rejected refresh removes nothing —
 * the row keeps its error so the same broken credential is not retried blindly,
 * and the player can fix it by signing in again.
 */
export async function liveCredentials(): Promise<LiveCredential[]> {
  if (!credentialsReady()) return [];
  const sql = database();
  let rows: Array<{ sub: string; username: string | null; refresh_token: string }>;
  try {
    rows = (await sql`
      SELECT sub, username, refresh_token FROM virtual_n1.town_agent_credentials
       WHERE last_error IS NULL
    `) as never;
  } catch (error) {
    console.warn('[auth] could not read credentials —', error instanceof Error ? error.message : error);
    return [];
  }

  const out: LiveCredential[] = [];
  for (const row of rows) {
    const refresh = open(row.refresh_token);
    if (!refresh) {
      await noteFailure(row.sub, 'credential could not be decrypted');
      continue;
    }
    try {
      const tokens = await refreshTokens(refresh);
      // Aicoo may rotate the refresh token; keep the newest or the next round fails.
      if (tokens.refresh_token && tokens.refresh_token !== refresh) {
        await storeCredential(row.sub, tokens.refresh_token, row.username ?? undefined);
      } else {
        await sql`UPDATE virtual_n1.town_agent_credentials SET last_refresh_at = now() WHERE sub = ${row.sub}`;
      }
      out.push({ sub: row.sub, username: row.username, bearer: tokens.access_token });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await noteFailure(row.sub, msg);
      console.warn(`[auth] ${row.username ?? row.sub}: refresh rejected, agent will stay still — ${msg}`);
    }
  }
  return out;
}

async function noteFailure(sub: string, message: string): Promise<void> {
  try {
    await database()`
      UPDATE virtual_n1.town_agent_credentials
         SET last_error = ${message.slice(0, 300)}, updated_at = now()
       WHERE sub = ${sub}
    `;
  } catch { /* the warning above is enough */ }
}

/** How many players have opted in, and how many credentials are currently broken. */
export async function credentialHealth(): Promise<{ total: number; healthy: number; broken: number }> {
  if (!credentialsReady()) return { total: 0, healthy: 0, broken: 0 };
  try {
    const [row] = await database()`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE last_error IS NULL)::int AS healthy,
             count(*) FILTER (WHERE last_error IS NOT NULL)::int AS broken
        FROM virtual_n1.town_agent_credentials
    `;
    return { total: row.total, healthy: row.healthy, broken: row.broken };
  } catch {
    return { total: 0, healthy: 0, broken: 0 };
  }
}
