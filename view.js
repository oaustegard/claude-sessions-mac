// Words the tray shows: the tooltip, the menu's lines and the toasts. Pure,
// so main.js stays wiring and the text is testable.
'use strict';
const { rowLabel, stateLine } = require('./state');

const TOOLTIP_MAX = 127; // a tooltip longer than this is clipped
const MENU_MAX = 90;
const MORNING_HOUR = 8;
const VERB = { needs: 'needs you', done: 'finished', error: 'failed' };

function clip(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "1 needs you, 2 done, 1 working" for the live sessions in a summary. */
function countsText(summary) {
  const c = (summary && summary.counts) || {};
  const parts = [];
  if (c.needs) parts.push(`${c.needs} ${c.needs === 1 ? 'needs' : 'need'} you`);
  if (c.error) parts.push(`${c.error} failed`);
  if (c.done) parts.push(`${c.done} done`);
  if (c.working) parts.push(`${c.working} working`);
  if (c.idle) parts.push(`${c.idle} idle`);
  return parts.join(', ');
}

function headerText(summary) {
  if (!summary || !summary.total) return 'No Claude Code sessions';
  return `${summary.total} session${summary.total === 1 ? '' : 's'}: ${countsText(summary)}`;
}

function tooltip(summary, { hooksInstalled = true, dndUntil = 0, now = Date.now() } = {}) {
  let text;
  if (!hooksInstalled) text = 'hooks not installed';
  else if (!summary || !summary.total) text = 'no sessions';
  else text = countsText(summary);
  if (dndUntil > now) text += ` (quiet until ${hhmm(dndUntil)})`;
  return clip(`Claude Sessions: ${text}`, TOOLTIP_MAX);
}

/** Menu text as shown. macOS menus have no "&" shortcut marker to escape. */
function menuText(s) {
  return s;
}

function menuLabel(row, alias, now) {
  const { where, name } = rowLabel(row, alias);
  const head = name ? `${where}: ${clip(name, 32)}` : where;
  return menuText(clip(`${head}  ·  ${stateLine(row, now)}`, MENU_MAX));
}

/** The first line of a Markdown reply with its markup taken off. */
function plainLine(text) {
  if (!text) return '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, '').trim();
    if (line) return line;
  }
  return '';
}

function toastFor(kind, row, alias) {
  const { where, name } = rowLabel(row, alias);
  let detail;
  if (kind === 'needs') detail = row.needsReason || 'Claude needs you';
  else if (kind === 'error') detail = row.error || 'The turn ended with an error';
  else detail = plainLine(row.lastMessage) || 'Turn finished';
  return {
    title: clip(`${where} ${VERB[kind] || kind}`, 64),
    body: name ? `${clip(name, 60)}\n${clip(detail, 160)}` : clip(detail, 200),
  };
}

/** The next 8:00 after `now`, local time. */
function nextMorning(now) {
  const d = new Date(now);
  d.setHours(MORNING_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function morningLabel(now) {
  const t = nextMorning(now);
  const sameDay = new Date(t).getDate() === new Date(now).getDate();
  return `Until ${sameDay ? '' : 'tomorrow '}${hhmm(t)}`;
}

function dndUntil(choice, now) {
  if (choice === '30m') return now + 30 * 60 * 1000;
  if (choice === '1h') return now + 60 * 60 * 1000;
  if (choice === 'morning') return nextMorning(now);
  return 0;
}

module.exports = { TOOLTIP_MAX, clip, hhmm, countsText, headerText, tooltip, menuText, menuLabel, plainLine, toastFor, nextMorning, morningLabel, dndUntil };
