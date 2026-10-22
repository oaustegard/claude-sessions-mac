'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { popupModel, ENDED_SHOWN, focusNotice, soundNotice } = require('../popup-view');
const { BUILT_IN } = require('../sounds');

const NOW = Date.UTC(2026, 9, 19, 14, 0, 0);
const row = (pid, st, extra = {}) => ({
  pid, state: st, since: NOW - 120000, lastActivity: NOW - pid, entrypoint: 'cli',
  sessionId: `s${pid}`, project: 'shop', cwd: 'C:\\work\\shop', ...extra,
});
const config = (extra = {}) => ({ showAll: false, dndUntil: 0, volume: 0.8, aliases: {}, projectSounds: {}, sessionSounds: {}, muted: {}, ...extra });
const bySessions = (...rows) => Object.fromEntries(rows.map((r) => [String(r.pid), r]));

test('rows come most urgent first, then ended ones dimmed at the bottom', () => {
  const sessions = bySessions(
    row(1, 'working', { tool: 'Edit' }),
    row(2, 'needs', { needsReason: 'Needs permission: Bash' }),
    row(3, 'ended', { endedAt: NOW - 60000, since: NOW - 60000 }),
    row(4, 'done', { project: 'site', branch: 'main' }),
    row(5, 'idle', { entrypoint: 'sdk-py' }),
  );
  const m = popupModel({ sessions, config: config(), now: NOW });
  assert.deepStrictEqual(m.rows.map((r) => [r.key, r.state, r.dimmed]), [
    ['2', 'needs', false], ['4', 'done', false], ['1', 'working', false], ['3', 'ended', true],
  ]);
  assert.strictEqual(m.header.title, '3 sessions');
  assert.strictEqual(m.header.counts, '1 needs you, 1 done, 1 working');
  assert.strictEqual(m.header.top, 'needs');
  assert.strictEqual(m.rows[0].line, 'Needs permission: Bash · 2m');
  assert.strictEqual(m.rows[1].where, 'site · main');
  assert.strictEqual(m.rows[2].line, 'Working 2m · Edit');
  assert.strictEqual(m.rows[3].line, 'Ended 1m ago');
  const all = popupModel({ sessions, config: config({ showAll: true }), now: NOW });
  assert.strictEqual(all.rows.length, 5);
  assert.strictEqual(all.showAll, true);
  assert.strictEqual(all.openAtLogin, false);
  assert.strictEqual(popupModel({ sessions, config: config(), now: NOW, openAtLogin: true }).openAtLogin, true);
});

test('a row carries its alias, sound, mute flag and resume command', () => {
  const sessions = bySessions(row(7, 'done', { firstPrompt: 'fix the tray hover' }), row(8, 'idle', { sessionId: undefined, project: undefined, cwd: 'C:\\tmp\\scratch' }));
  const cfg = config({ aliases: { s7: 'hover fix' }, projectSounds: { shop: 'synth:bell' }, sessionSounds: {}, muted: { s7: true } });
  const [a, b] = popupModel({ sessions, config: cfg, now: NOW }).rows;
  assert.strictEqual(a.where, 'shop · hover fix');
  assert.strictEqual(a.name, '');
  assert.strictEqual(a.alias, 'hover fix');
  assert.deepStrictEqual(a.sound, { id: 'synth:bell', label: 'Bell', from: 'project' });
  assert.strictEqual(a.muted, true);
  assert.strictEqual(a.resume, 'claude --resume s7');
  assert.strictEqual(a.project, 'shop');
  assert.strictEqual(b.where, 'scratch');
  assert.strictEqual(b.resume, '');
  assert.strictEqual(b.muted, false);
  assert.strictEqual(b.sound.from, 'default');
});

test('a session override shows on the chip, and hidden rows stay out', () => {
  const catalog = [...BUILT_IN, { id: 'mac:Glass.aiff', label: 'Glass', group: 'macOS', file: 'x' }];
  const sessions = bySessions(row(1, 'idle'), row(2, 'working', { hidden: true }));
  const m = popupModel({ sessions, config: config({ sessionSounds: { s1: 'mac:Glass.aiff' } }), catalog, now: NOW });
  assert.deepStrictEqual(m.rows.map((r) => r.key), ['1']);
  assert.deepStrictEqual(m.rows[0].sound, { id: 'mac:Glass.aiff', label: 'Glass', from: 'session' });
  assert.deepStrictEqual(m.groups.map((g) => g.name), ['Built-in', 'macOS']);
  assert.strictEqual(m.groups[1].sounds[0].file, undefined);
});

test('header shows do not disturb, volume as a percentage, and an empty state', () => {
  const until = NOW + 30 * 60000;
  const m = popupModel({ sessions: {}, config: config({ dndUntil: until, volume: 0.456 }), now: NOW, hooksInstalled: false });
  assert.strictEqual(m.header.title, 'No sessions');
  assert.strictEqual(m.header.counts, '');
  assert.strictEqual(m.header.dnd.on, true);
  assert.match(m.header.dnd.until, /^\d\d:\d\d$/);
  assert.strictEqual(m.volume, 46);
  assert.strictEqual(m.hooksInstalled, false);
  assert.deepStrictEqual(popupModel({ sessions: {}, config: config({ dndUntil: NOW - 1, volume: 7 }), now: NOW }).header.dnd, { on: false, until: '' });
  assert.strictEqual(popupModel({ sessions: {}, config: config({ volume: 7 }), now: NOW }).volume, 100);
});

test('each reason focus.js gives for a window that stayed put has a plain notice', () => {
  // The reasons as focus.js writes them.
  assert.strictEqual(focusNotice('no process'), 'Its process has ended');
  assert.strictEqual(focusNotice('process gone'), 'Its process has ended');
  assert.strictEqual(focusNotice('no window (claude < zsh)'), "Couldn't find its window");
  assert.strictEqual(focusNotice('no window (no chain)'), "Couldn't find its window");
  assert.strictEqual(focusNotice('open failed: no such app'), "Couldn't show its window");
  assert.strictEqual(focusNotice(undefined), "Couldn't show its window");
  // Remote Control bridges and SDK runs have no window at all.
  assert.strictEqual(focusNotice('no window (claude < node)', row(1, 'idle', { entrypoint: 'sdk-cli' })), 'It runs in the background, with no window');
  assert.strictEqual(focusNotice('no window (no chain)', row(1, 'idle', { entrypoint: 'sdk-py' })), 'It runs in the background, with no window');
  assert.strictEqual(focusNotice('no window (no chain)', row(1, 'idle')), "Couldn't find its window");
});

test('each result code player.js gives for a silent preview has a plain notice', () => {
  assert.strictEqual(soundNotice('output'), "No sound: the audio output didn't start");
  assert.strictEqual(soundNotice('no-answer'), "No sound: the sound player didn't answer");
  assert.strictEqual(soundNotice('file'), "Couldn't play that sound file");
  assert.strictEqual(soundNotice('volume'), 'Volume is at 0%');
  assert.strictEqual(soundNotice('missing'), "Couldn't play that sound");
  assert.strictEqual(soundNotice('other'), "Couldn't play that sound");
  assert.strictEqual(soundNotice(undefined), "Couldn't play that sound");
});

test('background rows are flagged so the popup hides their expand button', () => {
  const sessions = bySessions(row(1, 'idle'), row(2, 'idle', { entrypoint: 'sdk-cli' }), row(3, 'idle', { entrypoint: 'claude-desktop' }));
  const m = popupModel({ sessions, config: config({ showAll: true }), now: NOW });
  assert.deepStrictEqual(Object.fromEntries(m.rows.map((r) => [r.key, r.background])), { 1: false, 2: true, 3: false });
});

test('only the newest ended sessions are listed', () => {
  const ended = Array.from({ length: ENDED_SHOWN + 2 }, (_, i) => row(10 + i, 'ended', { endedAt: NOW - i * 1000 }));
  const m = popupModel({ sessions: bySessions(...ended), config: config(), now: NOW });
  assert.deepStrictEqual(m.rows.map((r) => r.key), ['10', '11', '12']);
  assert.ok(m.rows.every((r) => r.dimmed));
});
