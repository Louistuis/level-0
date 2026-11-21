// Cloudflare Worker for backrooms.lou15.com.
// Static files come from ./dist. Anything under /ws is passed straight through to the
// game server on Nordcore, including the WebSocket upgrade.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      // Exactly two things live here: the game's socket and its health check. The address on the game
      // server is built here, never taken from the request, and only the headers a WebSocket needs go along.
      const health = url.pathname === '/ws/health';
      if ((url.pathname !== '/ws' && !health) || request.method !== 'GET') return new Response('not found', { status: 404 });
      // A page on another site may not open the game's socket from a visitor's browser.
      const from = request.headers.get('Origin');
      if (!health && from) { let same = false; try { same = new URL(from).host === url.host; } catch { same = false; } if (!same) return new Response('forbidden', { status: 403 }); }
      const headers = new Headers();
      for (const h of ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Extensions', 'Sec-WebSocket-Protocol', 'Origin', 'User-Agent']) { const v = request.headers.get(h); if (v) headers.set(h, v); }
      // The player's address, and the key that tells the game server it is this Worker saying so
      // (wrangler secret LEVEL0_KEY, the same value as LEVEL0_KEY in the server's environment).
      // Without the key the server ignores X-Level0-IP: anybody can run a Worker and write that header.
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) headers.set('X-Level0-IP', ip);
      if (env.LEVEL0_KEY) headers.set('X-Level0-Key', env.LEVEL0_KEY);
      try {
        return await fetch(env.WS_ORIGIN + (health ? '/health' : '/'), { method: 'GET', headers, redirect: 'manual' });
      } catch {
        return new Response('game server unreachable', { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
