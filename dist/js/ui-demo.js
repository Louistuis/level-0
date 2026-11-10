// Harness for ui.js: drives every state with fake data. Not shipped with the game.
const { createUI } = await import(`./ui.js?v=${window.__v || Date.now()}`);

const q = new URLSearchParams(location.search);
const edition = q.get('edition') === 'lou15' ? 'lou15' : 'websim';

const artifacts = [
  ['almond', 'Sealed almond water', 'Still cold. The label is in a language that does not exist.'],
  ['tape', 'Unlabelled tape', 'VHS. Forty minutes of an empty hallway. It ends where you are standing.'],
  ['key', 'Brass key, warm', 'Fits no lock found so far. It is always warm.'],
  ['badge', 'Visitor badge', 'Your name, spelled correctly. Issued tomorrow.'],
  ['clock', 'Wall clock', 'Runs backwards when nobody is in the room.'],
  ['phone', 'Desk phone', 'The line is open. Someone is breathing.'],
  ['bulb', 'Spare tube', 'A fluorescent tube that lights up in your hands.'],
  ['chair', 'Swivel chair wheel', 'Turns by itself, slowly, toward the nearest exit.'],
  ['memo', 'Memo, page 2', 'Page 1 has never been found.'],
  ['tooth', 'Molar', 'Not human. Not not human.'],
  ['compass', 'Compass', 'Points at whoever is closest to you.'],
  ['carpet', 'Dry carpet sample', 'The only dry square of carpet ever recorded.'],
].map(([id, name, desc]) => ({ id, name, desc }));

const signs = [
  { id: 'arrow-up', label: 'This way' },
  { id: 'arrow-right', label: 'Right' },
  { id: 'safe', label: 'Safe' },
  { id: 'exit', label: 'Exit?' },
  { id: 'arrow-back', label: 'Go back' },
  { id: 'dead-end', label: 'Dead end' },
  { id: 'danger', label: 'Danger' },
  { id: 'eye', label: 'Watching' },
];

const ui = createUI({
  version: '0.1.0',
  edition,
  repoUrl: 'https://github.com/Louistuis/level-0',
  donateUrl: 'https://www.buymeacoffee.com/louis9987',
  artifacts,
  signs,
  credits: q.get('credits') === '0' ? [] : [
    { what: 'Office chair', title: 'Swivel Chair (low poly)', author: 'Example Artist', license: 'CC BY 4.0', url: 'https://example.com/models/swivel-chair' },
    { what: 'Water cooler', title: 'Water Dispenser', author: 'Another Person', license: 'CC BY 4.0', url: 'https://example.com/a/very/long/path/to/a/model/water-dispenser-0123456789' },
  ],
  touch: q.get('touch') === '1' ? true : undefined,
});
window.ui = ui;

const log = (...a) => console.log('[demo]', ...a);
['play', 'resume', 'respawn', 'quit', 'setting', 'sign', 'action', 'map'].forEach((ev) => ui.on(ev, (...a) => log(ev, ...a)));

/* fake engine wiring */
ui.on('play', () => ui.enterGame());
ui.on('resume', () => ui.showPause(false));
ui.on('quit', () => title());
ui.on('respawn', () => { ui.hideOverlays(); ui.enterGame(); });
ui.on('setting', (k, v) => { if (k === 'visor') document.getElementById('fake').classList.toggle('hide-visor', !v); });
ui.on('action', (a) => { if (a === 'pause') ui.showPause(true); if (a === 'sign') ui.openSigns(); if (a === 'flashlight') hud.flashlight = !hud.flashlight; if (a === 'crouch') hud.crouch = !hud.crouch; });
ui.on('map', () => ui.toast({ title: 'Map', sub: 'The survey map opens here (map.js).', kind: 'info' }));
ui.on('sign', (id) => ui.toast({ title: 'Chalk left', sub: signs.find((s) => s.id === id).label, kind: 'info' }));
document.getElementById('fake').classList.toggle('hide-visor', !ui.settings.visor);

ui.setCatalog(['almond', 'tape', 'compass']);
ui.setLeaderboard([
  { username: 'quietfloor', sectors: 412, artifacts: 11, escapes: 3 },
  { username: 'mold_enjoyer', sectors: 377, artifacts: 9, escapes: 1 },
  { username: 'Louis', sectors: 251, artifacts: 7, escapes: 2, you: true },
  { username: 'hum', sectors: 198, artifacts: 4, escapes: 0 },
  { username: 'yellowyellow', sectors: 140, artifacts: 6, escapes: 1 },
  { username: 'carpetdamp', sectors: 90, artifacts: 2, escapes: 0 },
]);
ui.setPlayers([
  { username: 'Louis', distance: 0, you: true },
  { username: 'hum', distance: 38 },
  { username: 'quietfloor', distance: 412 },
  { username: 'a_very_long_username_x', distance: 1290 },
]);

function title(save = true) {
  ui.showTitle({
    username: 'Louis',
    avatarUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="#6b5d26"/><circle cx="14" cy="11" r="5" fill="#d8c98a"/><rect x="6" y="18" width="16" height="10" rx="5" fill="#d8c98a"/></svg>'),
    online: 14,
    hasSave: save,
    stats: { sectors: 251, artifacts: 3, escapes: 2, deaths: 7, farthest: 812 },
  });
}

function loading() {
  title(false);
  let p = 0;
  const steps = ['Measuring the rooms', 'Replacing the tubes', 'Finding the others', 'Ready'];
  const t = setInterval(() => {
    p = Math.min(1, p + 0.07);
    ui.setTitleStatus(p >= 1 ? 'Ready. 14 people inside.' : steps[Math.floor(p * 3)], p);
    if (p >= 1) clearInterval(t);
  }, 160);
}

/* HUD simulation at 20 Hz */
const hud = { health: 0.82, sanity: 0.64, stamina: 1, battery: 0.71, flashlight: true, crouch: false, mic: false,
  sector: 'W3 / N12', sectorName: 'Pillar hall', discoverer: 'quietfloor', depth: 412, players: 14, detector: 0, heading: 0 };
let tt = 0;
let sim = true;
setInterval(() => {
  if (!sim) return;
  tt += 0.05;
  hud.heading = tt * 0.35;
  hud.stamina = 0.55 + Math.sin(tt * 0.7) * 0.45;
  hud.depth = 412 + Math.floor(tt * 1.3);
  hud.detector = Math.max(0, Math.sin(tt * 0.25)) * (hud.detForce ?? 1);
  hud.mic = ui.settings.voice && Math.sin(tt) > 0.6;
  ui.setHud(hud);
  ui.setFps(58 + Math.round(Math.random() * 4));
}, 50);

/* keyboard like the engine would */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ui.menuOpen && !e.defaultPrevented) { ui.showPause(true); }
  if ((e.key === 'q' || e.key === 'Q') && !ui.menuOpen) { e.preventDefault(); ui.openSigns(); }
  if (e.key === 'Tab' && !ui.menuOpen) { e.preventDefault(); ui.showRoster(true); }
  if ((e.key === 'e' || e.key === 'E') && !ui.menuOpen) ui.damage(0.5);
});
window.addEventListener('keyup', (e) => { if (e.key === 'Tab') ui.showRoster(false); });

/* switcher */
const S = {
  'Title': () => title(true),
  'Loading': loading,
  'Other edition': () => { q.set('edition', edition === 'lou15' ? 'websim' : 'lou15'); location.search = q.toString(); },
  'Touch on/off': () => { q.set('touch', q.get('touch') === '1' ? '0' : '1'); location.search = q.toString(); },
  'HUD': () => { ui.enterGame(); Object.assign(hud, { health: 0.82, sanity: 0.64, battery: 0.71, detForce: 1 }); ui.setSanityFx(0); },
  'HUD low': () => { ui.enterGame(); Object.assign(hud, { health: 0.18, sanity: 0.22, battery: 0.09 }); },
  'Unrecorded': () => { hud.discoverer = null; hud.sectorName = 'Damp corridor'; hud.sector = 'E14 / S3'; },
  'Prompt': () => ui.prompt('E', 'Take almond water'),
  'No prompt': () => ui.prompt(null),
  'Toasts': () => {
    ui.toast({ title: 'Artifact', sub: 'Sealed almond water', kind: 'artifact' });
    ui.toast({ title: 'Something is near', sub: 'Do not run.', kind: 'danger' });
    ui.toast({ title: 'hum joined', sub: '38 m away', kind: 'info' });
  },
  'Discover': () => ui.toast({ title: 'New sector', sub: 'You are the first one here.', kind: 'discover' }),
  'Subtitle': () => ui.subtitle('The lights here have been on for a very long time.', 4500),
  'Damage': () => ui.damage(0.8),
  'Sanity hi': () => { ui.setSanityFx(0.9); hud.sanity = 0.1; },
  'Sanity 0': () => { ui.setSanityFx(0); hud.sanity = 0.64; },
  'Signs': () => ui.openSigns(),
  'Roster': () => ui.showRoster(true),
  'Roster off': () => ui.showRoster(false),
  'Pause': () => ui.showPause(true),
  'Death': () => ui.showDeath({ cause: 'Something that only moves when you are not looking.', sectors: 37, time: 1843, artifacts: 2 }),
  'Escape': () => ui.showEscape({ sectors: 112, time: 6021, escapes: 3 }),
  'Sim pause': () => { sim = !sim; },
};
const sw = document.getElementById('sw');
const tog = document.createElement('button');
tog.className = 't'; tog.textContent = `UI demo (${edition}) [hide]`;
tog.onclick = () => { sw.classList.toggle('min'); tog.textContent = sw.classList.contains('min') ? 'UI demo [show]' : `UI demo (${edition}) [hide]`; };
sw.appendChild(tog);
for (const [k, fn] of Object.entries(S)) {
  const b = document.createElement('button');
  b.textContent = k; b.onclick = fn; sw.appendChild(b);
}
window.demo = S;

loading();
