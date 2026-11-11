// Places, after the Backrooms lore (the collaborative fiction of the Backrooms wikis, CC BY-SA 3.0;
// every description in this game is our own wording). Level 0 is most of the world. The other
// levels bleed into it as rare regions far from the entry point: walk far enough and the
// wallpaper gives way to something else.
//
// This table is the shared contract between the generator, the renderer, the sound and the
// menus: ids are stored per cell in sector.bio (Uint8Array, 48x48).
//
// Sector data added by worldgen.js in 0.3.0 (everything else is unchanged):
//   bio     Uint8Array(N*N)   place id per cell (0 = Level 0)
//   biome   number            the place most of this sector belongs to
//   decor   Array             wall / ceiling / floor dressing with no collision:
//                             { k, x, z, y, dir, v }  x, z in cells (may be fractional),
//                             dir = index into D4 [[1,0],[-1,0],[0,1],[0,-1]] pointing at the wall
//                             the piece hangs on (or the run direction), v = variant / length.
//                             k is one of DECOR. Renderers skip kinds they do not know.
//   run     null | { x0, z0, x1, z1, dir }   the Level ! corridor, if it crosses this sector
//                             (world cells of its two ends; the exit is at x1, z1)
//   bays[]  labels may also be a place key ('level1', 'level37', ...); type may be one too.
// Standing water (Level 37): a cell is under water when bio === L37 and floor < WATER_Y - 0.02.
// The surface is flat at WATER_Y everywhere; pools are never deeper than WATER_MAX_DEPTH.
export const BIOME = { L0: 0, L1: 1, L2: 2, L5: 3, L37: 4, LRUN: 5 };
export const WATER_Y = -0.08;
export const WATER_MAX_DEPTH = 0.9;

// light: colour of the ceiling lamps there (Level 0 is the reference yellow)
// fog:   colour the distance fades into; haze: how thick the air is (1 = Level 0)
// step:  footstep surface; amb: ambience bed for the sound engine
// danger: how hostile the place is by itself (0 calm .. 1), on top of distance from the entry
export const BIOMES = [
  { id: 0, key: 'level0', level: 'Level 0', name: 'The Lobby', blurb: 'Yellow wallpaper, damp carpet, and the hum of the lights. It goes on.',
    light: [1.0, 0.90, 0.55], fog: [0.36, 0.31, 0.13], haze: 1.0, step: 'carpet', amb: 'office', danger: 0.35 },
  { id: 1, key: 'level1', level: 'Level 1', name: 'Habitable Zone', blurb: 'Bare concrete, low fog, puddles. Crates of supplies turn up here. So do the blackouts.',
    light: [0.92, 0.95, 0.88], fog: [0.17, 0.18, 0.17], haze: 1.5, step: 'concrete', amb: 'warehouse', danger: 0.55 },
  { id: 2, key: 'level2', level: 'Level 2', name: 'Pipe Dreams', blurb: 'Service tunnels that never end. Pipes on every wall, heat in the air, something knocking back.',
    light: [1.0, 0.52, 0.26], fog: [0.20, 0.08, 0.04], haze: 1.7, step: 'metal', amb: 'pipes', danger: 0.85 },
  { id: 3, key: 'level5', level: 'Level 5', name: 'Terror Hotel', blurb: 'An old hotel with nobody at the desk. Numbered doors, patterned carpet, a piano somewhere.',
    light: [1.0, 0.74, 0.46], fog: [0.20, 0.09, 0.06], haze: 0.9, step: 'rug', amb: 'hotel', danger: 0.75 },
  { id: 4, key: 'level37', level: 'Level 37', name: 'Sublimity', blurb: 'White tile and warm, still water, room after room. It is quiet here. Almost kind.',
    light: [0.80, 0.96, 1.0], fog: [0.52, 0.62, 0.64], haze: 0.6, step: 'tile', amb: 'pools', danger: 0.05 },
  { id: 5, key: 'levelrun', level: 'Level !', name: 'Run For Your Life!', blurb: 'One corridor. Red lamps. Alarms. Do not look back, and do not stop.',
    light: [1.0, 0.16, 0.12], fog: [0.26, 0.03, 0.03], haze: 1.3, step: 'tile', amb: 'alarm', danger: 1.0 },
];
export const BIOME_KEYS = BIOMES.map((b) => b.key);
export const biomeOf = (id) => BIOMES[id] || BIOMES[0];

// Dressing kinds worldgen may emit in sector.decor.
//   hdoor   numbered hotel room door on a wall (Level 5)        v = room number
//   sconce  wall lamp (Level 5)
//   pipe    pipe run under the ceiling or along a wall (Level 2, Level 1)   v = length in cells
//   valve   valve wheel / gauge on a wall (Level 2)
//   crate   supply crate against a wall (Level 1); the cell it stands on is kept walkable around it
//   puddle  shallow puddle on concrete (Level 1)
//   drain   floor drain (Level 37)
//   ladder  pool ladder at a pool edge (Level 37)
//   strobe  red alarm lamp on a wall (Level !)
//   sign    wall sign                                            v = which
//   cooler  water cooler (Almond Water)
export const DECOR = ['hdoor', 'sconce', 'pipe', 'valve', 'crate', 'puddle', 'drain', 'ladder', 'strobe', 'sign', 'cooler'];

// Footstep surfaces the sound engine knows (third argument of audio.footstep).
export const STEPS = ['carpet', 'tile', 'water', 'concrete', 'rug', 'metal'];

// Entities, after the lore. Codes are what goes over the network.
//   L  Howler        the tall one. Hunts by sound, then by sight. (ours since 0.1, "Longarm" in code)
//   H  Hollow        an empty suit that only moves when nobody is looking. (ours since 0.1)
//   B  Smiler        teeth and eyes in the dark. Drawn to light and to running. Hold its gaze and back away.
//   M  Skin-Stealer  wears a wanderer's suit and name, and shows on the radar as a friend. Wrong up close.
//   K  Hound         on all fours, fast. Chases what runs. Face it and stand your ground.
//   W  Faceling      a person with no face at the end of a hall. Harmless until it is not.
//   R  The horde     what comes down the corridor on Level !. Never stops.
export const ENTITIES = {
  L: { name: 'Howler', audio: 'longarm' }, H: { name: 'Hollow', audio: 'hollow' }, B: { name: 'Smiler', audio: 'smiler' },
  M: { name: 'Skin-Stealer', audio: 'stealer' }, K: { name: 'Hound', audio: 'hound' }, W: { name: 'Faceling', audio: 'faceling' },
  R: { name: 'The horde', audio: 'horde' },
};

// Sound contract between entities.js and audio.js (new in 0.3; older names stay).
//   audio.entity(id, type, x, y, z, state)   type = ENTITIES[code].audio ('biter' stays as an alias of 'smiler')
//   audio.play(name, { pos, vol, pitch })    names below. Unknown names must be ignored, never throw.
export const SOUNDS_03 = ['stealerCall', 'stealerTurn', 'houndBark', 'houndRush', 'smilerSeen', 'facelingSeen', 'facelingGone',
  'lunge', 'scare', 'behind', 'knock', 'doorCreak', 'splash', 'steamHiss', 'lampPop', 'farRun', 'placeFound',
  'alarmStart', 'hordeNear', 'blackoutStart', 'blackoutEnd', 'almond'];
