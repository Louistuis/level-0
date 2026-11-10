# Deploying the lou15 edition

- `npx wrangler@4 deploy` from the repository root publishes `dist/` and the Worker to backrooms.lou15.com.
- The game server runs on Nordcore as `level0.service` (see `level0.service`), listening on 127.0.0.1:8791.
- nginx on the edge node forwards `/level0/` to it (see `nginx-level0.conf`). The Worker sends `/ws` there.
- The world lives in one file: `/var/lib/level0/level0.json`. Back that file up and you have backed up the world.

Health check: `curl https://backrooms.lou15.com/ws/health`
