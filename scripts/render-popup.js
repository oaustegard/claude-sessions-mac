// Renders the popup with made-up sessions, in light and dark, to PNG files,
// so a change to the popup can be looked at without a tray or a terminal.
//   npx electron scripts/render-popup.js [output folder]
// The sessions are fixtures; the model, the catalog and the renderer are the real ones.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const paths = require('../paths');
const sounds = require('../sounds');
const { popupModel, focusNotice } = require('../popup-view');
const { WIDTH } = require('../popup');

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) || path.join(os.tmpdir(), 'claude-sessions-render'));
const ROOT = path.join(__dirname, '..');
const PAD = 14;
const DESKTOP = { light: '#c9ced6', dark: '#16181d' }; // stands in for whatever is behind the card
const MIN = 60 * 1000;

function fixtures(now) {
  const base = (pid, project, branch, extra) => ({
    pid,
    sessionId: `fixture-${pid}`,
    cwd: `C:\\work\\${project}`,
    project,
    branch,
    entrypoint: 'cli',
    lastActivity: now - pid * 1000,
    ...extra,
  });
  const agent = (id, type, description, state, extra = {}) => ({
    id, type, description, state, startedAt: now - 3 * MIN, ...(state === 'running' || state === 'needs' ? {} : { endedAt: now - 1 * MIN }), ...extra,
  });
  const agents = (...runs) => Object.fromEntries(runs.map((r) => [r.id, r]));
  const rows = [
    base(101, 'shop', 'checkout', {
      state: 'needs', since: now - 1 * MIN, needsReason: 'Needs permission: Bash', firstPrompt: 'Fix the tax rounding on the checkout page',
      agents: agents(agent('s1', 'general-purpose', 'Update the rounding tests', 'needs', { tool: 'Bash' })),
    }),
    base(102, 'mobile-app', 'main', { state: 'error', since: now - 4 * MIN, error: 'API overloaded (529)' }),
    base(103, 'ClaudeSessionsTray', 'master', {
      state: 'done', since: now - 2 * MIN, backgroundTasks: 2,
      agents: agents(
        agent('c1', 'Explore', 'Map the hook installer', 'running', { background: true, tool: 'Grep', startedAt: now - 4 * MIN }),
        agent('c2', 'general-purpose', 'Review the popup layout', 'running', { background: true, tool: 'Agent', startedAt: now - 3 * MIN }),
        agent('c3', 'Explore', 'Find the focus tests', 'running', { parentAgentId: 'c2', tool: 'Read', startedAt: now - 40000 }),
        agent('c4', 'Plan', 'Check the release steps', 'done', { endedAt: now - 2 * MIN, lastMessage: 'Three steps, all scripted.' }),
      ),
    }),
    base(104, 'docs-site', 'search', {
      state: 'working', since: now - 6 * MIN, tool: 'Edit', firstPrompt: 'Add a search box to the docs sidebar',
      agents: agents(
        agent('d1', 'Explore', 'Find the sidebar component', 'done', { endedAt: now - 5 * MIN }),
        agent('d2', 'Explore', 'List the search libraries in use', 'done', { endedAt: now - 4 * MIN }),
        agent('d3', 'Explore', 'Read the docs build config', 'stopped', { endedAt: now - 4 * MIN }),
        agent('d4', 'Plan', 'Plan the index format', 'done', { endedAt: now - 3 * MIN }),
        agent('d5', 'code-reviewer', 'Review the draft', 'failed', { endedAt: now - 2 * MIN }),
        agent('d6', 'Explore', 'Check the theme tokens', 'done', { endedAt: now - 1 * MIN }),
        agent('d7', 'Explore', 'Look for an existing search hook', 'done', { endedAt: now - 7 * MIN }),
      ),
    }),
    base(105, 'inventory', '', { state: 'idle', since: now - 41 * MIN, firstPrompt: 'Why does the order list drop the quantity when an item is added twice from the scanner?' }),
    base(106, 'benchmarks', 'nightly', { state: 'ended', since: now - 3 * MIN, endedAt: now - 3 * MIN }),
  ];
  return Object.fromEntries(rows.map((r) => [String(r.pid), r]));
}

function buildModels() {
  const now = Date.now();
  const catalog = sounds.buildCatalog({ windowsDir: paths.windowsMediaDir, customDir: paths.soundsDir });
  const sessions = fixtures(now);
  const config = {
    showAll: false,
    dndUntil: now + 60 * MIN,
    volume: 0.8,
    aliases: { 'fixture-103': 'popup wiring' },
    projectSounds: {},
    sessionSounds: { 'fixture-102': 'synth:glass' },
    muted: { 'fixture-104': true },
  };
  config.projectSounds = sounds.assignProjects(config, Object.values(sessions), catalog) || {};
  return {
    full: popupModel({ sessions, config, catalog, now, hooksInstalled: true }),
    empty: popupModel({ sessions: {}, config: { ...config, dndUntil: 0 }, catalog, now, hooksInstalled: false }),
  };
}

// Each shot closes its window; without this Electron quits after the first one.
app.on('window-all-closed', () => {});

const heights = new Map();
ipcMain.on('popup:resize', (e, h) => heights.set(e.sender.id, Math.ceil(Number(h))));
// Stand-ins for main's answers, so the row's copied check and its notice can be shown.
ipcMain.handle('popup:activate', () => ({ ok: false, notice: focusNotice('no window (no chain)') }));
ipcMain.handle('popup:copy-resume', () => true);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot({ name, theme, model, action }) {
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({
    width: WIDTH + 2 * PAD,
    height: 600,
    show: false,
    useContentSize: true,
    backgroundColor: DESKTOP[theme],
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'popup.html'));
    // Shots are stills, and a hidden window does not always run a transition to its end.
    await win.webContents.insertCSS(`body { padding: ${PAD}px !important; } *, *::before, *::after { transition: none !important; }`);
    win.webContents.send('popup:model', model);
    await wait(150);
    if (action) await action(win);
    await wait(250);
    const h = heights.get(win.webContents.id) || 300;
    win.setContentSize(WIDTH + 2 * PAD, h + 2 * PAD);
    await wait(250);
    const img = await win.webContents.capturePage();
    if (img.isEmpty()) throw new Error(`${name}: empty capture`);
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(file, img.getSize().width, 'x', img.getSize().height);
  } finally {
    win.destroy();
  }
}

const click = (selector) => (win) => win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);

/** Moves the pointer over an element, so its :hover styles show. */
const hover = (selector) => async (win) => {
  const box = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x), y: Math.round(box.y) });
};

const all = (...actions) => async (win) => { for (const a of actions) { await a(win); await wait(60); } };

// The first row hovered (copy and folder show), the second row's copy just clicked,
// and the third row's notice after its window did not come forward.
const rowTools = all(
  click('.row:nth-child(2) .tool.reveal'),
  click('.row:nth-child(3) .row-title'),
  hover('.row:nth-child(1)'),
);

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { full, empty } = buildModels();
  const shots = [];
  for (const theme of ['light', 'dark']) {
    shots.push({ name: `list-${theme}`, theme, model: full });
    shots.push({ name: `picker-${theme}`, theme, model: full, action: click('.row .chip-label') });
    shots.push({ name: `tools-${theme}`, theme, model: full, action: rowTools });
  }
  // Rows in urgency order: 101 needs, 102 error, 103 done, 104 working.
  const openAgents = all(click('.row:nth-child(3) .agents-pill'), click('.row:nth-child(4) .agents-pill'), click('.row:nth-child(1) .agents-pill'));
  for (const theme of ['light', 'dark']) shots.push({ name: `agents-${theme}`, theme, model: full, action: openAgents });
  shots.push({ name: 'agents-all-light', theme: 'light', model: full, action: all(click('.row:nth-child(4) .agents-pill'), click('.row:nth-child(4) .agents-more')) });
  shots.push({ name: 'settings-light', theme: 'light', model: full, action: click('#gear') });
  shots.push({ name: 'rename-dark', theme: 'dark', model: full, action: (win) => win.webContents.send('popup:rename', '103') });
  shots.push({ name: 'empty-dark', theme: 'dark', model: empty });
  let failed = 0;
  for (const s of shots) {
    try { await shot(s); } catch (e) { failed++; console.error(e.message); }
  }
  app.exit(failed ? 1 : 0);
});
