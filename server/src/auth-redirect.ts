const SAFE_RETURN_PATHS = new Set(['/', '/world', '/fights', '/design', '/profile']);

export function normalizeReturnTo(value: string | null | undefined): string {
  if (!value?.trim()) return '/';

  const candidate = value.trim();
  if (candidate.includes('\\') || /[\u0000-\u001f\u007f]/.test(candidate)) return '/';

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return '/';
  }

  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (decoded.startsWith('//') || decoded.includes('\\')) return '/';

  let target: URL;
  try {
    target = new URL(candidate, 'https://virtual-n1.local');
  } catch {
    return '/';
  }

  if (target.origin !== 'https://virtual-n1.local') return '/';
  const pathname = target.pathname === '/' ? '/' : target.pathname.replace(/\/+$/, '');
  return SAFE_RETURN_PATHS.has(pathname) ? pathname : '/';
}

export function authResultUrl(
  spaUrl: string,
  returnTo: string | null | undefined,
  result: { login: 'ok' } | { loginError: string }
): string {
  const target = new URL(normalizeReturnTo(returnTo), `${spaUrl.replace(/\/$/, '')}/`);
  if ('login' in result) {
    target.searchParams.set('login', result.login);
  } else {
    target.searchParams.set('login_error', result.loginError);
  }
  return target.toString();
}
