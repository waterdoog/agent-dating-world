/**
 * Encryption at rest for the capabilities the town has to keep.
 *
 * Two different things need this: the OAuth refresh token that lets an agent act
 * while its owner is away, and the scoped share token that lets anyone speak to
 * an agent as itself. Both are capabilities rather than identifiers — holding
 * one is enough to use it — so neither belongs in a table in the clear, and the
 * repository's own migration guard exists to catch exactly that.
 *
 * AES-256-GCM with a key derived from SESSION_SECRET. The authentication tag
 * means a tampered row fails to open rather than decrypting to something else.
 * A dump of the database is not a breach of anyone's Aicoo account.
 *
 * Lifted out of `credentials.ts`, where it lived while only one caller needed
 * it. Copying twelve lines of crypto is how two implementations drift apart.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

const keyOf = () => createHash('sha256').update(config.sessionSecret).digest();

/** `iv:tag:ciphertext`, all base64. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

/**
 * Open a sealed value, or null if it cannot be opened.
 *
 * A rotated SESSION_SECRET makes every existing row unreadable. That is not a
 * crash: the capability is simply unusable, and the caller's job is to go quiet
 * rather than to substitute something.
 */
export function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(':');
    const d = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
