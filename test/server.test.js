'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createServer, newToken, tokenMatches } = require('../server');

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/event', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('tokenMatches compares exactly', () => {
  assert.ok(tokenMatches('abc', 'abc'));
  assert.ok(!tokenMatches('abd', 'abc'));
  assert.ok(!tokenMatches('ab', 'abc'));
  assert.ok(!tokenMatches(undefined, 'abc'));
  assert.strictEqual(newToken().length, 48);
});

test('the server accepts only token-bearing events', async () => {
  const token = newToken();
  const got = [];
  const srv = createServer({ token, onEvent: (ev) => got.push(ev) });
  const port = await srv.listen(0);
  try {
    const ev = { event: 'Stop', pid: 12, ts: 1 };
    assert.strictEqual(await post(port, ev), 403);
    assert.strictEqual(await post(port, ev, { 'x-cs-token': 'wrong' }), 403);
    assert.strictEqual(await post(port, 'nope', { 'x-cs-token': token }), 400);
    assert.strictEqual(await post(port, { event: 'Stop' }, { 'x-cs-token': token }), 400);
    assert.strictEqual(await post(port, ev, { 'x-cs-token': token }), 204);
    assert.strictEqual(await post(port, { event: 'x', pid: 1, pad: 'y'.repeat(70000) }, { 'x-cs-token': token }).catch(() => 413), 413);
    assert.deepStrictEqual(got, [ev]);
  } finally {
    await srv.close();
  }
});

test('a request with a foreign Host header is refused', async () => {
  const token = newToken();
  const srv = createServer({ token, onEvent: () => {} });
  const port = await srv.listen(0);
  try {
    assert.strictEqual(await post(port, { event: 'Stop', pid: 1 }, { 'x-cs-token': token, host: 'evil.example' }), 403);
  } finally {
    await srv.close();
  }
});

test('listen moves to the next port when one is taken', async () => {
  const a = createServer({ token: 't', onEvent: () => {} });
  const first = await a.listen(0);
  const b = createServer({ token: 't', onEvent: () => {} });
  try {
    const second = await b.listen(first, 5);
    assert.notStrictEqual(second, first);
  } finally {
    await a.close();
    await b.close();
  }
});

test('the reporter delivers to a live server end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-'));
  const token = newToken();
  const got = [];
  const srv = createServer({ token, onEvent: (ev) => got.push(ev) });
  const port = await srv.listen(0);
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port, token }));
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'reporter', 'report.js')], {
        env: { ...process.env, CLAUDE_SESSIONS_DIR: dir, CLAUDE_PID: '555' },
      });
      child.on('exit', resolve);
      child.stdin.end(JSON.stringify({ session_id: 's', cwd: 'C:\\x', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs you' }));
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].pid, 555);
    assert.strictEqual(got[0].notificationType, 'permission_prompt');
    assert.ok(!fs.existsSync(path.join(dir, 'spool.jsonl')));
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
