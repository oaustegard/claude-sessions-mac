// Plays alert sounds in the hidden player window. Main sends
// { n, id, repeats, gap, volume, preview } and hears back done(n) or
// failed(n, message, code) for each one; renderer/sound-engine.js does the
// playing and reports what the audio output does.
'use strict';

const engine = window.SoundEngine.createEngine({
  makeContext: () => new AudioContext(),
  synth: window.Synth,
  load: (id) => window.player.load(id),
  report: (info) => window.player.status(info),
});

// A new default output (headphones plugged in, a dock) gets a fresh context on
// the next play. Chromium may not tell a hidden page, so this is best effort;
// the check before each play still catches a dead output.
try {
  navigator.mediaDevices.addEventListener('devicechange', () => engine.reopen('output devices changed'));
} catch {
  // no mediaDevices here
}

window.player.onPlay((msg) => {
  engine.play(msg).then(
    () => window.player.done(msg.n),
    (err) => window.player.failed(msg.n, String((err && err.message) || err), (err && err.code) || 'other'),
  );
});
