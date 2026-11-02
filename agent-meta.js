// Reads the meta file Claude Code writes for each subagent run. It appears
// a few seconds after the run starts, so a lookup tries again for a while.
'use strict';
const fs = require('fs');
const path = require('path');

const RETRY_MS = [0, 500, 2000, 5000, 10000, 20000];
const MAX_BYTES = 64 * 1024;

/** Only a meta file inside a session's subagents folder is read. */
function isMetaPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const parts = path.normalize(file).split(/[\\/]/);
  return parts.length >= 3 && parts[parts.length - 2] === 'subagents' && /^agent-[\w-]+\.meta\.json$/.test(parts[parts.length - 1]);
}

/** The fields the tray uses, or null when the file is missing, too big or not JSON. */
function readAgentMeta(file) {
  if (!isMetaPath(file)) return null;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object') return null;
    const str = (v) => (typeof v === 'string' && v ? v : undefined);
    return {
      agentType: str(m.agentType),
      description: str(m.description),
      toolUseId: str(m.toolUseId),
      parentAgentId: str(m.parentAgentId),
      spawnDepth: Number.isInteger(m.spawnDepth) ? m.spawnDepth : undefined,
      requestShape: str(m.requestShape),
    };
  } catch {
    return null;
  }
}

/**
 * Calls done(meta) once: with the file's fields as soon as it can be read,
 * or with null after the last try. A second lookup for the same key while
 * one is running is dropped.
 */
function createMetaLookup({ read = readAgentMeta, delays = RETRY_MS, schedule = setTimeout } = {}) {
  const running = new Set();
  return function lookup(key, file, done) {
    if (running.has(key)) return;
    running.add(key);
    let i = 0;
    const attempt = () => {
      const meta = read(file);
      if (meta || i >= delays.length - 1) {
        running.delete(key);
        done(meta);
        return;
      }
      i++;
      schedule(attempt, delays[i] - delays[i - 1]);
    };
    schedule(attempt, delays[0]);
  };
}

module.exports = { readAgentMeta, isMetaPath, createMetaLookup, RETRY_MS };
