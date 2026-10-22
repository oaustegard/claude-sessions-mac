'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEntry, readSnapshot } = require('../registry');

// Shape copied from a real ~/.claude/sessions/<pid>.json on 2026-10-19 (values changed).
const REAL = {
  pid: 31337,
  sessionId: '0f6c1a2e-1111-2222-3333-444455556666',
  cwd: 'U:\\work\\agents',
  startedAt: 1760900000000,
  procStart: '134055000000000000',
  version: '2.9.1',
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'shop-3fa',
  nameSource: 'derived',
  status: 'waiting',
  statusUpdatedAt: 1760900005000,
  updatedAt: 1760900005000,
};

test('parseEntry reads the real shape', () => {
  const e = parseEntry(JSON.stringify(REAL), 31337);
  assert.strictEqual(e.pid, 31337);
  assert.strictEqual(e.entrypoint, 'cli');
  assert.strictEqual(e.status, 'waiting');
  assert.strictEqual(e.statusUpdatedAt, 1760900005000);
  assert.strictEqual(e.nameSource, 'derived');
});

test('parseEntry tolerates missing fields and rejects junk', () => {
  const e = parseEntry(JSON.stringify({ cwd: 'C:\\x', status: 'sleeping', updatedAt: 5 }), 77);
  assert.strictEqual(e.pid, 77);
  assert.strictEqual(e.status, undefined);
  assert.strictEqual(e.statusUpdatedAt, 5);
  assert.strictEqual(parseEntry('{"pid": 12', 12), null);
  assert.strictEqual(parseEntry('[]', 0), null);
  assert.strictEqual(parseEntry('null', 5), null);
});

test('readSnapshot skips key files and counts unparseable files as present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reg-'));
  fs.writeFileSync(path.join(dir, '31337.json'), JSON.stringify(REAL));
  fs.writeFileSync(path.join(dir, '400.json'), '{"pid": 4'); // mid-write
  fs.writeFileSync(path.join(dir, '31337.abc123.key'), 'SECRET');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
  const snap = readSnapshot(dir);
  assert.strictEqual(snap.ok, true);
  assert.deepStrictEqual(snap.entries.map((e) => e.pid), [31337]);
  assert.deepStrictEqual(snap.present.sort(), [31337, 400].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing sessions folder reads as empty, not as an error', () => {
  const snap = readSnapshot(path.join(os.tmpdir(), 'cs-no-such-dir-' + Date.now()));
  assert.deepStrictEqual(snap, { ok: true, entries: [], present: [] });
});
