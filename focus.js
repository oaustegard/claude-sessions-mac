// Brings a session's terminal to the front, and tells a live process from a
// reused PID. The pure parts (parsePs, ancestry, appBundle, chooseApp,
// focusScript, sameStart) are tested; the rest shells out to ps, osascript
// and open, which every Mac has.
'use strict';
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// Processes that host many unrelated programs. The walk up from claude stops
// before them, because they are not the session's terminal.
const STOP_AT = new Set(['launchd', 'kernel_task']);
const MAX_DEPTH = 24;
const SAME_START_MS = 1000; // ps reports start times to the second
const SCRIPT_TIMEOUT_MS = 4000;

// Terminals that can select the tab whose tty is the session's, keyed by the
// bundle's file name. Any other app is brought forward as a whole.
const SCRIPTABLE = {
  'Terminal.app': 'terminal',
  'iTerm.app': 'iterm',
  'iTerm2.app': 'iterm',
};

/** `ps -axo pid=,ppid=,comm=` output to Map pid -> { pid, ppid, name, exe }. */
function parsePs(text) {
  const procs = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const exe = m[3];
    procs.set(pid, { pid, ppid: Number(m[2]), name: path.basename(exe), exe });
  }
  return procs;
}

/**
 * The process and its ancestors, nearest first. `procs` maps pid to
 * { pid, ppid, name }; `createdOf(pid)` returns a start time in ms or null.
 * Stops at a host process, a missing parent, or a parent that started after
 * its child (the parent died and its PID was reused).
 */
function ancestry(pid, procs, createdOf = () => null) {
  const chain = [];
  let cur = procs.get(pid);
  let curCreated = cur ? createdOf(cur.pid) : null;
  while (cur && chain.length < MAX_DEPTH) {
    if (STOP_AT.has(String(cur.name))) break;
    chain.push(cur);
    const parent = cur.ppid && cur.ppid !== cur.pid ? procs.get(cur.ppid) : undefined;
    if (!parent || chain.some((p) => p.pid === parent.pid)) break;
    const parentCreated = createdOf(parent.pid);
    if (parentCreated != null && curCreated != null && parentCreated > curCreated + SAME_START_MS) break;
    cur = parent;
    curCreated = parentCreated;
  }
  return chain;
}

/** The outermost .app bundle an executable lives in, or null. */
function appBundle(exe) {
  const s = String(exe || '');
  const i = s.indexOf('.app/');
  return i < 0 ? null : s.slice(0, i + 4);
}

/**
 * The app to bring forward: the nearest ancestor that lives in an .app
 * bundle. The claude process itself is skipped, since Claude Code's own
 * binary may ship inside one. Returns { app, kind, via } or null.
 */
function chooseApp(chain) {
  for (const proc of chain.slice(1)) {
    const app = appBundle(proc.exe);
    if (!app) continue;
    return { app, kind: SCRIPTABLE[path.basename(app)] || 'app', via: proc.name };
  }
  return null;
}

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * AppleScript that selects the tab whose tty is `tty` and raises its window.
 * It returns "ok" when it found the tab and "none" when not. Null for apps
 * that have no such script.
 */
function focusScript(kind, tty) {
  if (!/^ttys?\d+$/.test(String(tty))) return null;
  const dev = quote(`/dev/${tty}`);
  if (kind === 'terminal') {
    return [
      'tell application id "com.apple.Terminal"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      `      if tty of t is ${dev} then`,
      '        set selected of t to true',
      '        set index of w to 1',
      '        activate',
      '        return "ok"',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return "none"',
    ].join('\n');
  }
  if (kind === 'iterm') {
    return [
      'tell application id "com.googlecode.iterm2"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      `        if tty of s is ${dev} then`,
      '          select w',
      '          select t',
      '          select s',
      '          activate',
      '          return "ok"',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return "none"',
    ].join('\n');
  }
  return null;
}

/**
 * The claude:// link that opens a Claude Desktop Code session in the app, or
 * null for any other session. Claude Desktop's dock menu builds the same link.
 */
function desktopLink(row) {
  if (!row || row.entrypoint !== 'claude-desktop') return null;
  if (!/^local_[A-Za-z0-9-]{1,100}$/.test(String(row.hostSessionId))) return null;
  return `claude://code/continue?session=${row.hostSessionId}`;
}

/** ps's lstart text read in UTC ("Thu Oct 22 02:08:34 2026") to ms, or null. */
function parseLstart(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const ms = Date.parse(`${t} GMT`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the process that started at `createdMs` is the one the registry
 * saw start. Claude Code writes procStart as ps's lstart in UTC.
 */
function sameStart(procStart, createdMs) {
  if (procStart == null || createdMs == null) return true; // nothing to compare
  const want = parseLstart(procStart);
  if (want == null) return true;
  return Math.abs(want - createdMs) <= SAME_START_MS;
}

/** The answer for the log, in words. */
function describeTab(tab) {
  if (!tab) return '';
  if (!tab.ok) return `tab not switched: ${tab.reason || 'no reason given'}`;
  return tab.link ? `opened ${tab.link}` : `tab on ${tab.tty}`;
}

// ---------------------------------------------------------------- shell

const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };

function ps(args) {
  try {
    return execFileSync('/bin/ps', args, { encoding: 'utf8', env: PS_ENV, timeout: 3000 });
  } catch (e) {
    return typeof e.stdout === 'string' ? e.stdout : ''; // ps exits 1 when a pid is gone
  }
}

/** ps, open and osascript are always there; kept so main.js can log it. */
function nativeStatus() {
  return { ok: true };
}

/** Every process: Map pid -> { pid, ppid, name, exe }. */
function snapshot() {
  return parsePs(ps(['-axo', 'pid=,ppid=,comm=']));
}

/** The process's start time in ms, or null when it is gone. */
function createdAt(pid) {
  return parseLstart(ps(['-o', 'lstart=', '-p', String(pid)]));
}

/** The process's controlling terminal, e.g. "ttys003", or null. */
function ttyOf(pid) {
  const t = ps(['-o', 'tty=', '-p', String(pid)]).trim();
  return t && t !== '??' ? t : null;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: SCRIPT_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || err.message).trim() : '' });
    });
  });
}

/**
 * Brings the row's terminal to the front and, in Terminal and iTerm2, selects
 * its tab. Resolves to what happened, for the log: { ok, reason?, via?, title?, tab? }.
 * `ok` is about the app: when only the tab could not be selected, the app
 * still comes forward, and `tab` says why.
 */
async function focusSession(row) {
  if (!row || !row.pid) return { ok: false, reason: 'no process' };
  const procs = snapshot();
  if (!procs.has(row.pid)) return { ok: false, reason: 'process gone' };
  const chain = ancestry(row.pid, procs, createdAt);
  const pick = chooseApp(chain);
  if (!pick) return { ok: false, reason: `no window (${chain.map((p) => p.name).join(' < ') || 'no chain'})` };
  const title = path.basename(pick.app, '.app');
  const link = desktopLink(row);
  if (link) {
    // Opens the app on that session; open -a below would show whichever was last.
    const r = await run('/usr/bin/open', [link]);
    if (r.ok) return { ok: true, via: pick.via, title, tab: { ok: true, link } };
  }
  const tty = ttyOf(row.pid);
  const script = tty && focusScript(pick.kind, tty);
  let tab;
  if (script) {
    const r = await run('/usr/bin/osascript', ['-e', script]);
    if (r.ok && r.out === 'ok') return { ok: true, via: pick.via, title, tab: { ok: true, tty } };
    tab = { ok: false, reason: r.ok ? `no tab on ${tty}` : r.err };
  }
  // open -a needs no Automation permission and works for every app.
  const r = await run('/usr/bin/open', ['-a', pick.app]);
  return { ok: r.ok, reason: r.ok ? undefined : `open failed: ${r.err}`, via: pick.via, title, tab };
}

module.exports = {
  parsePs, ancestry, appBundle, chooseApp, focusScript, desktopLink, parseLstart, sameStart, describeTab,
  nativeStatus, snapshot, createdAt, ttyOf, focusSession,
};
