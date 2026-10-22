'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hi = require('../hooks-install');

const NODE = '/opt/homebrew/bin/node';
const SCRIPT = '/Users/me/Library/Application Support/ClaudeSessions/reporter/report.js';
const chime = (arg) => ({ type: 'command', command: `powershell -NoProfile -File "C:\\Users\\me\\.claude\\chime.ps1" ${arg}` });
const lockHook = { type: 'command', command: '"C:\\tools\\lock\\python.exe" -m filelock hook', timeout: 30 };

// A settings.json with the kinds of hooks people keep: sound scripts, loggers,
// lock and guard hooks, with and without matchers, command-only and with args.
function realShape() {
  return {
    env: { SOME_FLAG: '1' },
    model: 'opus',
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [chime('start')] }],
      PostToolUse: [{ matcher: 'Read|Bash|PowerShell|Grep|Glob|mcp__.*', hooks: [{ type: 'command', command: 'python', args: ['C:\\tools\\log\\hook_posttool.py'], timeout: 15, statusMessage: 'tool log', async: true }] }],
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'python', args: ['C:\\tools\\log\\hook_posttool.py', '--precompact'], timeout: 15 }] }],
      SessionEnd: [{ hooks: [chime('end')] }, { hooks: [{ type: 'command', command: 'python', args: ['C:\\tools\\log\\receipt.py', '--from-hook'], timeout: 120, async: true }] }],
      Stop: [{ hooks: [chime('turn')] }, { hooks: [lockHook] }],
      PreToolUse: [
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [lockHook] },
        { matcher: 'Skill|Agent|Task|Bash', hooks: [{ type: 'command', command: 'py -3 "C:/tools/guards/route_check.py"', timeout: 10 }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'python', args: ['C:\\tools\\log\\hook_pretool.py'], timeout: 10 }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"C:/Python314/python.exe" "C:/tools/guards/prompt_check.py"', timeout: 10 }] }],
    },
  };
}

/** Every hook in settings that is not the tray's, as "event|matcher|command args". */
function foreign(settings) {
  const out = [];
  for (const [ev, groups] of Object.entries(settings.hooks || {})) {
    for (const g of groups) for (const h of g.hooks) {
      if (!hi.isOurs(h)) out.push(`${ev}|${g.matcher}|${h.command} ${(h.args || []).join(' ')}`);
    }
  }
  return out.sort();
}

test('isOurs matches the reporter path however it is written, and nothing else', () => {
  assert.ok(hi.isOurs({ command: NODE, args: [SCRIPT] }));
  assert.ok(hi.isOurs({ command: `"${NODE}" "C:/x/ClaudeSessions/Reporter/report.js"` }));
  assert.ok(!hi.isOurs(lockHook));
  assert.ok(!hi.isOurs(chime('turn')));
  assert.ok(!hi.isOurs({ command: 'node', args: ['C:\\other\\reporter\\report.js'] }));
});

test('install adds one async hook per event and leaves every other hook alone', () => {
  const before = realShape();
  const settings = hi.applyInstall(before, { node: NODE, script: SCRIPT });
  for (const ev of hi.EVENTS) {
    const ours = settings.hooks[ev].flatMap((g) => g.hooks).filter(hi.isOurs);
    assert.deepStrictEqual(ours, [{ type: 'command', command: NODE, args: [SCRIPT], async: true, timeout: 10 }], ev);
    const group = settings.hooks[ev].find((g) => g.hooks.some(hi.isOurs));
    assert.strictEqual(group.matcher, undefined, `${ev} group has no matcher`);
  }
  assert.deepStrictEqual(foreign(settings), foreign(before), 'the Stop chime and every other hook stay');
  assert.deepStrictEqual(settings.env, before.env);
  assert.strictEqual(settings.model, 'opus');
  assert.deepStrictEqual(before, realShape(), 'input not mutated');
  assert.deepStrictEqual(hi.hookStatus(settings), { installed: true, partial: false, events: hi.EVENTS });
});

test('install is idempotent and replaces an older copy instead of adding a second', () => {
  const once = hi.applyInstall(realShape(), { node: NODE, script: SCRIPT });
  assert.deepStrictEqual(hi.applyInstall(once, { node: NODE, script: SCRIPT }), once);

  const moved = hi.applyInstall(once, { node: 'D:\\node\\node.exe', script: 'D:\\Data\\ClaudeSessions\\reporter\\report.js' });
  for (const ev of hi.EVENTS) {
    const ours = moved.hooks[ev].flatMap((g) => g.hooks).filter(hi.isOurs);
    assert.strictEqual(ours.length, 1, ev);
    assert.strictEqual(ours[0].command, 'D:\\node\\node.exe');
  }
});

test('uninstall gives back the original settings in the same order', () => {
  const back = hi.applyUninstall(hi.applyInstall(realShape(), { node: NODE, script: SCRIPT }));
  assert.deepStrictEqual(back.settings, realShape());
  assert.strictEqual(back.removed, hi.EVENTS.length);
  assert.strictEqual(back.restored, 0);
  assert.strictEqual(JSON.stringify(back.settings), JSON.stringify(realShape()), 'same key and group order');
  assert.deepStrictEqual(hi.hookStatus(back.settings), { installed: false, partial: false, events: [] });
});

test('uninstall puts back a hook that version 0.1.0 stashed, once, matcher and all', () => {
  const installed = hi.applyInstall(realShape(), { node: NODE, script: SCRIPT });
  installed.hooks.Stop = installed.hooks.Stop.filter((g) => !g.hooks.some((h) => h.command === chime('turn').command));
  const back = hi.applyUninstall(installed, [{ event: 'Stop', hook: chime('turn') }]);
  assert.strictEqual(back.restored, 1);
  assert.strictEqual(JSON.stringify(back.settings), JSON.stringify(realShape()), 'chime back in its old place');

  const present = hi.applyUninstall(hi.applyInstall(realShape(), { node: NODE, script: SCRIPT }), [{ event: 'Stop', hook: chime('turn') }]);
  assert.strictEqual(present.restored, 0, 'not added twice when it is already there');
  assert.deepStrictEqual(present.settings, realShape());

  const m = hi.applyUninstall({ hooks: {} }, [{ event: 'Stop', matcher: 'x', hook: chime('turn') }]);
  assert.deepStrictEqual(m.settings.hooks.Stop, [{ matcher: 'x', hooks: [chime('turn')] }]);
});

test('install works on settings with no hooks at all, and uninstall then leaves an empty hooks object', () => {
  const settings = hi.applyInstall({ theme: 'dark' }, { node: NODE, script: SCRIPT });
  assert.deepStrictEqual(Object.keys(settings.hooks), hi.EVENTS);
  assert.deepStrictEqual(hi.applyUninstall(settings).settings, { theme: 'dark', hooks: {} });
});

// ---------------------------------------------------------------- disk

function sandbox(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hooks-'));
  const settingsFile = path.join(dir, 'settings.json');
  if (text !== undefined) fs.writeFileSync(settingsFile, text);
  return {
    dir,
    opts: { settingsFile, stashFile: path.join(dir, 'app', 'stashed-hooks.json'), reporterDir: path.join(dir, 'local', 'ClaudeSessions', 'reporter'), node: NODE },
    backups: () => fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-claudesessions-')),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('install and uninstall on disk: backup, reporter copy, no stash, and the file comes back byte for byte', () => {
  const original = JSON.stringify(realShape(), null, 2) + '\n';
  const sb = sandbox(original);
  const r = hi.install(sb.opts);
  assert.strictEqual(r.changed, true);
  assert.ok(fs.existsSync(path.join(sb.opts.reporterDir, 'report.js')));
  assert.strictEqual(sb.backups().length, 1);
  assert.strictEqual(fs.readFileSync(path.join(sb.dir, sb.backups()[0]), 'utf8'), original);
  const written = fs.readFileSync(sb.opts.settingsFile, 'utf8');
  assert.ok(written.endsWith('}\n') && written.includes('\n  "hooks": {\n'), '2-space indent, trailing newline');
  assert.deepStrictEqual(hi.status(sb.opts), { installed: true, partial: false, events: hi.EVENTS });
  assert.ok(!fs.existsSync(sb.opts.stashFile), 'nothing moved aside');

  const again = hi.install(sb.opts);
  assert.strictEqual(again.changed, false);
  assert.strictEqual(sb.backups().length, 1, 'no backup when nothing changes');

  assert.deepStrictEqual(hi.uninstall(sb.opts), { removed: hi.EVENTS.length, restored: 0 });
  assert.strictEqual(fs.readFileSync(sb.opts.settingsFile, 'utf8'), original);
  assert.deepStrictEqual(fs.readdirSync(sb.dir).filter((n) => n.endsWith('.tmp')), []);
  sb.done();
});

test('a stash left by 0.1.0 survives a reinstall and is put back and deleted on uninstall', () => {
  const original = JSON.stringify(realShape(), null, 2) + '\n';
  const without = realShape();
  without.hooks.Stop = without.hooks.Stop.slice(1);
  const sb = sandbox(JSON.stringify(without, null, 2) + '\n');
  fs.mkdirSync(path.dirname(sb.opts.stashFile), { recursive: true });
  const stash = JSON.stringify({ v: 1, hooks: [{ event: 'Stop', hook: chime('turn') }] });
  fs.writeFileSync(sb.opts.stashFile, stash);

  hi.install(sb.opts);
  assert.strictEqual(fs.readFileSync(sb.opts.stashFile, 'utf8'), stash, 'install leaves the stash alone');

  assert.deepStrictEqual(hi.uninstall(sb.opts), { removed: hi.EVENTS.length, restored: 1 });
  assert.strictEqual(fs.readFileSync(sb.opts.settingsFile, 'utf8'), original);
  assert.ok(!fs.existsSync(sb.opts.stashFile));
  sb.done();
});

test('a settings file that does not parse is never written', () => {
  const sb = sandbox('{ "hooks": { broken');
  assert.throws(() => hi.install(sb.opts), /does not parse/);
  assert.throws(() => hi.uninstall(sb.opts), /does not parse/);
  assert.strictEqual(fs.readFileSync(sb.opts.settingsFile, 'utf8'), '{ "hooks": { broken');
  assert.deepStrictEqual(sb.backups(), []);
  sb.done();

  const arr = sandbox('[]');
  assert.throws(() => hi.install(arr.opts), /not a JSON object/);
  arr.done();
});

test('CRLF files keep CRLF, and a missing settings file is created', () => {
  const crlf = JSON.stringify({ hooks: {} }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  const sb = sandbox(crlf);
  hi.install(sb.opts);
  const text = fs.readFileSync(sb.opts.settingsFile, 'utf8');
  assert.ok(!/[^\r]\n/.test(text), 'every newline is CRLF');
  sb.done();

  const none = sandbox();
  assert.strictEqual(hi.install(none.opts).changed, true);
  assert.deepStrictEqual(hi.status(none.opts).installed, true);
  assert.deepStrictEqual(none.backups(), []);
  none.done();
});

test('install refuses a reporter folder it could not find again', () => {
  const sb = sandbox('{}');
  assert.throws(() => hi.install({ ...sb.opts, reporterDir: path.join(sb.dir, 'elsewhere') }), /does not contain/);
  assert.strictEqual(fs.readFileSync(sb.opts.settingsFile, 'utf8'), '{}');
  sb.done();
});

test('findNode tries the usual install spots, then a login shell', () => {
  const has = (set) => (p) => set.includes(p);
  assert.strictEqual(hi.findNode({ exists: has(['/usr/local/bin/node']), shell: () => null }), '/usr/local/bin/node');
  assert.strictEqual(hi.findNode({ exists: has(['/Users/me/.nvm/node']), shell: () => '/Users/me/.nvm/node' }), '/Users/me/.nvm/node');
  assert.strictEqual(hi.findNode({ exists: has([]), shell: () => '/gone/node' }), null);
});
