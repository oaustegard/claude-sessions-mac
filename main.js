// Claude Sessions: the tray app. Wiring only. The decisions live in state.js
// (the reducer), the words in view.js and popup-view.js, the drawing in
// tray-icon.js and the sound choices in sounds.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, nativeImage, Notification, shell, dialog, clipboard } = require('electron');
const paths = require('./paths');
const store = require('./store');
const state = require('./state');
const view = require('./view');
const sounds = require('./sounds');
const hooks = require('./hooks-install');
const { createServer, newToken } = require('./server');
const { watchRegistry } = require('./registry');
const { deadPids } = require('./liveness');
const focus = require('./focus');
const { labelsFor } = require('./labels');
const { iconSpec, iconPngs, drawIcon, encodePng, COLORS } = require('./tray-icon');
const { createPlayer } = require('./player');
const { createPopup } = require('./popup');
const { popupModel, focusNotice, soundNotice } = require('./popup-view');

// Alerts play from a hidden window that nobody clicks, so it may not wait for a gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const FIRST_PORT = 47860;
const PORT_TRIES = 10;
const TICK_MS = 1000;
const SLOW_MS = 15000;          // liveness check, spool drain, hook status
const REPLAY_AGE_MS = 30000;    // spooled events older than this alert no one
const MENU_ROWS = 12;
const SEEN_AFTER_MS = 500;      // a popup open this long counts as having seen its done rows
const ALIAS_MAX = 60;
const LOG_MAX = 1024 * 1024;
const logFile = path.join(paths.dataDir, 'tray.log');

let sessions = {};
let config = store.loadConfig(paths.configFile);
let hookState = { installed: false, partial: false };
let catalog = sounds.BUILT_IN;
let tray = null;
let popup = null;
let player = null;
let server = null;
let registry = null;
let token = null;
let lastIconKey = '';
let pushQueued = false;
const timers = [];
const toasts = new Set(); // a Notification that is garbage-collected loses its click handler
const saver = store.stateSaver(paths.stateFile);

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}\n`;
  try { fs.appendFileSync(logFile, line); } catch { /* data folder not there yet */ }
}

function trimLog() {
  try { if (fs.statSync(logFile).size > LOG_MAX) fs.writeFileSync(logFile, ''); } catch { /* no log yet */ }
}

/** True when some row was added, removed or replaced. */
function rowsChanged(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return true;
  return ka.some((k) => a[k] !== b[k]);
}

function dispatch(input) {
  const { sessions: next, effects } = state.reduce(sessions, input);
  const changed = rowsChanged(sessions, next);
  sessions = next;
  if (changed) saver.save(sessions);
  for (const fx of effects) {
    try { runEffect(fx); } catch (e) { log('effect failed', fx.type, e); }
  }
  if (changed) refresh();
}

function runEffect(fx) {
  if (fx.type === 'alert') alert(fx.kind, fx.pid);
  else if (fx.type === 'needLabels') {
    labelsFor(fx.cwd)
      .then((l) => dispatch({ type: 'labels', pid: fx.pid, cwd: fx.cwd, project: l.project, branch: l.branch }))
      .catch((e) => log('labels failed', fx.cwd, e));
  }
}

function aliasFor(row) {
  return (row.sessionId && config.aliases[row.sessionId]) || undefined;
}

function seen(pid) {
  dispatch({ type: 'seen', pid, now: Date.now() });
}

function rowFor(key) {
  return sessions[String(key)] || null;
}

/**
 * Marks the row seen, brings its terminal to the front and selects its tab.
 * Resolves to focus.js's { ok, reason, … }; never rejects.
 */
async function focusRow(row, source) {
  seen(row.pid);
  let r;
  try {
    r = await focus.focusSession(row);
  } catch (e) {
    r = { ok: false, reason: `focus failed: ${e.message}` };
  }
  const tab = focus.describeTab(r.tab);
  log('focus', source, row.pid, r.ok ? `via ${r.via} ${JSON.stringify(r.title)}` : `failed: ${r.reason}`, ...(tab ? [`(${tab})`] : []));
  return r;
}

/** Resolves to true when the window came forward. */
async function activate(row, source) {
  return (await focusRow(row, source)).ok;
}

function toggleMute(sid) {
  config.muted = sounds.setCapped(config.muted, sid, config.muted[sid] ? undefined : true);
  configChanged();
}

// ---------------------------------------------------------------- alerts

const toastIcons = {};
function toastIcon(kind) {
  if (!toastIcons[kind]) {
    const size = 64;
    toastIcons[kind] = nativeImage.createFromBuffer(encodePng(drawIcon({ shape: 'dot', color: COLORS[kind] || COLORS.idle }, size), size, size));
  }
  return toastIcons[kind];
}

/** The session's sound (twice for needs you), then a toast. Mute and DND stop both. */
function alert(kind, pid) {
  const row = sessions[String(pid)];
  if (!row || !state.isVisible(row, config.showAll)) return;
  if (config.dndUntil > Date.now()) return log('alert held by do not disturb', kind, pid);
  if (row.sessionId && config.muted[row.sessionId]) return log('alert held by mute', kind, pid);
  // An error has no sound of its own yet: it plays like done.
  if (player) player.play(sounds.resolveSound(config, row, catalog).id, kind, config.volume);
  if (!Notification.isSupported()) return log('toast dropped: toasts unsupported', kind, pid);
  const { title, body } = view.toastFor(kind, row, aliasFor(row));
  // silent: the sound above is the alert's only sound.
  const n = new Notification({ title, body, silent: true, icon: toastIcon(kind) });
  toasts.add(n);
  const forget = () => toasts.delete(n);
  n.on('show', () => log('toast', kind, pid, JSON.stringify(title)));
  n.on('click', () => {
    forget();
    const current = sessions[String(pid)];
    if (current) activate(current, 'toast');
  });
  n.on('close', forget);
  n.on('failed', (_e, err) => { forget(); log('toast failed', err); });
  n.show();
}

// ---------------------------------------------------------------- tray and popup

function trayImage(summary, opts) {
  const img = nativeImage.createEmpty();
  for (const { scaleFactor, png } of iconPngs(summary, opts)) img.addRepresentation({ scaleFactor, buffer: png });
  return img;
}

function getModel() {
  return popupModel({ sessions, config, catalog, now: Date.now(), hooksInstalled: hookState.installed, openAtLogin: openAtLogin() });
}

/** Sends the popup a fresh model once per turn of the event loop, and only while it shows. */
function pushModel() {
  if (!popup || !popup.isVisible() || pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (popup) popup.push();
  });
}

function refresh() {
  if (!tray) return;
  const summary = state.summarize(sessions, config.showAll);
  const assigned = sounds.assignProjects(config, summary.rows, catalog);
  if (assigned) {
    config.projectSounds = assigned;
    saveConfig();
  }
  const opts = { hooksInstalled: hookState.installed };
  const key = JSON.stringify(iconSpec(summary, opts));
  if (key !== lastIconKey) {
    tray.setImage(trayImage(summary, opts));
    lastIconKey = key;
  }
  pushModel();
}

function rebuildCatalog() {
  catalog = sounds.buildCatalog({ systemDir: paths.systemSoundsDir, cacheDir: paths.systemSoundsCache, customDir: paths.soundsDir });
}

function saveConfig() {
  try { store.saveConfig(paths.configFile, config); } catch (e) { log('config save failed', e); }
}

function configChanged() {
  saveConfig();
  refresh();
}

function setDnd(choice) {
  config.dndUntil = view.dndUntil(choice, Date.now());
  configChanged();
}

// The login item is the app itself, in System Settings, General, Login Items.
// Run from a checkout, that is bare Electron, which opens its default app.
function openAtLogin() {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

function setOpenAtLogin(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
    log('start at login', !!on);
  } catch (e) {
    log('start at login failed', e);
  }
  refresh();
}

function refreshHookState() {
  try {
    const s = hooks.status();
    hookState = { installed: s.installed, partial: s.partial };
  } catch (e) {
    hookState = { installed: false, partial: false, error: e.message };
  }
}

function changeHooks(fn, verb) {
  try {
    const r = fn();
    log(`hooks ${verb}`, JSON.stringify(r));
  } catch (e) {
    log(`hooks ${verb} failed`, e);
    dialog.showErrorBox('Claude Sessions', `Could not ${verb} the hooks:\n${e.message}`);
  }
  refreshHookState();
  refresh();
}

function dndItems(now) {
  const dndOn = config.dndUntil > now;
  return [
    { label: '30 minutes', click: () => setDnd('30m') },
    { label: '1 hour', click: () => setDnd('1h') },
    { label: view.morningLabel(now), click: () => setDnd('morning') },
    { type: 'separator' },
    { label: 'Off', enabled: dndOn, click: () => setDnd('off') },
  ];
}

function buildMenu() {
  const now = Date.now();
  const summary = state.summarize(sessions, config.showAll);
  const items = [{ label: view.menuText(view.headerText(summary)), enabled: false }];
  if (hookState.error) items.push({ label: view.menuText(view.clip(`settings.json: ${hookState.error}`, 90)), enabled: false });
  else if (!hookState.installed) items.push({ label: 'Hooks not installed: no needs-you or done alerts', enabled: false });
  for (const row of summary.rows.slice(0, MENU_ROWS)) {
    items.push({ label: view.menuLabel(row, aliasFor(row), now), click: () => activate(row, 'menu') });
  }
  if (summary.rows.length > MENU_ROWS) items.push({ label: `and ${summary.rows.length - MENU_ROWS} more`, enabled: false });
  items.push({ type: 'separator' });

  const dndOn = config.dndUntil > now;
  items.push({
    label: dndOn ? `Do not disturb (until ${view.hhmm(config.dndUntil)})` : 'Do not disturb',
    submenu: dndItems(now),
  });
  items.push({
    label: 'Show desktop and SDK sessions',
    type: 'checkbox',
    checked: config.showAll,
    click: (item) => { config.showAll = item.checked; configChanged(); },
  });
  items.push({ label: 'Start at login', type: 'checkbox', checked: openAtLogin(), click: (item) => setOpenAtLogin(item.checked) });
  items.push({ type: 'separator' });
  if (hookState.installed) items.push({ label: 'Remove hooks from Claude Code', click: () => changeHooks(hooks.uninstall, 'remove') });
  else items.push({ label: hookState.partial ? 'Repair hooks in Claude Code' : 'Install hooks into Claude Code', click: () => changeHooks(hooks.install, 'install') });
  items.push({ label: 'Open data folder', click: () => shell.openPath(paths.dataDir) });
  items.push({ type: 'separator' });
  items.push({ label: `Claude Sessions ${app.getVersion()}`, enabled: false });
  items.push({ label: 'Quit Claude Sessions', click: () => app.quit() });
  return { menu: Menu.buildFromTemplate(items), doneShown: summary.rows.slice(0, MENU_ROWS).filter((r) => r.state === 'done').map((r) => r.pid) };
}

/** Opening the menu shows every finished session, so they count as seen. */
function openMenu() {
  if (!tray) return;
  const { menu, doneShown } = buildMenu();
  tray.popUpContextMenu(menu);
  for (const pid of doneShown) seen(pid);
}

/** A popup that stayed open long enough showed its finished sessions. */
function onPopupHide(shownMs) {
  if (shownMs < SEEN_AFTER_MS) return;
  for (const r of state.summarize(sessions, config.showAll).rows) {
    if (r.state === 'done') seen(r.pid);
  }
}

/** Pops a native menu over the popup and keeps the popup open while it shows. */
function popupMenu(items) {
  return popup.holdOpen(() => new Promise((resolve) => {
    Menu.buildFromTemplate(items).popup({ window: popup.window() || undefined, callback: resolve });
  }));
}

// Mute, copy and open folder are buttons on the row since 0.2.2.
function rowMenuItems(key, row) {
  return [
    { label: 'Rename…', enabled: !!row.sessionId, click: () => popup.send('popup:rename', key) },
    { type: 'separator' },
    { label: 'Forget', click: () => dispatch({ type: 'forget', pid: row.pid, now: Date.now() }) },
  ];
}

function setSound(row, id, scope) {
  const sid = row.sessionId;
  if (scope === 'clear') {
    if (!sid) return;
    config.sessionSounds = sounds.setCapped(config.sessionSounds, sid, undefined);
  } else {
    if (!sounds.findSound(catalog, id)) return log('sound not in the catalog', id);
    if (scope === 'project') {
      const project = sounds.projectKey(row);
      if (!project) return;
      config.projectSounds = { ...config.projectSounds, [project]: id };
      // The project's sound is what the user just picked for this session too.
      if (sid && config.sessionSounds[sid]) config.sessionSounds = sounds.setCapped(config.sessionSounds, sid, undefined);
    } else {
      if (!sid) return;
      config.sessionSounds = sounds.setCapped(config.sessionSounds, sid, id);
    }
  }
  configChanged();
}

async function addSound() {
  const win = popup.window();
  const options = {
    title: 'Add a sound',
    properties: ['openFile'],
    filters: [{ name: 'Sounds', extensions: ['wav', 'mp3', 'ogg'] }],
  };
  const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  if (r.canceled || !r.filePaths.length) return null;
  try {
    const id = sounds.addCustomSound(r.filePaths[0], paths.soundsDir);
    rebuildCatalog();
    log('sound added', id);
    pushModel();
    return id;
  } catch (e) {
    log('add sound failed', e);
    dialog.showErrorBox('Claude Sessions', `Could not add the sound:\n${e.message}`);
    throw e;
  }
}

/** What the popup's renderer may ask for. popup.js drops messages from anywhere else. */
function wirePopup() {
  // Answers { ok, notice }: the row shows the notice for a moment when the window stayed put.
  // A tab that would not switch is only logged: the window still came forward.
  popup.handle('popup:activate', async (key) => {
    const row = rowFor(key);
    if (!row) return { ok: false, notice: focusNotice('no process') };
    const r = await focusRow(row, 'popup');
    // The popup would cover the window it just brought forward.
    if (r.ok) popup.dismiss();
    return { ok: r.ok, notice: r.ok ? '' : focusNotice(r.reason, row) };
  });
  popup.on('popup:mute', (key) => {
    const row = rowFor(key);
    if (row && row.sessionId) toggleMute(row.sessionId);
  });
  popup.handle('popup:copy-resume', (key) => {
    const row = rowFor(key);
    if (!row || !row.sessionId) return false;
    clipboard.writeText(`claude --resume ${row.sessionId}`);
    return true;
  });
  popup.on('popup:open-folder', (key) => {
    const row = rowFor(key);
    if (row && row.cwd) shell.openPath(row.cwd).then((err) => { if (err) log('open folder failed', row.cwd, err); });
  });
  popup.on('popup:row-menu', (key) => {
    const row = rowFor(key);
    if (row) popupMenu(rowMenuItems(String(key), row));
  });
  popup.on('popup:dnd-menu', () => popupMenu(dndItems(Date.now())));
  popup.on('popup:alias', (key, text) => {
    const row = rowFor(key);
    if (!row || !row.sessionId) return;
    const alias = String(text == null ? '' : text).trim().slice(0, ALIAS_MAX);
    config.aliases = sounds.setCapped(config.aliases, row.sessionId, alias || undefined);
    configChanged();
  });
  popup.on('popup:sound', (key, id, scope) => {
    const row = rowFor(key);
    if (row && ['session', 'project', 'clear'].includes(scope)) setSound(row, id, scope);
  });
  popup.handle('popup:preview', async (id) => {
    if (!player || !sounds.findSound(catalog, id)) return { ok: false, notice: soundNotice('missing') };
    const res = await player.preview(id, config.volume);
    if (!res.ok) return { ok: false, notice: soundNotice(res.code) };
    return { ok: true, notice: config.volume > 0 ? '' : soundNotice('volume') };
  });
  popup.on('popup:volume', (pct) => {
    const n = Number(pct);
    if (!Number.isFinite(n)) return;
    config.volume = Math.min(1, Math.max(0, n / 100));
    configChanged();
  });
  popup.on('popup:show-all', (on) => {
    config.showAll = !!on;
    configChanged();
  });
  popup.on('popup:login', (on) => setOpenAtLogin(on));
  popup.on('popup:install-hooks', () => changeHooks(hooks.install, 'install'));
  popup.on('popup:data-folder', () => shell.openPath(paths.dataDir));
  popup.handle('popup:add-sound', () => popup.holdOpen(addSound));
}

// ---------------------------------------------------------------- start

function drain() {
  const now = Date.now();
  for (const ev of store.drainSpool(paths.spoolFile)) {
    dispatch({ type: 'hook', ev, replay: now - (ev.ts || 0) > REPLAY_AGE_MS });
  }
}

function slowTick() {
  const live = Object.values(sessions).filter((r) => r.state !== 'ended');
  const dead = deadPids(live);
  if (dead.length) dispatch({ type: 'dead', pids: dead, now: Date.now() });
  drain();
  refreshHookState();
  refresh(); // the icon and the popup notice hooks removed by hand
}

async function startServer() {
  token = newToken();
  server = createServer({ token, onEvent: (ev) => dispatch({ type: 'hook', ev }) });
  try {
    const port = await server.listen(FIRST_PORT, PORT_TRIES);
    store.writeServerFile(paths.serverFile, { port, token, pid: process.pid });
    log('listening on', port);
  } catch (e) {
    // The reporter spools while no server answers, and the slow tick drains it.
    log('server failed; running on the spool alone', e);
    server = null;
  }
}

async function start() {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  trimLog();
  log('start', app.getVersion());
  // A menu bar app: no Dock icon and no app menu.
  if (app.dock) app.dock.hide();

  sessions = state.pruneLoaded(store.loadState(paths.stateFile), Date.now());
  refreshHookState();
  rebuildCatalog();
  player = createPlayer({ fileFor: (id) => sounds.findSound(catalog, id)?.file, log });
  tray = new Tray(trayImage(state.summarize(sessions, config.showAll), { hooksInstalled: hookState.installed }));
  tray.setIgnoreDoubleClickEvents(true);
  // No tooltip: hovering the icon opens the popup, and a tooltip would sit on top of it.
  popup = createPopup({ tray, getModel, onHide: onPopupHide, log });
  wirePopup();
  tray.on('right-click', () => {
    popup.dismiss();
    openMenu();
  });
  refresh();

  drain();
  await startServer();
  drain(); // anything spooled before server.json was written
  registry = watchRegistry(paths.sessionsDir, (snapshot) => dispatch({ type: 'registry', snapshot, now: Date.now() }));
  timers.push(setInterval(() => {
    dispatch({ type: 'tick', now: Date.now() });
    pushModel(); // the state lines count minutes
  }, TICK_MS));
  timers.push(setInterval(slowTick, SLOW_MS));
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  if (registry) registry.close();
  if (popup) popup.destroy();
  if (player) player.destroy();
  saver.save(sessions);
  saver.flush();
  if (token) store.removeServerFile(paths.serverFile, token);
  if (server) server.close();
  log('stop');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (popup) popup.pin(); });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', stop);
  app.whenReady().then(start).catch((e) => {
    log('start failed', e);
    dialog.showErrorBox('Claude Sessions', `Could not start:\n${e.message}`);
    app.quit();
  });
}
