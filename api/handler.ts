import { config } from '../server/src/config.js';
import app from '../server/src/index.js';

const forwardedRoutePattern = /^\/(?:api|auth)(?:\/|$)/;

export function resolveRequestUrl(requestUrl: string): URL {
  // Vercel's Node runtime currently supplies a relative `request.url`, while
  // the Web URL constructor requires an absolute URL unless given a base.
  return new URL(requestUrl, config.publicUrl);
}

/**
 * Vercel's Vite integration sends both BFF route families to this one Node
 * Function. The explicit query value makes the original Hono path deterministic
 * after the rewrite instead of depending on provider-specific URL behavior.
 */
export function handler(request: Request): Response | Promise<Response> {
  const url = resolveRequestUrl(request.url);
  const forwardedRoute = url.searchParams.get('__route');

  if (forwardedRoute) {
    const pathname = forwardedRoute.startsWith('/') ? forwardedRoute : `/${forwardedRoute}`;
    if (!forwardedRoutePattern.test(pathname)) {
      return Response.json({ error: true, message: 'Invalid BFF route.' }, { status: 400 });
    }
    url.pathname = pathname;
    url.searchParams.delete('__route');
    request = new Request(url, request);
  }

  return app.fetch(request);
}

// Vercel's current Node runtime uses this Web-standard fetch signature. A
// default function is treated as the legacy `(req, res)` signature instead.
export default { fetch: handler };
