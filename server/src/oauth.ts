/**
 * "Login with Aicoo" — OAuth 2 authorization-code + PKCE client.
 *
 * The BFF is a pre-registered confidential client. Aicoo intentionally
 * disables anonymous dynamic client registration.
 */
import { createHash, randomBytes } from 'node:crypto';
import { APP_SCOPES, config, oauthPaths, redirectUri, v1Resource } from './config.js';

interface ClientCredentials {
  clientId: string;
  /** Empty for public (PKCE-only) clients. */
  clientSecret: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export function base64url(input: Buffer): string {
  return input.toString('base64url');
}

export function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Resolve the OAuth client credentials configured by the operator.
 */
export async function getClient(): Promise<ClientCredentials> {
  if (config.clientId && config.clientSecret) {
    return { clientId: config.clientId, clientSecret: config.clientSecret };
  }
  throw new Error(
    'AICOO_CLIENT_ID and AICOO_CLIENT_SECRET are required; register the callback in Aicoo first.'
  );
}

export async function buildAuthorizeUrl(state: string, codeChallenge: string): Promise<string> {
  const { clientId } = await getClient();
  const url = new URL(oauthPaths.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', APP_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', v1Resource);
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const { clientId, clientSecret } = await getClient();
  // Confidential clients authenticate with Basic; public clients pass
  // client_id in the body and prove possession via PKCE.
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams(params);
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
  }
  const res = await fetch(oauthPaths.token, {
    method: 'POST',
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Token endpoint error (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as TokenSet;
}

export function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    resource: v1Resource,
  });
}

export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    resource: v1Resource,
  });
}

export async function revokeToken(token: string): Promise<void> {
  const { clientId, clientSecret } = await getClient();
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams({ token });
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
  }
  const res = await fetch(oauthPaths.revoke, {
    method: 'POST',
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Token revocation failed (${res.status})`);
  }
}

export interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(oauthPaths.userinfo, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`userinfo failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as UserInfo;
}
