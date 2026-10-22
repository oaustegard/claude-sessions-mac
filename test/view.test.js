'use strict';
const test = require('node:test');
const assert = require('node:assert');
const v = require('../view');

const summary = (counts) => ({ counts: { needs: 0, error: 0, done: 0, working: 0, idle: 0, ...counts }, total: Object.values(counts).reduce((a, b) => a + b, 0) });
const local = (h, m) => new Date(2026, 9, 19, h, m).getTime();

test('the tooltip counts sessions, says when hooks are missing or DND is on, and fits in 127 characters', () => {
  assert.strictEqual(v.tooltip(summary({ needs: 1, done: 2, working: 1 })), 'Claude Sessions: 1 needs you, 2 done, 1 working');
  assert.strictEqual(v.tooltip(summary({ needs: 2, error: 1 })), 'Claude Sessions: 2 need you, 1 failed');
  assert.strictEqual(v.tooltip(summary({})), 'Claude Sessions: no sessions');
  assert.strictEqual(v.tooltip(summary({ idle: 3 }), { hooksInstalled: false }), 'Claude Sessions: hooks not installed');
  const now = local(14, 0);
  assert.strictEqual(v.tooltip(summary({ idle: 1 }), { dndUntil: local(14, 30), now }), 'Claude Sessions: 1 idle (quiet until 14:30)');
  assert.strictEqual(v.tooltip(summary({ idle: 1 }), { dndUntil: local(13, 30), now }), 'Claude Sessions: 1 idle');
  assert.ok(v.tooltip(summary({ needs: 99999999, error: 99999999, done: 99999999, working: 99999999, idle: 99999999 }), { dndUntil: now + 1, now }).length <= v.TOOLTIP_MAX);
  assert.strictEqual(v.headerText(summary({ working: 1 })), '1 session: 1 working');
  assert.strictEqual(v.headerText(summary({})), 'No Claude Code sessions');
});

test('menu lines show where, name and state, "&" as it is', () => {
  const now = local(12, 0);
  const row = { pid: 1, state: 'working', since: now - 6 * 60000, tool: 'Edit', project: 'R&D', branch: 'main', firstPrompt: 'fix the tray' };
  assert.strictEqual(v.menuLabel(row, undefined, now), 'R&D · main: fix the tray  ·  Working 6m · Edit');
  assert.strictEqual(v.menuLabel({ ...row, firstPrompt: undefined }, 'api', now), 'R&D · api  ·  Working 6m · Edit');
  assert.ok(v.menuLabel({ ...row, firstPrompt: 'x'.repeat(300) }, undefined, now).length <= 91);
});

test('toasts name the session and carry the reason, the error or the first line of the reply', () => {
  const row = { pid: 1, project: 'shop', branch: 'checkout', needsReason: 'Claude needs your permission to use Bash', lastMessage: '\n## **DONE** Tests pass\n\nMore text', error: 'Overloaded' };
  assert.deepStrictEqual(v.toastFor('needs', row), { title: 'shop · checkout needs you', body: 'Claude needs your permission to use Bash' });
  assert.deepStrictEqual(v.toastFor('done', row), { title: 'shop · checkout finished', body: 'DONE Tests pass' });
  assert.deepStrictEqual(v.toastFor('error', row, 'api'), { title: 'shop · api failed', body: 'Overloaded' });
  assert.strictEqual(v.toastFor('done', { pid: 7, cwd: 'C:\\work\\site' }).body, 'Turn finished');
  assert.strictEqual(v.toastFor('done', { pid: 7, cwd: 'C:\\work\\site' }).title, 'site finished');
});

test('plainLine takes the first line that has text and strips Markdown', () => {
  assert.strictEqual(v.plainLine('- `a.js` **changed**'), 'a.js changed');
  assert.strictEqual(v.plainLine('1. step one\n2. two'), 'step one');
  assert.strictEqual(v.plainLine('\n\n'), '');
  assert.strictEqual(v.plainLine(undefined), '');
});

test('do not disturb runs 30 minutes, 1 hour or to the next 8:00', () => {
  const now = local(14, 0);
  assert.strictEqual(v.dndUntil('30m', now), now + 30 * 60000);
  assert.strictEqual(v.dndUntil('1h', now), now + 60 * 60000);
  assert.strictEqual(v.dndUntil('morning', now), new Date(2026, 9, 20, 8, 0).getTime());
  assert.strictEqual(v.morningLabel(now), 'Until tomorrow 08:00');
  assert.strictEqual(v.dndUntil('morning', local(6, 0)), local(8, 0));
  assert.strictEqual(v.morningLabel(local(6, 0)), 'Until 08:00');
  assert.strictEqual(v.dndUntil('morning', local(8, 0)), new Date(2026, 9, 20, 8, 0).getTime());
  assert.strictEqual(v.dndUntil('off', now), 0);
});
