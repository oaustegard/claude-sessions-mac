'use strict';
const test = require('node:test');
const assert = require('node:assert');
const f = require('../focus');

const PS = `
    1     0 /sbin/launchd
  600     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  610   600 login
  620   610 -zsh
  630   620 /opt/homebrew/bin/claude
  700     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  710   700 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  720   710 /bin/zsh
  730   720 /Users/me/Library/Application Support/Claude/claude-code/2.1.304/x/claude.app/Contents/MacOS/claude
  800     1 /usr/sbin/sshd
  810   800 /opt/homebrew/bin/node
  820   810 /opt/homebrew/bin/claude
`;

test('parsePs keeps the full path, and names with spaces', () => {
  const procs = f.parsePs(PS);
  assert.strictEqual(procs.size, 12);
  assert.deepStrictEqual(procs.get(620), { pid: 620, ppid: 610, name: '-zsh', exe: '-zsh' });
  assert.strictEqual(procs.get(710).name, 'Code Helper (Plugin)');
  assert.strictEqual(f.parsePs('').size, 0);
});

test('ancestry walks up to the terminal and stops before launchd', () => {
  const chain = f.ancestry(630, f.parsePs(PS));
  assert.deepStrictEqual(chain.map((p) => p.pid), [630, 620, 610, 600]);
});

test('ancestry stops at a parent that started after its child, which is a reused PID', () => {
  const created = { 630: 1000, 620: 900, 610: 50000, 600: 10 };
  const chain = f.ancestry(630, f.parsePs(PS), (pid) => created[pid] ?? null);
  assert.deepStrictEqual(chain.map((p) => p.pid), [630, 620]);
  // A second of slack: ps reports start times to the second.
  const close = { 630: 1000, 620: 1900 };
  assert.deepStrictEqual(f.ancestry(630, f.parsePs(PS), (pid) => close[pid] ?? null).map((p) => p.pid), [630, 620, 610, 600]);
});

test('appBundle takes the outermost .app', () => {
  assert.strictEqual(f.appBundle('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/x'), '/Applications/Visual Studio Code.app');
  assert.strictEqual(f.appBundle('/opt/homebrew/bin/claude'), null);
  assert.strictEqual(f.appBundle(undefined), null);
});

test('chooseApp picks the nearest app above claude, and knows the scriptable terminals', () => {
  const procs = f.parsePs(PS);
  assert.deepStrictEqual(f.chooseApp(f.ancestry(630, procs)), { app: '/System/Applications/Utilities/Terminal.app', kind: 'terminal', via: 'Terminal' });
  // Claude Code's own binary lives in claude.app, which is not the terminal.
  assert.deepStrictEqual(f.chooseApp(f.ancestry(730, procs)), { app: '/Applications/Visual Studio Code.app', kind: 'app', via: 'Code Helper (Plugin)' });
  // Over ssh there is no app on this Mac to bring forward.
  assert.strictEqual(f.chooseApp(f.ancestry(820, procs)), null);
  const iterm = [{ exe: 'claude' }, { exe: '/Applications/iTerm.app/Contents/MacOS/iTerm2', name: 'iTerm2' }];
  assert.strictEqual(f.chooseApp(iterm).kind, 'iterm');
});

test('focusScript matches the tab by tty and refuses anything that is not a tty name', () => {
  const t = f.focusScript('terminal', 'ttys003');
  assert.match(t, /tty of t is "\/dev\/ttys003"/);
  assert.match(t, /com\.apple\.Terminal/);
  assert.match(f.focusScript('iterm', 'ttys012'), /tty of s is "\/dev\/ttys012"/);
  assert.strictEqual(f.focusScript('app', 'ttys003'), null);
  assert.strictEqual(f.focusScript('terminal', 'ttys003" then do shell script "x'), null);
  assert.strictEqual(f.focusScript('terminal', null), null);
});

test('parseLstart reads ps start times in UTC', () => {
  assert.strictEqual(f.parseLstart('Thu Oct 22 02:08:34 2026'), Date.UTC(2026, 9, 22, 2, 8, 34));
  assert.strictEqual(f.parseLstart('Mon Feb  2 09:01:05 2026  '), Date.UTC(2026, 1, 2, 9, 1, 5));
  assert.strictEqual(f.parseLstart(''), null);
  assert.strictEqual(f.parseLstart('not a date'), null);
});

test('sameStart allows a second of slack and passes when there is nothing to compare', () => {
  const at = Date.UTC(2026, 9, 22, 2, 8, 34);
  assert.strictEqual(f.sameStart('Thu Oct 22 02:08:34 2026', at + 999), true);
  assert.strictEqual(f.sameStart('Thu Oct 22 02:08:34 2026', at + 5000), false);
  assert.strictEqual(f.sameStart(undefined, at), true);
  assert.strictEqual(f.sameStart('Thu Oct 22 02:08:34 2026', null), true);
  assert.strictEqual(f.sameStart('garbage', at), true);
});

test('desktopLink opens a Claude Desktop session by its id, and nothing else', () => {
  const row = { pid: 1, entrypoint: 'claude-desktop', hostSessionId: 'local_f8746d1a-0ad8-4ffa-8bda-9fd7ca8189ab' };
  assert.strictEqual(f.desktopLink(row), 'claude://code/continue?session=local_f8746d1a-0ad8-4ffa-8bda-9fd7ca8189ab');
  assert.strictEqual(f.desktopLink({ ...row, entrypoint: 'cli' }), null);
  assert.strictEqual(f.desktopLink({ ...row, hostSessionId: undefined }), null);
  assert.strictEqual(f.desktopLink({ ...row, hostSessionId: 'local_a&b' }), null);
  assert.strictEqual(f.desktopLink(null), null);
});

test('describeTab words the answer for the log', () => {
  assert.strictEqual(f.describeTab(undefined), '');
  assert.strictEqual(f.describeTab({ ok: true, tty: 'ttys003' }), 'tab on ttys003');
  assert.strictEqual(f.describeTab({ ok: true, link: 'claude://code/continue?session=local_1' }), 'opened claude://code/continue?session=local_1');
  assert.strictEqual(f.describeTab({ ok: false, reason: 'no tab on ttys003' }), 'tab not switched: no tab on ttys003');
});

test('this process has a start time and shows in the snapshot', { skip: process.platform !== 'darwin' }, () => {
  const procs = f.snapshot();
  assert.ok(procs.has(process.pid));
  const at = f.createdAt(process.pid);
  assert.ok(at && Math.abs(Date.now() - at) < 10 * 60 * 1000);
  assert.strictEqual(f.createdAt(999999), null);
});
