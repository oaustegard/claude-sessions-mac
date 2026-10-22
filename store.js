// Files the tray keeps: state.json (sessions from the last day), config.json
// (choices the user made), server.json (where the reporter posts) and the
// spool the reporter writes while the tray is down. Every write goes to a
// temp file first and is renamed into place, so a crash never leaves half a
// file behind.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = { showAll: false, dndUntil: 0, volume: 0.8, aliases: {}, projectSounds: {}, sessionSounds: {}, muted: {} };
const RENAME_TRIES = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Renames with a few retries, in case another process holds the file for a moment. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= RENAME_TRIES - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(30 * (i + 1));
    }
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { renameRetry(tmp, file); } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function loadConfig(file) {
  const c = obj(readJson(file));
  return {
    showAll: c.showAll === true,
    dndUntil: Number.isFinite(c.dndUntil) ? c.dndUntil : 0,
    volume: Number.isFinite(c.volume) ? Math.min(1, Math.max(0, c.volume)) : DEFAULT_CONFIG.volume,
    aliases: obj(c.aliases),
    projectSounds: obj(c.projectSounds),
    sessionSounds: obj(c.sessionSounds),
    muted: obj(c.muted),
  };
}

function saveConfig(file, config) {
  writeAtomic(file, JSON.stringify(config, null, 2));
}

function loadState(file) {
  const s = readJson(file);
  return s && typeof s.sessions === 'object' && s.sessions ? s.sessions : {};
}

/** Saves at most once per `delayMs`; flush() writes the pending state now. */
function stateSaver(file, delayMs = 1000) {
  let pending = null;
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const sessions = pending;
    pending = null;
    try { writeAtomic(file, JSON.stringify({ v: 1, savedAt: Date.now(), sessions })); } catch (e) { console.error('state save failed:', e.message); }
  };
  return {
    save(sessions) {
      pending = sessions;
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

function writeServerFile(file, info) {
  writeAtomic(file, JSON.stringify(info));
}

/** Removes server.json only if it is still ours: a second tray may have taken over. */
function removeServerFile(file, token) {
  const s = readJson(file);
  if (s && s.token === token) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}

/**
 * Takes every event the reporter spooled, oldest first. The live spool is
 * renamed before reading, so a reporter that appends meanwhile starts a new
 * file instead of losing its line. Leftovers from a drain that crashed are
 * picked up too.
 */
function drainSpool(spoolFile) {
  const dir = path.dirname(spoolFile);
  const base = path.basename(spoolFile, '.jsonl');
  if (fs.existsSync(spoolFile)) {
    try { renameRetry(spoolFile, path.join(dir, `${base}.${Date.now()}.jsonl`)); } catch (e) { console.error('spool rename failed:', e.message); }
  }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const re = new RegExp(`^${base}\\.\\d+\\.jsonl$`);
  const events = [];
  for (const name of names.filter((n) => re.test(n))) {
    const file = path.join(dir, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && Number.isInteger(ev.pid) && typeof ev.event === 'string') events.push(ev);
      } catch { /* a line cut off when the disk filled */ }
    }
    try { fs.unlinkSync(file); } catch { /* retried at the next drain */ }
  }
  return events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

module.exports = { DEFAULT_CONFIG, writeAtomic, loadConfig, saveConfig, loadState, stateSaver, writeServerFile, removeServerFile, drainSpool };
