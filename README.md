# LEVEL 0

A first-person multiplayer horror game for the browser, set in the Backrooms. Endless yellow rooms, buzzing lights, damp carpet, and, if you walk far enough, the other levels. You see it through the visor of a hazmat suit, and you are not the only thing in a suit.

Everyone plays in the same world. It is generated as people walk into it, and a sector stays the way it was first found, with the name of whoever got there first.

- Play on our own server: https://backrooms.lou15.com
- Play on WebSim: https://websim.com/p/gm719rh51w5sl1sez08a

(v0.1.0 preview)
![Title screen](docs/title.jpg)

(v0.1.0 preview)
![A corridor seen through the visor](docs/corridor.jpg)

(v0.1.0 preview)
![Not every suit has someone in it](docs/things.jpg)

No build step and no game engine. The level, the light, the textures and every sound are generated in the browser. The only files it loads are its own typeface and a small pack of 3D models (suits, an exit door, a few pieces of furniture), credited in [CREDITS.md](CREDITS.md).

## What is in it

- **Level 0**: most of the world. Built from a seed as people walk into it, and laid out so one kind of place runs into the next without a hard line. Office floors, partition warrens, pillar halls, sunken courts, mezzanines, service tunnels, dead grids with no power, stairs that go into the ceiling, rooms under the floor.
- **The other levels** (new in 0.3): rare regions far from the entry point, where the wallpaper gives way to something else. Level 1 (bare concrete, fog, supply crates, long blackouts), Level 2 (hot service tunnels and pipes), Level 5 (an old hotel with numbered doors), Level 37 (white tile and warm, still water, the one calm place) and Level ! (one long red corridor with something coming down it, and a door at the far end). Each has its own light, fog, sound, footsteps and rules.
- **Light**: every ceiling panel is a real light with soft shadows, flicker and bounce. Some are dying. Some go out when something is near.
- **The suit**: visor frame, scratches, breath on the plate, cracks when you are hurt, a small readout projected on the inside.
- **Entities**: seven of them. The Howler hunts by sound and then by sight. The Hollow is an empty suit that only moves when nobody is looking at it. The Smiler is teeth in the dark: hold its gaze and back away. The Skin-Stealer wears a suit and a name, and shows on the radar as a friend. The Hound chases what runs. Facelings stand at the end of a hall and are harmless until they are not. The horde is what comes down the corridor on Level !. None of them turn up near the entry point. A director decides when they do, and it prefers the moment you have the map open, are standing still, or have just picked something up.
- **Anomalies**: chairs and doors that are there when you look back, writing that was not on the wall a moment ago, blackouts, voices.
- **The Catalog**: twelve objects to find, plus a field note for every level you have entered and every entity you have met. It is in the menu.
- **Other people**: you see their suits and their flashlights. Hold V to talk to people near you (opt-in, peer to peer). Press Q to leave a chalk sign on the floor for everyone who comes after you.
- **The survey**: press M for a hand-drawn floor plan of everything that has been walked so far: yours in ink, other people's in pencil, with names, chalk signs and bearings.
- **The handheld**: press R for an analog radar and a scrap of the map to carry while you walk. It finds people nearby. It is not always right about what else is nearby.
- **Exits**: much rarer than before and never close to the entry point. Finding one is recorded on the leaderboard.

## Controls

| | |
|---|---|
| W A S D | Move |
| Mouse | Look |
| Shift | Sprint (loud) |
| C or Ctrl | Crouch |
| F | Flashlight |
| E | Interact |
| Q | Leave a chalk sign |
| M | Floor survey (map) |
| R | Handheld radar |
| V | Hold to talk |
| Tab | Players and leaderboard |
| Esc | Pause |

Touch devices get a joystick, drag to look and on-screen buttons.

## Run it locally

```bash
# the game (any static file server works)
python3 -m http.server 8790 --directory dist

# the multiplayer server (optional; without it you play alone)
cd server && npm install && npm start
```

Open http://localhost:8790. On localhost the game looks for the server at `ws://localhost:8791`. Add `?offline=1` to skip it, or `?ws=wss://your.host/ws` to point at another one.

## Layout

```
dist/                 the whole game, served as is
  index.html
  css/style.css       menus and HUD
  js/main.js          boot, game state, frame loop
  js/biomes.js        the levels and entities table shared by every other file
  js/worldgen.js      sector generator
  js/world.js         streaming, meshing, light maps, collision, pathfinding
  js/shaders.js       lighting, materials, visor and lens pass
  js/render.js        HDR target, bloom, final pass
  js/textures.js      wallpaper, carpet, ceiling tiles, wall scrawls (all painted at load)
  js/player.js        movement and camera
  js/entities.js      other players, the entity brains and the director, anomalies
  js/creatures.js     entity models and their animation
  js/decor.js         level dressing (pipes, hotel doors, pool ladders, alarm lamps)
  js/props.js         models built from primitives, pickups, artifacts, signs
  js/audio.js         all sound, synthesized with WebAudio
  js/net.js           WebSim, own-server and offline transports behind one interface
  js/voice.js         proximity voice (WebRTC)
  js/map.js           the floor survey (hand-drawn map)
  js/handheld.js      handheld radar and map scrap
  js/assets.js        loader and credits for the model pack
  js/ui.js            menus, HUD, touch controls
  assets/             Troffer typeface, model pack (GLB)
server/server.mjs     tiny WebSocket relay and world store (one JSON file)
deploy/               Cloudflare Worker and systemd unit for backrooms.lou15.com
tools/                font builder (Troffer), model pack builder, world generator test
```

Two editions run the same code. Inside WebSim the game uses WebSim's multiplayer rooms and database. Anywhere else it talks to `server/server.mjs`. If neither is reachable it still works, alone.

`window.__g` in the browser console exposes the running game for debugging, for example `__g.ents.spawn('L', __g.pl)`. Add `?place=level37` (or any key from `biomes.js`) to dress the whole world as that level while working on it.

## Contributing

Issues and pull requests are welcome. Things that would help most:

- New sector types and set pieces in `worldgen.js` (they must keep the edge portals open so neighbours connect)
- New levels (`biomes.js` is the table to start from), entities and anomalies
- Performance on low-end phones
- Sound design passes in `audio.js`

Keep `dist/` free of dependencies beyond the vendored three.js, and keep the world deterministic: the same seed must always build the same sector, or players stop sharing a world.

## Support

If you like it, you can [buy me a pizza](https://www.buymeacoffee.com/louis9987).

## License

MIT for the code. See [LICENSE](LICENSE). The levels and several of the entities come from the Backrooms, the collaborative fiction written on the Backrooms wikis (CC BY-SA 3.0); every description in the game is our own wording, see [CREDITS.md](CREDITS.md). three.js is included under its own MIT license. The 3D models in `dist/assets/pack` are CC BY 4.0 by their authors and the Troffer typeface is under the SIL Open Font License 1.1; both are listed in [CREDITS.md](CREDITS.md) and are not covered by the MIT license. The WebSim logo in `dist/assets` belongs to WebSim and is shown in the WebSim edition with their permission; it is not covered by the MIT license.
