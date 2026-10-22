'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, saveConfig, loadState, stateSaver, writeServerFile, removeServerFile, drainSpool } = require('../store');
const { labelsFor } = require('../labels');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-store-'));

test('config falls back to defaults and round-trips', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'config.json');
  const empty = { showAll: false, dndUntil: 0, volume: 0.8, aliases: {}, projectSounds: {}, sessionSounds: {}, muted: {} };
  assert.deepStrictEqual(loadConfig(file), empty);
  const full = { showAll: true, dndUntil: 5, volume: 0.4, aliases: { s1: 'api' }, projectSounds: { shop: 'synth:bell' }, sessionSounds: { s1: 'mac:Glass.aiff' }, muted: { s2: true } };
  saveConfig(file, full);
  assert.deepStrictEqual(loadConfig(file), full);
  saveConfig(file, { volume: 7, aliases: ['x'], muted: null });
  assert.deepStrictEqual(loadConfig(file), { ...empty, volume: 1 });
  saveConfig(file, { volume: -2 });
  assert.strictEqual(loadConfig(file).volume, 0);
  fs.writeFileSync(file, '{broken');
  assert.deepStrictEqual(loadConfig(file), empty);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the state saver batches writes and flush writes now', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  const saver = stateSaver(file, 60000);
  saver.save({ 1: { pid: 1 } });
  saver.save({ 2: { pid: 2 } });
  assert.ok(!fs.existsSync(file));
  saver.flush();
  assert.deepStrictEqual(loadState(file), { 2: { pid: 2 } });
  assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
  assert.deepStrictEqual(loadState(path.join(dir, 'nope.json')), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server.json is removed only by the tray that wrote it', () => {
  const dir = tmp();
  const file = path.join(dir, 'server.json');
  writeServerFile(file, { port: 47860, token: 'mine', pid: 1 });
  removeServerFile(file, 'other');
  assert.ok(fs.existsSync(file));
  removeServerFile(file, 'mine');
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drainSpool returns spooled events oldest first, including a crashed drain, and empties the folder', () => {
  const dir = tmp();
  const spool = path.join(dir, 'spool.jsonl');
  fs.writeFileSync(spool, [
    JSON.stringify({ event: 'Stop', pid: 1, ts: 30 }),
    '{"event":"Stop","pid":', // cut off
    JSON.stringify({ event: 'UserPromptSubmit', pid: 1, ts: 10 }),
    JSON.stringify({ event: 'x' }), // no pid
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'spool.123.jsonl'), JSON.stringify({ event: 'SessionStart', pid: 1, ts: 5 }) + '\n');
  fs.writeFileSync(path.join(dir, 'server.json'), '{}');
  const events = drainSpool(spool);
  assert.deepStrictEqual(events.map((e) => e.ts), [5, 10, 30]);
  assert.deepStrictEqual(fs.readdirSync(dir), ['server.json']);
  assert.deepStrictEqual(drainSpool(spool), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('labels read a repo, a linked worktree, a detached HEAD and a plain folder', async () => {
  const root = tmp();
  const repo = path.join(root, 'shop');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'checkout'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.deepStrictEqual(await labelsFor(path.join(repo, 'src', 'core')), { project: 'shop', branch: 'main' });

  const wt = path.join(root, 'wt-checkout');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'checkout')}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'checkout', 'HEAD'), 'ref: refs/heads/checkout\n');
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'checkout', 'commondir'), '../..\n');
  assert.deepStrictEqual(await labelsFor(wt), { project: 'shop', branch: 'checkout' });

  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'abc12340123456789abcdef0123456789abcdef0\n');
  assert.deepStrictEqual(await labelsFor(repo), { project: 'shop', branch: 'abc1234' });

  const plain = path.join(root, 'notes folder');
  fs.mkdirSync(plain);
  const got = await labelsFor(plain);
  assert.strictEqual(got.project, 'notes folder');
  fs.rmSync(root, { recursive: true, force: true });
});
