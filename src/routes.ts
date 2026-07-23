export type WorldRoute = 'home' | 'fights' | 'dating' | 'design' | 'not-found';

export function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function resolveWorldRoute(pathname: string): WorldRoute {
  switch (normalizePathname(pathname)) {
    case '/':
      return 'home';
    case '/fights':
      return 'fights';
    case '/dating':
      return 'dating';
    case '/design':
      return 'design';
    default:
      return 'not-found';
  }
}
