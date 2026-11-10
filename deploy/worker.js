// Cloudflare Worker for backrooms.lou15.com.
// Static files come from ./dist. Anything under /ws is passed straight through to the
// game server on Nordcore, including the WebSocket upgrade.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      const target = env.WS_ORIGIN + (url.pathname.slice(3) || '/') + url.search;
      const headers = new Headers(request.headers);
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) headers.set('X-Level0-IP', ip);
      try {
        return await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });
      } catch {
        return new Response('game server unreachable', { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
