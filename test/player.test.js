'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const { createPlayer, FALLBACK } = require('../player');
const { playPattern } = require('../sounds');

const ACK = 25;

// Stand-ins for the two Electron pieces player.js uses.
function fakeElectron({ failCreate = false } = {}) {
  const windows = [];
  class BrowserWindow {
    constructor(opts) {
      if (failCreate) throw new Error('no window for you');
      this.opts = opts;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.sent = [];
      this.webContents.send = (channel, msg) => this.webContents.sent.push({ channel, msg });
      windows.push(this);
    }
    loadFile(file) {
      this.file = file;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  return { electron: { BrowserWindow, ipcMain }, windows, ipcMain, handlers };
}

function setup(opts = {}) {
  const fake = fakeElectron(opts);
  const lines = [];
  const player = createPlayer({
    fileFor: opts.fileFor || (() => undefined),
    log: (...parts) => lines.push(parts.join(' ')),
    electron: fake.electron,
    ackMs: ACK,
  });
  const loaded = (w) => w.webContents.emit('did-finish-load');
  const sent = (w) => w.webContents.sent.map((s) => s.msg);
  const answer = (w, channel, ...args) => fake.ipcMain.emit(channel, { sender: w.webContents }, ...args);
  return { ...fake, player, lines, loaded, sent, answer };
}

async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('a play waits for the window to load, then resolves when the player answers', async () => {
  const t = setup();
  const res = t.player.play('synth:bell', 'needs', 0.5);
  assert.strictEqual(t.windows.length, 1);
  assert.deepStrictEqual(t.sent(t.windows[0]), []);
  t.loaded(t.windows[0]);
  const [msg] = t.sent(t.windows[0]);
  assert.deepStrictEqual(msg, { id: 'synth:bell', ...playPattern('needs'), volume: 0.5, n: 1 });
  t.answer(t.windows[0], 'player:done', msg.n);
  assert.deepStrictEqual(await res, { ok: true });
  t.player.destroy();
});

test('the player window plays without a click and stays hidden', () => {
  const t = setup();
  t.player.preview('synth:bell', 0.8);
  const { opts } = t.windows[0];
  assert.strictEqual(opts.show, false);
  assert.strictEqual(opts.webPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.strictEqual(opts.webPreferences.sandbox, true);
  assert.strictEqual(opts.webPreferences.contextIsolation, true);
  assert.match(t.windows[0].file, /sound-player\.html$/);
  t.player.destroy();
});

test('a window that does not answer is replaced and the play sent once more', async () => {
  const t = setup();
  const res = t.player.preview('synth:bell', 0.8);
  t.loaded(t.windows[0]);
  await until(() => t.windows.length === 2);
  assert.strictEqual(t.windows[0].destroyed, true);
  t.loaded(t.windows[1]);
  const [msg] = t.sent(t.windows[1]);
  assert.strictEqual(msg.n, 1);
  t.answer(t.windows[0], 'player:done', msg.n); // the old window no longer counts
  t.answer(t.windows[1], 'player:done', msg.n);
  assert.deepStrictEqual(await res, { ok: true });
  assert.ok(t.lines.some((l) => l.startsWith('sound player restarted: no answer for synth:bell')));
  t.player.destroy();
});

test('after two windows with no answer the play gives up with code no-answer', async () => {
  const t = setup();
  const res = t.player.play('synth:bell', 'done', 0.8);
  t.loaded(t.windows[0]);
  await until(() => t.windows.length === 2);
  t.loaded(t.windows[1]);
  const out = await res;
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'no-answer');
  assert.strictEqual(t.windows.length, 2);
  assert.ok(t.lines.some((l) => l.startsWith('sound gave up synth:bell')));
  t.player.destroy();
});

test('a window that cannot be created gives up the same way', async () => {
  const t = setup({ failCreate: true });
  const out = await t.player.play('synth:bell', 'done', 0.8);
  assert.strictEqual(out.code, 'no-answer');
  assert.strictEqual(t.lines.filter((l) => l.startsWith('sound player could not start')).length, 2);
  t.player.destroy();
});

test('a failed alert plays the fallback sound and logs why', async () => {
  const t = setup();
  const res = t.player.play('file:chime', 'needs', 0.6);
  t.loaded(t.windows[0]);
  t.answer(t.windows[0], 'player:failed', 1, 'could not load file:chime: ENOENT', 'file');
  assert.deepStrictEqual(await res, { ok: false, code: 'file', message: 'could not load file:chime: ENOENT' });
  const msgs = t.sent(t.windows[0]);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs[1], { id: FALLBACK, ...playPattern('needs'), volume: 0.6, n: 2 });
  assert.ok(t.lines.includes('sound failed file:chime file could not load file:chime: ENOENT'));
  t.player.destroy();
});

test('no fallback for a preview, a down output or the fallback itself', async () => {
  const t = setup();
  const runs = [
    [t.player.preview('file:chime', 0.8), 'file'],
    [t.player.play('file:chime', 'done', 0.8), 'output'],
    [t.player.play(FALLBACK, 'done', 0.8), 'other'],
  ];
  t.loaded(t.windows[0]);
  runs.forEach(([, code], i) => t.answer(t.windows[0], 'player:failed', i + 1, 'no', code));
  for (const [res, code] of runs) assert.strictEqual((await res).code, code);
  assert.strictEqual(t.sent(t.windows[0]).length, 3);
  t.player.destroy();
});

test('a crashed player gets a new window and the play is sent again', async () => {
  const t = setup();
  const res = t.player.play('synth:bell', 'done', 0.8);
  t.loaded(t.windows[0]);
  t.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.strictEqual(t.windows.length, 2);
  await until(() => t.windows[0].destroyed);
  t.loaded(t.windows[1]);
  t.answer(t.windows[1], 'player:done', 1);
  assert.deepStrictEqual(await res, { ok: true });
  assert.ok(t.lines.includes('sound player gone (crashed)'));
  t.player.destroy();
});

test('output status lines are logged, from the player window only', () => {
  const t = setup();
  t.player.preview('synth:bell', 0.8);
  t.answer(t.windows[0], 'player:status', { event: 'output opened', state: 'running' });
  t.ipcMain.emit('player:status', { sender: {} }, { event: 'forged' });
  assert.deepStrictEqual(t.lines, ['sound output {"event":"output opened","state":"running"}']);
  t.player.destroy();
});

test('player:load reads catalog files for the player window and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cst-player-'));
  const file = path.join(dir, 'chime.wav');
  fs.writeFileSync(file, Buffer.from([7, 8, 9]));
  const t = setup({ fileFor: (id) => (id === 'file:chime' ? file : undefined) });
  t.player.preview('file:chime', 0.8);
  const load = t.handlers.get('player:load');
  const own = { sender: t.windows[0].webContents };
  assert.deepStrictEqual([...(await load(own, 'file:chime'))], [7, 8, 9]);
  await assert.rejects(load(own, 'file:other'), /not in the sound catalog/);
  await assert.rejects(load({ sender: {} }, 'file:chime'), /not from the sound player/);
  t.player.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('destroy settles what is pending and removes its IPC listeners', async () => {
  const t = setup();
  const res = t.player.play('synth:bell', 'done', 0.8);
  t.player.destroy();
  assert.strictEqual((await res).code, 'closed');
  assert.strictEqual((await t.player.preview('synth:bell', 0.8)).code, 'closed');
  assert.strictEqual(t.windows[0].destroyed, true);
  assert.strictEqual(t.handlers.has('player:load'), false);
  for (const channel of ['player:done', 'player:failed', 'player:status']) {
    assert.strictEqual(t.ipcMain.listenerCount(channel), 0);
  }
});
