// Sound catalog and per-session assignment. Everything here is pure except
// buildCatalog and addCustomSound, which read and copy files.
//
// A sound id names its source: synth:<name> (made in the player window),
// mac:<file> (/System/Library/Sounds, played from a .wav copy) and
// custom:<file> (sounds added from the popup, kept in the data folder).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BUILT_IN = [
  { id: 'synth:marimba', label: 'Marimba' },
  { id: 'synth:bell', label: 'Bell' },
  { id: 'synth:wood', label: 'Wood' },
  { id: 'synth:blip', label: 'Blip' },
  { id: 'synth:chirp', label: 'Chirp' },
  { id: 'synth:pluck', label: 'Pluck' },
  { id: 'synth:glass', label: 'Glass' },
  { id: 'synth:horn', label: 'Low horn' },
].map((s) => ({ ...s, group: 'Built-in' }));

/** New projects take their sound from here, in this order. */
const POOL = BUILT_IN.map((s) => s.id);
const GROUPS = ['Built-in', 'macOS', 'Custom'];
const CUSTOM_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aiff', '.aif']);
const AIFF = /\.aiff?$/i; // Chromium does not decode AIFF, so these play from a .wav copy
const MAP_MAX = 300; // per-session maps keep the newest entries

function listDir(dir, keep) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(keep).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

const stem = (name) => name.slice(0, name.length - path.extname(name).length);

/** Converts an AIFF file to 16-bit WAV with afconvert, which ships with macOS. */
function toWav(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', src, dest], { timeout: 10000 });
}

/**
 * Every sound on this machine, grouped as GROUPS lists them. System sounds
 * play from WAV copies in `cacheDir`, made on first use; `convert` is the
 * converter, replaceable in tests.
 */
function buildCatalog({ systemDir, cacheDir, customDir, convert = toWav } = {}) {
  const out = [...BUILT_IN];
  if (systemDir && cacheDir) {
    for (const f of listDir(systemDir, (n) => AIFF.test(n))) {
      const file = path.join(cacheDir, `${stem(f)}.wav`);
      if (!fs.existsSync(file)) {
        try { convert(path.join(systemDir, f), file); } catch { continue; }
      }
      out.push({ id: `mac:${f}`, label: stem(f), group: 'macOS', file });
    }
  }
  if (customDir) {
    for (const f of listDir(customDir, (n) => CUSTOM_EXT.has(path.extname(n).toLowerCase()))) {
      out.push({ id: `custom:${f}`, label: stem(f), group: 'Custom', file: path.join(customDir, f) });
    }
  }
  return out;
}

function findSound(catalog, id) {
  return id ? catalog.find((s) => s.id === id) : undefined;
}

function soundLabel(catalog, id) {
  const s = findSound(catalog, id);
  return s ? s.label : 'No sound';
}

/** Sounds by group, without file paths, for the popup's picker. */
function pickerGroups(catalog) {
  return GROUPS.map((name) => ({ name, sounds: catalog.filter((s) => s.group === name).map(({ id, label }) => ({ id, label })) }))
    .filter((g) => g.sounds.length);
}

/** Sounds stick to the project, so every session of one repo sounds alike. */
function projectKey(row) {
  return row && row.project ? String(row.project).toLowerCase() : '';
}

/** The pool sound fewest projects use, earliest in the pool on a tie. */
function nextUnused(projectSounds, pool = POOL) {
  const uses = new Map(pool.map((id) => [id, 0]));
  for (const id of Object.values(projectSounds || {})) if (uses.has(id)) uses.set(id, uses.get(id) + 1);
  let best = pool[0];
  for (const id of pool) if (uses.get(id) < uses.get(best)) best = id;
  return best;
}

/**
 * The sound a row plays. A per-session choice wins, then the project's. A
 * project with no sound, or one whose file is gone, gets the next unused one;
 * `assign` tells the caller to save it. A row whose project is not known yet
 * borrows that sound without keeping it.
 */
function resolveSound(config, row, catalog = BUILT_IN) {
  const has = (id) => !!findSound(catalog, id);
  const own = row.sessionId && config.sessionSounds ? config.sessionSounds[row.sessionId] : undefined;
  if (has(own)) return { id: own, from: 'session' };
  const key = projectKey(row);
  const projectSounds = config.projectSounds || {};
  if (key && has(projectSounds[key])) return { id: projectSounds[key], from: 'project' };
  const others = { ...projectSounds };
  delete others[key];
  const id = nextUnused(others);
  return key ? { id, from: 'project', assign: { project: key, id } } : { id, from: 'default' };
}

/**
 * projectSounds with a sound for every row's project, or null when nothing
 * changed. A session's own choice does not stop its project getting one.
 */
function assignProjects(config, rows, catalog = BUILT_IN) {
  let projectSounds = null;
  for (const row of rows) {
    const r = resolveSound({ projectSounds: projectSounds || config.projectSounds }, row, catalog);
    if (!r.assign) continue;
    projectSounds = { ...(projectSounds || config.projectSounds || {}), [r.assign.project]: r.assign.id };
  }
  return projectSounds;
}

/** How an alert plays: done once, needs you twice so you can tell them apart. */
function playPattern(kind) {
  return { repeats: kind === 'needs' ? 2 : 1, gap: 0.18 };
}

/**
 * Sets (or with undefined, deletes) one key and moves it to the end, keeping
 * the newest `max` keys. Session ids are not integer-like, so object order is
 * insertion order.
 */
function setCapped(map, key, value, max = MAP_MAX) {
  const out = { ...(map || {}) };
  delete out[key];
  if (value !== undefined && value !== null && value !== '' && value !== false) out[key] = value;
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete out[k];
  return out;
}

/**
 * Copies a sound file into customDir and returns its id; a clash gets " (2)".
 * An AIFF file is stored as WAV.
 */
function addCustomSound(src, customDir, { convert = toWav } = {}) {
  let ext = path.extname(src).toLowerCase();
  if (!CUSTOM_EXT.has(ext)) throw new Error(`Not a .wav, .mp3, .ogg, .m4a or .aiff file: ${path.basename(src)}`);
  fs.mkdirSync(customDir, { recursive: true });
  const aiff = AIFF.test(ext);
  if (aiff) ext = '.wav';
  const base = stem(path.basename(src));
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(customDir, name)); i++) name = `${base} (${i})${ext}`;
  if (aiff) convert(src, path.join(customDir, name));
  else fs.copyFileSync(src, path.join(customDir, name));
  return `custom:${name}`;
}

module.exports = {
  BUILT_IN,
  POOL,
  GROUPS,
  MAP_MAX,
  buildCatalog,
  findSound,
  soundLabel,
  pickerGroups,
  projectKey,
  nextUnused,
  resolveSound,
  assignProjects,
  playPattern,
  setCapped,
  addCustomSound,
};
