// Main-process side of the sound player: a hidden window that owns one
// AudioContext (renderer/sound-engine.js). Main only ever reads a file whose
// id is in the catalog. Every play waits for the window to answer; a window
// that does not answer in time is replaced and the play sent once more, so a
// hung renderer cannot keep the tray silent without a line in tray.log.
'use strict';
const fs = require('fs');
const path = require('path');
const { playPattern } = require('./sounds');

const FALLBACK = 'synth:marimba';
const ACK_MS = 6000; // the engine takes up to about 3 s to give up on a dead output

/**
 * fileFor(id) returns the file behind a catalog id, or undefined.
 * Returns { play(id, kind, volume), preview(id, volume), destroy() }. play and
 * preview resolve to { ok: true } or { ok: false, code, message }; they never
 * reject. code is 'output', 'file', 'other' (from the engine), 'no-answer' or
 * 'closed'.
 */
function createPlayer({ fileFor, log = () => {}, electron = require('electron'), ackMs = ACK_MS }) {
  const { BrowserWindow, ipcMain } = electron;
  let win = null;
  let contents = null; // win.webContents, kept so a sender check never touches a destroyed window
  let ready = false;
  let closed = false;
  let seq = 0;
  const pending = new Map(); // n -> { msg, resolve, timer, tries, posted }

  const fromPlayer = (e) => !!contents && !!e && e.sender === contents;

  ipcMain.handle('player:load', async (e, id) => {
    if (!fromPlayer(e)) throw new Error('not from the sound player');
    const file = fileFor(id);
    if (!file) throw new Error(`not in the sound catalog: ${id}`);
    return fs.promises.readFile(file);
  });

  function onDone(e, n) {
    if (fromPlayer(e)) settle(n, { ok: true });
  }

  function onFailed(e, n, message, code) {
    if (!fromPlayer(e)) return;
    const p = pending.get(n);
    if (!p) return;
    const c = typeof code === 'string' && code ? code : 'other';
    log('sound failed', p.msg.id, c, message);
    settle(n, { ok: false, code: c, message: String(message) });
    // An alert whose file is gone or will not decode still makes a sound. When
    // the output itself is down, a built-in sound would fail the same way.
    if (!p.msg.preview && p.msg.id !== FALLBACK && c !== 'output') send({ ...p.msg, id: FALLBACK });
  }

  function onStatus(e, info) {
    if (fromPlayer(e)) log('sound output', JSON.stringify(info));
  }

  ipcMain.on('player:done', onDone);
  ipcMain.on('player:failed', onFailed);
  ipcMain.on('player:status', onStatus);

  function settle(n, result) {
    const p = pending.get(n);
    if (!p) return;
    pending.delete(n);
    clearTimeout(p.timer);
    p.resolve(result);
  }

  function post(p) {
    contents.send('player:play', p.msg);
    p.posted = true;
  }

  function ensure() {
    if (win && !win.isDestroyed()) return;
    ready = false;
    const w = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-player.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        // Alerts play with no click in this window; never wait for one.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win = w;
    contents = w.webContents;
    const wc = w.webContents;
    wc.on('did-finish-load', () => {
      if (win !== w) return;
      ready = true;
      for (const p of pending.values()) if (!p.posted) post(p);
    });
    wc.on('did-fail-load', (_e, code, desc) => log('sound player did not load', code, desc));
    wc.on('preload-error', (_e, file, err) => log('sound player preload error', file, err && err.message));
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) log('sound player error', message, `${path.basename(String(sourceId || ''))}:${line}`);
    });
    wc.on('render-process-gone', (_e, details) => {
      const why = `sound player gone (${details && details.reason})`;
      log(why);
      if (win !== w) return;
      forget();
      setImmediate(() => {
        if (!w.isDestroyed()) w.destroy();
      });
      for (const p of [...pending.values()]) retry(p, why);
    });
    Promise.resolve(w.loadFile(path.join(__dirname, 'renderer', 'sound-player.html'))).catch(() => {});
  }

  function forget() {
    win = null;
    contents = null;
    ready = false;
  }

  /** Close the window; the next delivery opens a new one. */
  function drop() {
    const w = win;
    forget();
    if (w && !w.isDestroyed()) w.destroy();
  }

  function deliver(p) {
    p.tries++;
    p.posted = false;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => restart(`no answer for ${p.msg.id} in ${ackMs} ms`), ackMs);
    try {
      ensure();
    } catch (err) {
      // The timer above gives up on it, the same as a window that never answers.
      log('sound player could not start', err && err.message);
      return;
    }
    if (ready) post(p);
  }

  function retry(p, why) {
    if (p.tries >= 2) {
      log('sound gave up', p.msg.id, why);
      settle(p.msg.n, { ok: false, code: 'no-answer', message: why });
    } else {
      deliver(p);
    }
  }

  function restart(why) {
    log('sound player restarted:', why);
    drop();
    for (const p of [...pending.values()]) retry(p, why);
  }

  function send(fields) {
    if (closed) return Promise.resolve({ ok: false, code: 'closed', message: 'the sound player is closed' });
    return new Promise((resolve) => {
      const msg = { ...fields, n: ++seq };
      const p = { msg, resolve, timer: null, tries: 0, posted: false };
      pending.set(msg.n, p);
      deliver(p);
    });
  }

  return {
    play(id, kind, volume) {
      const { repeats, gap } = playPattern(kind);
      return send({ id, repeats, gap, volume });
    },
    preview(id, volume) {
      return send({ id, repeats: 1, gap: 0, volume, preview: true });
    },
    destroy() {
      closed = true;
      ipcMain.removeHandler('player:load');
      ipcMain.removeListener('player:done', onDone);
      ipcMain.removeListener('player:failed', onFailed);
      ipcMain.removeListener('player:status', onStatus);
      drop();
      for (const n of [...pending.keys()]) settle(n, { ok: false, code: 'closed', message: 'the sound player is closed' });
    },
  };
}

module.exports = { createPlayer, FALLBACK, ACK_MS };
