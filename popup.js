// The popup window and when it shows. Hovering the tray icon opens it
// without focus; a click on the icon (or into the card) pins it open and
// focused so you can edit, and it closes when it loses focus.
'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { createHoverTracker } = require('./hover');

const WIDTH = 320;
const MAX_HEIGHT = 520;
const MARGIN = 8;
const ICON_REFRESH_MS = 2000; // re-read the icon's rectangle in case icons moved
const MEASURE_MS = 150;       // longest wait for the renderer's height before showing
const REOPEN_GUARD_MS = 500;  // a tray click right after a blur-hide only closes

/**
 * getModel() builds what the renderer draws. onHide(shownMs) runs after the
 * popup closes, with how long it was open.
 */
function createPopup({ tray, getModel, onHide = () => {}, log = () => {} }) {
  let win = null;
  let loaded = null;
  let mode = 'hidden'; // 'hidden' | 'hover' | 'pinned'
  let opening = false;
  let showSeq = 0;
  let shownAt = 0;
  let height = 120;
  let holds = 0;
  let lastBlurHideAt = 0;
  let timer = null;
  let stopped = false;
  let icon = null;
  let iconAt = 0;
  const waiters = new Set();
  const channels = [];
  const tracker = createHoverTracker();

  function alive() {
    return !!win && !win.isDestroyed();
  }

  function ensure() {
    if (alive()) return loaded;
    win = new BrowserWindow({
      width: WIDTH,
      height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    // Shows on the current Space, full-screen apps included, like a menu bar menu.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('focus', () => {
      // Clicking into the hover card pins it, so it stays while you work in it.
      if (mode === 'hover') mode = 'pinned';
    });
    win.on('blur', () => {
      if (mode !== 'pinned' || holds > 0) return;
      lastBlurHideAt = Date.now();
      hide();
    });
    win.on('closed', () => {
      win = null;
      loaded = null;
      mode = 'hidden';
    });
    loaded = win.loadFile(path.join(__dirname, 'renderer', 'popup.html')).catch((e) => {
      log(`popup load failed: ${e.message}`);
      throw e;
    });
    return loaded;
  }

  function fromPopup(e) {
    return alive() && e.sender === win.webContents;
  }

  /** Below the menu bar icon (above it if the icon were at the bottom), inside the work area. */
  function bounds() {
    const ic = tray.getBounds();
    const anchor = ic.width ? ic : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const wa = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
    const h = Math.min(height, wa.height - 2 * MARGIN);
    const taskbarOnTop = anchor.y < wa.y + wa.height / 2;
    const centred = Math.round(anchor.x + anchor.width / 2 - WIDTH / 2);
    const x = Math.min(Math.max(centred, wa.x + MARGIN), wa.x + wa.width - WIDTH - MARGIN);
    const y = taskbarOnTop ? wa.y + MARGIN : wa.y + wa.height - h - MARGIN;
    return { x, y, width: WIDTH, height: h };
  }

  function push() {
    if (!alive() || !loaded) return;
    loaded.then(() => {
      if (alive()) win.webContents.send('popup:model', getModel());
    }, () => {});
  }

  /** Sends a fresh model and waits for the renderer to report the card's height. */
  function measure() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, MEASURE_MS);
      waiters.add(done);
      win.webContents.send('popup:model', getModel());
    });
  }

  async function open(next) {
    const seq = ++showSeq;
    opening = true;
    try {
      await ensure();
      if (seq !== showSeq || !alive()) return;
      await measure();
      if (seq !== showSeq || !alive()) return;
      win.setBounds(bounds());
      if (mode === 'hidden') shownAt = Date.now();
      if (next === 'pinned') {
        // A menu bar app is not the active app, so it takes focus first.
        app.focus({ steal: true });
        win.show();
        win.focus();
      } else if (!win.isVisible()) {
        win.showInactive();
      }
      // A pinned popup never drops back to hover.
      if (mode !== 'pinned') mode = next;
    } catch (e) {
      log(`popup show failed: ${e.message}`);
    } finally {
      if (seq === showSeq) opening = false;
    }
    tick();
  }

  function hide() {
    showSeq++;
    opening = false;
    if (mode === 'hidden') return;
    const shownMs = Date.now() - shownAt;
    mode = 'hidden';
    if (alive()) {
      win.hide();
      win.webContents.send('popup:reset');
    }
    onHide(shownMs);
  }

  function pin() {
    tracker.suppress();
    return open('pinned');
  }

  function onTrayClick() {
    tracker.suppress();
    if (mode === 'pinned') return hide();
    // The click that blurred the popup also lands here: let it only close.
    if (Date.now() - lastBlurHideAt < REOPEN_GUARD_MS) return;
    pin();
  }

  function iconBounds(now) {
    if (!icon || now - iconAt >= ICON_REFRESH_MS) {
      icon = tray.getBounds();
      iconAt = now;
    }
    return icon;
  }

  /**
   * Polls the cursor against the icon and the card. Electron does not reliably
   * deliver the tray's 'mouse-enter', so this poll is what opens the card; the
   * tray mouse events only make it react sooner.
   */
  function tick() {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const now = Date.now();
    if (mode !== 'pinned') {
      const visible = mode === 'hover' || opening;
      const action = tracker.tick({
        now,
        cursor: screen.getCursorScreenPoint(),
        icon: iconBounds(now),
        card: mode === 'hover' && alive() ? win.getBounds() : null,
        visible,
      });
      if (action === 'show') open('hover');
      else if (action === 'hide') hide();
    }
    timer = setTimeout(tick, mode === 'pinned' ? 250 : tracker.nextTickIn(now));
    if (timer.unref) timer.unref();
  }

  /**
   * Keeps the popup open while a native menu or dialog it opened has focus.
   * If focus did not come back afterwards, the popup closes as a blur would.
   */
  async function holdOpen(fn) {
    holds++;
    try {
      return await fn();
    } finally {
      holds--;
      if (holds === 0) {
        setTimeout(() => {
          if (holds === 0 && mode === 'pinned' && alive() && !win.isFocused()) hide();
        }, 150);
      }
    }
  }

  /** ipcMain.on for messages from this popup only. */
  function on(channel, fn) {
    const handler = (e, ...args) => {
      if (fromPopup(e)) fn(...args);
    };
    ipcMain.on(channel, handler);
    channels.push(() => ipcMain.removeListener(channel, handler));
  }

  /** ipcMain.handle for requests from this popup only. */
  function handle(channel, fn) {
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromPopup(e)) throw new Error('not from the popup');
      return fn(...args);
    });
    channels.push(() => ipcMain.removeHandler(channel));
  }

  on('popup:resize', (h) => {
    const n = Math.ceil(Number(h));
    if (!Number.isFinite(n) || n <= 0) return;
    height = Math.min(MAX_HEIGHT, Math.max(40, n));
    if (mode !== 'hidden' && alive()) win.setBounds(bounds());
    for (const done of [...waiters]) done();
  });
  on('popup:close', () => hide());

  for (const event of ['mouse-enter', 'mouse-move', 'mouse-leave']) tray.on(event, () => tick());
  tray.on('click', onTrayClick);
  tray.on('double-click', () => tracker.suppress());
  ensure().catch(() => {}); // load early so the first hover is quick
  tick();

  return {
    pin,
    hide,
    push,
    holdOpen,
    on,
    handle,
    /** Sends a message to the renderer. */
    send(channel, ...args) {
      if (alive()) win.webContents.send(channel, ...args);
    },
    isVisible: () => mode !== 'hidden',
    window: () => (alive() ? win : null),
    /** After a right-click: close, and stay closed until the pointer leaves the icon. */
    dismiss() {
      tracker.suppress();
      hide();
    },
    destroy() {
      stopped = true;
      clearTimeout(timer);
      for (const off of channels) off();
      if (alive()) win.destroy();
    },
  };
}

module.exports = { createPopup, WIDTH, MAX_HEIGHT };
