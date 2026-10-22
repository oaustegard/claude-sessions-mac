// The data the popup window draws, built from the sessions and the config.
// Pure, like view.js: main.js sends the result to the renderer as is.
'use strict';
const state = require('./state');
const view = require('./view');
const sounds = require('./sounds');

const ENDED_SHOWN = 3; // recently ended sessions listed, dimmed, under the live ones

function rowModel(row, config, catalog, now, dimmed) {
  const alias = (row.sessionId && config.aliases && config.aliases[row.sessionId]) || '';
  const { where, name } = state.rowLabel(row, alias);
  const sound = sounds.resolveSound(config, row, catalog);
  return {
    key: String(row.pid),
    state: row.state,
    where,
    name,
    alias,
    line: state.stateLine(row, now),
    project: row.project || '',
    sound: { id: sound.id, label: sounds.soundLabel(catalog, sound.id), from: sound.from },
    muted: !!(row.sessionId && config.muted && config.muted[row.sessionId]),
    hasSession: !!row.sessionId,
    resume: row.sessionId ? `claude --resume ${row.sessionId}` : '',
    cwd: row.cwd || '',
    dimmed,
    background: state.isBackground(row),
    desktop: row.entrypoint === 'claude-desktop',
  };
}

/**
 * Everything the popup shows: the header, live rows (most urgent first),
 * a few recently ended rows, the sound picker's groups and the volume.
 */
function popupModel({ sessions, config, catalog = sounds.BUILT_IN, now = Date.now(), hooksInstalled = true, openAtLogin = false }) {
  const summary = state.summarize(sessions, config.showAll);
  const ended = Object.values(sessions)
    .filter((r) => r.state === 'ended' && state.isVisible(r, config.showAll))
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, ENDED_SHOWN);
  const dndOn = config.dndUntil > now;
  const volume = Number.isFinite(config.volume) ? Math.min(1, Math.max(0, config.volume)) : 0.8;
  return {
    header: {
      title: summary.total ? `${summary.total} session${summary.total === 1 ? '' : 's'}` : 'No sessions',
      counts: view.countsText(summary),
      top: summary.top,
      dnd: { on: dndOn, until: dndOn ? view.hhmm(config.dndUntil) : '' },
    },
    hooksInstalled,
    showAll: !!config.showAll,
    openAtLogin: !!openAtLogin,
    rows: [
      ...summary.rows.map((r) => rowModel(r, config, catalog, now, false)),
      ...ended.map((r) => rowModel(r, config, catalog, now, true)),
    ],
    groups: sounds.pickerGroups(catalog),
    volume: Math.round(volume * 100),
  };
}

/** What a row's state line says for a moment when its window did not come forward. */
function focusNotice(reason, row) {
  const r = String(reason || '');
  if (r === 'no process' || r === 'process gone') return 'Its process has ended';
  if (r.startsWith('no window')) return row && state.isBackground(row) ? 'It runs in the background, with no window' : "Couldn't find its window";
  return "Couldn't show its window";
}

/** What the popup says for a moment after a preview, from player.js's result code. */
function soundNotice(code) {
  if (code === 'output') return "No sound: the audio output didn't start";
  if (code === 'no-answer') return "No sound: the sound player didn't answer";
  if (code === 'file') return "Couldn't play that sound file";
  if (code === 'volume') return 'Volume is at 0%';
  return "Couldn't play that sound";
}

module.exports = { ENDED_SHOWN, popupModel, focusNotice, soundNotice };
