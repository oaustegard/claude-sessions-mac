// Adds and removes the tray's hooks in ~/.claude/settings.json. Every
// session on this machine reads that file, so: back it up first, refuse to
// write when it does not parse, touch only entries whose path contains the
// reporter marker, and write it atomically. Every other hook stays as it is.
//
// Version 0.1.0 also moved one Stop hook aside into stashed-hooks.json while
// the tray's hooks were in. Nothing is moved aside now, but removing the
// tray's hooks still puts back whatever that version stashed.
//
// CLI: node hooks-install.js install|uninstall|status
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const { writeAtomic } = require('./store');

const MARKER = 'claudesessions/reporter/report.js';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const HOOK_TIMEOUT_S = 10;

const clone = (o) => JSON.parse(JSON.stringify(o));
const hookText = (h) => [h && h.command, ...((h && Array.isArray(h.args)) ? h.args : [])].filter((x) => typeof x === 'string').join(' ');
const isOurs = (h) => hookText(h).replace(/\\/g, '/').toLowerCase().includes(MARKER);

/** Removes hooks matching `pred` from every event; returns the removed ones with where they were. */
function removeHooks(hooks, pred) {
  const removed = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const stay = group.hooks.filter((h) => {
        if (!pred(h)) return true;
        removed.push({ event, matcher: group.matcher, hook: h });
        return false;
      });
      if (stay.length) kept.push({ ...group, hooks: stay });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

function ourGroup(node, script) {
  return { hooks: [{ type: 'command', command: node, args: [script], async: true, timeout: HOOK_TIMEOUT_S }] };
}

/** Pure: settings with the tray's hooks added, replacing any older copy. */
function applyInstall(settings, { node, script }) {
  const out = clone(settings || {});
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  removeHooks(hooks, isOurs);
  for (const event of EVENTS) {
    hooks[event] = [...(hooks[event] || []), ourGroup(node, script)];
  }
  out.hooks = hooks;
  return out;
}

/** Pure: settings with the tray's hooks removed and any hooks 0.1.0 stashed put back where they were. */
function applyUninstall(settings, stashed = []) {
  const out = clone(settings || {});
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  const removed = removeHooks(hooks, isOurs);
  let restored = 0;
  for (const s of [...stashed].reverse()) {
    if (!s || !s.event || !s.hook) continue;
    const groups = hooks[s.event] || [];
    const text = hookText(s.hook);
    if (groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => hookText(h) === text))) continue;
    const group = s.matcher !== undefined ? { matcher: s.matcher, hooks: [s.hook] } : { hooks: [s.hook] };
    hooks[s.event] = [group, ...groups];
    restored++;
  }
  if (out.hooks || Object.keys(hooks).length) out.hooks = hooks;
  return { settings: out, removed: removed.length, restored };
}

function hookStatus(settings) {
  const hooks = (settings && settings.hooks) || {};
  const present = EVENTS.filter((ev) => (hooks[ev] || []).some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)));
  return { installed: present.length === EVENTS.length, partial: present.length > 0 && present.length < EVENTS.length, events: present };
}

// ---------------------------------------------------------------- disk

// An app started from the Dock or at login gets launchd's bare PATH, not the
// one your shell builds, so the usual install spots are tried before asking
// a login shell.
const NODE_SPOTS = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];

function findNode({ spots = NODE_SPOTS, exists = fs.existsSync, shell = loginShellNode } = {}) {
  for (const p of spots) if (exists(p)) return p;
  const found = shell();
  return found && exists(found) ? found : null;
}

function loginShellNode() {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v node'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop() || null;
  } catch { return null; }
}

/** Reads settings.json; a missing file is {}, a file that does not parse throws so nothing gets written. */
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { text: null, settings: {} };
    throw e;
  }
  let settings;
  try { settings = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) {
    throw new Error(`${file} does not parse (${e.message}); not touching it`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${file} is not a JSON object; not touching it`);
  return { text, settings };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/** Writes settings unless the file changed under us since `before` was read. */
function writeSettings(file, before, settings) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (now !== before) throw new Error(`${file} changed while installing; try again`);
  if (before !== null) fs.copyFileSync(file, `${file}.bak-claudesessions-${stamp()}`);
  const eol = before && before.includes('\r\n') ? '\r\n' : '\n';
  writeAtomic(file, JSON.stringify(settings, null, 2).replace(/\n/g, eol) + eol);
}

/** Hooks a 0.1.0 install moved aside; none when there is no stash file. */
function readStash(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(s.hooks) ? s.hooks : [];
  } catch { return []; }
}

function install(opts = {}) {
  const settingsFile = opts.settingsFile || paths.settingsFile;
  const reporterDir = opts.reporterDir || paths.reporterDir;
  const node = opts.node || findNode();
  if (!node) throw new Error('node not found; install Node.js (for example with Homebrew) so the hooks can run');
  const script = path.join(reporterDir, 'report.js');
  // Hooks are found again by this path; one without the marker could never be removed.
  if (!isOurs({ command: script })) throw new Error(`reporter path ${script} does not contain ${MARKER}`);
  fs.mkdirSync(reporterDir, { recursive: true });
  writeAtomic(script, fs.readFileSync(path.join(__dirname, 'reporter', 'report.js')));

  const { text, settings } = readSettings(settingsFile);
  const next = applyInstall(settings, { node, script });
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false, node, script };
  writeSettings(settingsFile, text, next);
  return { changed: true, node, script };
}

function uninstall(opts = {}) {
  const settingsFile = opts.settingsFile || paths.settingsFile;
  const stashFile = opts.stashFile || paths.stashFile;
  const { text, settings } = readSettings(settingsFile);
  const { settings: next, removed, restored } = applyUninstall(settings, readStash(stashFile));
  if (JSON.stringify(next) !== JSON.stringify(settings)) writeSettings(settingsFile, text, next);
  try { fs.unlinkSync(stashFile); } catch { /* none */ }
  return { removed, restored };
}

function status(opts = {}) {
  const settingsFile = opts.settingsFile || paths.settingsFile;
  const { settings } = readSettings(settingsFile);
  return hookStatus(settings);
}

if (require.main === module) {
  const cmd = process.argv[2];
  try {
    const fn = { install, uninstall, status }[cmd];
    if (!fn) { console.error('usage: node hooks-install.js install|uninstall|status'); process.exit(2); }
    console.log(JSON.stringify(fn(), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { MARKER, EVENTS, isOurs, applyInstall, applyUninstall, hookStatus, install, uninstall, status, findNode, readSettings };
