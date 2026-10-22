'use strict';
const os = require('os');
const path = require('path');

const home = os.homedir();

// Everything lives in one folder, where reporter/report.js looks for it.
const dataDir = path.join(home, 'Library', 'Application Support', 'ClaudeSessions');
const claudeDir = path.join(home, '.claude');

module.exports = {
  dataDir,
  serverFile: path.join(dataDir, 'server.json'),
  spoolFile: path.join(dataDir, 'spool.jsonl'),
  stateFile: path.join(dataDir, 'state.json'),
  reporterDir: path.join(dataDir, 'reporter'),
  configDir: dataDir,
  configFile: path.join(dataDir, 'config.json'),
  soundsDir: path.join(dataDir, 'sounds'),
  systemSoundsCache: path.join(dataDir, 'system-sounds'),
  stashFile: path.join(dataDir, 'stashed-hooks.json'),
  claudeDir,
  settingsFile: path.join(claudeDir, 'settings.json'),
  sessionsDir: path.join(claudeDir, 'sessions'),
  systemSoundsDir: '/System/Library/Sounds',
};
