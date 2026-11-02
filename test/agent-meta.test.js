'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAgentMeta, isMetaPath, createMetaLookup } = require('../agent-meta');

test('readAgentMeta keeps the fields the tray uses', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-meta-')), 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent-af0c2bb51a7a272ab.meta.json');
  fs.writeFileSync(file, JSON.stringify({ agentType: 'Explore', isBuiltIn: false, description: 'Inner listing', toolUseId: 'tu1', parentAgentId: 'a33', spawnDepth: 2, requestShape: 'foreground', requestNonInteractive: true }));
  assert.deepStrictEqual(readAgentMeta(file), { agentType: 'Explore', description: 'Inner listing', toolUseId: 'tu1', parentAgentId: 'a33', spawnDepth: 2, requestShape: 'foreground' });
  fs.writeFileSync(file, '{ half');
  assert.strictEqual(readAgentMeta(file), null);
  assert.strictEqual(readAgentMeta(path.join(dir, 'agent-missing.meta.json')), null);
});

test('only a meta file inside a subagents folder is read', () => {
  assert.ok(isMetaPath('/Users/h/s1/subagents/agent-a1.meta.json'));
  assert.ok(!isMetaPath('/Users/h/s1/agent-a1.meta.json'));
  assert.ok(!isMetaPath('/Users/h/s1/subagents/settings.json'));
  assert.ok(!isMetaPath('subagents/agent-a1.meta.json'), 'relative');
  assert.ok(!isMetaPath(undefined));
});

/** A schedule that runs callbacks when told, and records the delays asked for. */
function manualClock() {
  const queue = [];
  const delays = [];
  return {
    schedule: (fn, ms) => { delays.push(ms); queue.push(fn); },
    step: () => queue.shift()(),
    delays,
    pending: () => queue.length,
  };
}

test('a lookup retries until the file appears, then answers once', () => {
  const clock = manualClock();
  let reads = 0;
  const lookup = createMetaLookup({ read: () => (++reads >= 3 ? { description: 'x' } : null), delays: [0, 500, 2000, 5000], schedule: clock.schedule });
  const answers = [];
  lookup('k', 'f', (m) => answers.push(m));
  lookup('k', 'f', (m) => answers.push(m)); // already running: dropped
  while (clock.pending()) clock.step();
  assert.deepStrictEqual(answers, [{ description: 'x' }]);
  assert.deepStrictEqual(clock.delays, [0, 500, 1500]);
});

test('a lookup gives up with null after the last try', () => {
  const clock = manualClock();
  const lookup = createMetaLookup({ read: () => null, delays: [0, 10, 20], schedule: clock.schedule });
  const answers = [];
  lookup('k', 'f', (m) => answers.push(m));
  while (clock.pending()) clock.step();
  assert.deepStrictEqual(answers, [null]);
  lookup('k', 'f', (m) => answers.push(m)); // free to ask again
  while (clock.pending()) clock.step();
  assert.deepStrictEqual(answers, [null, null]);
});
