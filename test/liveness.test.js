'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deadPids, isAlive } = require('../liveness');

const START = 'Thu Oct 22 02:08:34 2026'; // ps lstart, in UTC
const START_MS = Date.UTC(2026, 9, 22, 2, 8, 34);

test('a missing process is dead', () => {
  const alive = (pid) => pid !== 2;
  assert.deepStrictEqual(deadPids([{ pid: 1 }, { pid: 2 }], { alive, createdAt: () => null }), [2]);
});

test('a live PID that started at another time belongs to a new process', () => {
  const created = { 1: START_MS + 400, 2: START_MS + 99000 };
  const rows = [{ pid: 1, procStart: START }, { pid: 2, procStart: START }];
  assert.deepStrictEqual(deadPids(rows, { alive: () => true, createdAt: (pid) => created[pid] }), [2]);
});

test('no start time on either side keeps the session alive', () => {
  const rows = [{ pid: 1 }, { pid: 2, procStart: START }];
  assert.deepStrictEqual(deadPids(rows, { alive: () => true, createdAt: () => null }), []);
});

test('this process is alive', () => {
  assert.strictEqual(isAlive(process.pid), true);
});
