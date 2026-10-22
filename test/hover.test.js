const test = require('node:test');
const assert = require('node:assert/strict');
const { createHoverTracker, pointIn } = require('../hover');

const icon = { x: 100, y: 100, width: 24, height: 24 };
const card = { x: 0, y: 0, width: 200, height: 80 };
const onIcon = { x: 110, y: 110 };
const onCard = { x: 50, y: 40 };
const away = { x: 500, y: 500 };

const tracker = () => createHoverTracker({ openDelay: 250, closeDelay: 300, activeMs: 80, idleMs: 200 });
const hidden = (t, now, cursor) => t.tick({ now, cursor, icon, visible: false });
const shown = (t, now, cursor) => t.tick({ now, cursor, icon, card, visible: true });

test('pointIn includes the edge and the padding', () => {
  assert.equal(pointIn(icon, { x: 124, y: 124 }), true);
  assert.equal(pointIn(icon, { x: 126, y: 100 }), false);
  assert.equal(pointIn(icon, { x: 126, y: 100 }, 2), true);
});

test('resting on the icon opens the card after the dwell', () => {
  const t = tracker();
  assert.equal(hidden(t, 0, onIcon), null);
  assert.equal(hidden(t, 249, onIcon), null);
  assert.equal(hidden(t, 250, onIcon), 'show');
});

test('passing over the icon does not open the card; the dwell restarts on return', () => {
  const t = tracker();
  hidden(t, 0, onIcon);
  hidden(t, 100, away);
  assert.equal(hidden(t, 200, onIcon), null);
  assert.equal(hidden(t, 400, onIcon), null);
  assert.equal(hidden(t, 450, onIcon), 'show');
});

test('an icon with no bounds never opens the card', () => {
  const t = tracker();
  const none = { x: 0, y: 0, width: 0, height: 0 };
  const origin = { x: 0, y: 0 };
  t.tick({ now: 0, cursor: origin, icon: none, visible: false });
  assert.equal(t.tick({ now: 1000, cursor: origin, icon: none, visible: false }), null);
});

test('the card closes once the pointer has left both the icon and the card', () => {
  const t = tracker();
  assert.equal(shown(t, 0, onIcon), null);
  assert.equal(shown(t, 100, away), null);
  assert.equal(shown(t, 399, away), null);
  assert.equal(shown(t, 400, away), 'hide');
});

test('moving onto the card keeps it open', () => {
  const t = tracker();
  shown(t, 0, away);
  assert.equal(shown(t, 200, onCard), null);
  assert.equal(shown(t, 1000, onCard), null);
  assert.equal(shown(t, 1100, away), null);
  assert.equal(shown(t, 1400, away), 'hide');
});

test('after a click the card stays closed until the pointer leaves the icon', () => {
  const t = tracker();
  hidden(t, 0, onIcon);
  t.suppress();
  assert.equal(hidden(t, 1000, onIcon), null);
  hidden(t, 1100, away);
  hidden(t, 1200, onIcon);
  assert.equal(hidden(t, 1450, onIcon), 'show');
});

test('reset forgets a dwell in progress', () => {
  const t = tracker();
  hidden(t, 0, onIcon);
  t.reset();
  assert.equal(hidden(t, 300, onIcon), null);
});

test('the poll runs fast while the card is up and sleeps until the dwell ends', () => {
  const t = tracker();
  hidden(t, 0, away);
  assert.equal(t.nextTickIn(0), 200);
  hidden(t, 0, onIcon);
  assert.equal(t.nextTickIn(100), 150);
  shown(t, 300, onIcon);
  assert.equal(t.nextTickIn(300), 80);
});
