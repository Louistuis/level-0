// Cloudflare Worker for backrooms.lou15.com.
// Static files come from ./dist. Anything under /ws is passed straight through to the
// game server on Nordcore, including the WebSocket upgrade.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      const target = env.WS_ORIGIN + (url.pathname.slice(3) || '/') + url.search;
      const headers = new Headers(request.headers);
      // The player's address, and the key that tells the game server it is this Worker saying so
      // (wrangler secret LEVEL0_KEY, the same value as LEVEL0_KEY in the server's environment).
      // Without the key the server ignores X-Level0-IP: anybody can run a Worker and write that header.
      const ip = request.headers.get('CF-Connecting-IP');
      headers.delete('X-Level0-IP'); headers.delete('X-Level0-Key');
      if (ip) headers.set('X-Level0-IP', ip);
      if (env.LEVEL0_KEY) headers.set('X-Level0-Key', env.LEVEL0_KEY);
      try {
        return await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });
      } catch {
        return new Response('game server unreachable', { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
