export type WorldRoute =
  | 'home'
  | 'world'
  | 'fights'
  | 'dating'
  | 'profile'
  | 'leaderboard'
  | 'design'
  | 'not-found';

export function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function resolveWorldRoute(pathname: string): WorldRoute {
  switch (normalizePathname(pathname)) {
    case '/':
      return 'home';
    case '/world':
      return 'world';
    case '/fights':
      return 'fights';
    case '/dating':
      return 'dating';
    case '/profile':
      return 'profile';
    case '/leaderboard':
      return 'leaderboard';
    case '/design':
      return 'design';
    default:
      return 'not-found';
  }
}
