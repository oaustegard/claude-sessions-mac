// Reads Claude Code's per-process session files, ~/.claude/sessions/<pid>.json.
// The format is undocumented, so every field is optional and a file that does
// not parse is skipped. The <pid>.<hash>.key sidecars in the same folder are
// never opened.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_RE = /^(\d+)\.json$/;
const RESCAN_MS = 5000;
const DEBOUNCE_MS = 150;

const str = (v) => (typeof v === 'string' && v ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One registry file's text to a normalized entry, or null when it is unusable. */
function parseEntry(text, filePid) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const pid = Number.isInteger(o.pid) ? o.pid : filePid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const status = ['idle', 'busy', 'waiting'].includes(o.status) ? o.status : undefined;
  return {
    pid,
    sessionId: str(o.sessionId),
    cwd: str(o.cwd),
    startedAt: num(o.startedAt),
    procStart: o.procStart !== undefined ? String(o.procStart) : undefined,
    version: str(o.version),
    kind: str(o.kind),
    entrypoint: str(o.entrypoint),
    name: str(o.name),
    nameSource: str(o.nameSource),
    status,
    statusUpdatedAt: num(o.statusUpdatedAt) || num(o.updatedAt),
  };
}

/**
 * Reads the folder once. `present` lists every <pid>.json seen, including
 * files that did not parse (mid-write), so a half-written file does not look
 * like an ended session. `ok` is false when the folder itself could not be read.
 */
function readSnapshot(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    return { ok: e.code === 'ENOENT', entries: [], present: [] };
  }
  const entries = [];
  const present = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const filePid = Number(m[1]);
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; } // deleted mid-read
    present.push(filePid);
    const entry = parseEntry(text, filePid);
    if (entry) entries.push(entry);
  }
  return { ok: true, entries, present };
}

/** Calls onSnapshot after every change to the folder and every 5 s. */
function watchRegistry(dir, onSnapshot, { rescanMs = RESCAN_MS } = {}) {
  let timer = null;
  let watcher = null;
  const scan = () => {
    timer = null;
    try { onSnapshot(readSnapshot(dir)); } catch (e) { console.error('registry scan failed:', e); }
  };
  const soon = () => { if (!timer) timer = setTimeout(scan, DEBOUNCE_MS); };
  const startWatch = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (!name || FILE_RE.test(String(name))) soon();
      });
      watcher.on('error', () => { try { watcher.close(); } catch { /* already closed */ } watcher = null; });
    } catch { watcher = null; } // folder missing; the rescan retries
  };
  startWatch();
  const interval = setInterval(() => { startWatch(); scan(); }, rescanMs);
  scan();
  return {
    rescan: soon,
    close() {
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    },
  };
}

module.exports = { parseEntry, readSnapshot, watchRegistry };
