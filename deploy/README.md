# Deploying the lou15 edition

- `npx wrangler@4 deploy` from the repository root publishes `dist/` and the Worker to backrooms.lou15.com.
- The game server runs on Nordcore as `level0.service` (see `level0.service`), listening on 127.0.0.1:8823.
- nginx on the edge node forwards `/level0-mp/` to it (see `nginx-level0.conf`). The Worker sends `/ws` there.
- The world lives in one file: `/var/lib/level0/level0.json`. Back that file up and you have backed up the world.

Health check: `curl https://backrooms.lou15.com/ws/health`

## Settings the server reads

- `LEVEL0_KEY`: a long random value shared with the Worker (`npx wrangler@4 secret put LEVEL0_KEY`, and the same value in the service's environment, for example a drop-in under `/etc/systemd/system/level0.service.d/`). The Worker sends it with each connection together with the player's address. Without it the server ignores `X-Level0-IP`, because anybody can run a Worker and write that header. Never put the value in this repository.
- `LEVEL0_VOICE=1`: pass the voice hand-shake between players. Off by default, as voice is off in the game.
- `LEVEL0_STRICT=1`: only connections that carry the key are let in, so the Worker is the one way to the game server. Needs `LEVEL0_KEY`. The health check stays open. Leave it off for local development.
- `MAX_PER_IP`, `MAX_CLIENTS`: connection limits.

## What the server keeps for you

- A copy of the world file once a day next to it (`level0.YYYY-MM-DD.json`, the last seven). If the world file cannot be read at start-up it is put aside as `level0.json.unreadable-…` and the newest readable copy is used.
- Refused attempts in the log: `journalctl -u level0 | grep leaderboard:`. Addresses appear only as a salted hash.
