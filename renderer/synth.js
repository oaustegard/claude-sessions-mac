// The built-in sounds, made with WebAudio so they need no files. Each
// function schedules its notes on `ctx` into `dest` starting at time t0 and
// returns how long the sound lasts in seconds. A single voice peaks near 0.3.
(function (root) {
  'use strict';

  const noiseBuffers = new WeakMap();

  function noise(ctx) {
    if (!noiseBuffers.has(ctx)) {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noiseBuffers.set(ctx, buf);
    }
    return noiseBuffers.get(ctx);
  }

  /** A gain node shaped as attack-then-exponential-decay, connected to dest. */
  function envelope(ctx, dest, t0, { attack = 0.004, hold = 0, decay, peak }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    if (hold) g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
    g.connect(dest);
    return g;
  }

  /** One oscillator note. freqEnd glides the pitch over `glide` seconds. */
  function tone(ctx, dest, t0, { type = 'sine', freq, freqEnd, glide = 0.1, attack, hold, decay, peak, filter }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + glide);
    const env = envelope(ctx, dest, t0, { attack, hold, decay, peak });
    if (filter) {
      filter.connect(env);
      osc.connect(filter);
    } else {
      osc.connect(env);
    }
    const end = t0 + (attack || 0.004) + (hold || 0) + decay;
    osc.start(t0);
    osc.stop(end + 0.05);
    return end - t0;
  }

  function lowpass(ctx, t0, from, to, over) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(from, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + over);
    return f;
  }

  const Synth = {
    // Two wooden-bar notes, a rising third, each with a faint 4th partial.
    marimba(ctx, dest, t0) {
      for (const [f, dt] of [[659, 0], [784, 0.12]]) {
        tone(ctx, dest, t0 + dt, { freq: f, decay: 0.35, peak: 0.3 });
        tone(ctx, dest, t0 + dt, { freq: f * 4, decay: 0.08, peak: 0.06 });
      }
      return 0.474;
    },

    // An inharmonic bell at A5: partials 1, 2.76 and 5.4.
    bell(ctx, dest, t0) {
      tone(ctx, dest, t0, { freq: 880, decay: 1.2, peak: 0.28 });
      tone(ctx, dest, t0, { freq: 880 * 2.76, decay: 0.8, peak: 0.1 });
      tone(ctx, dest, t0, { freq: 880 * 5.4, decay: 0.4, peak: 0.05 });
      return 1.2;
    },

    // Two short knocks: a noise click and a 1200 Hz body, 110 ms apart.
    wood(ctx, dest, t0) {
      for (const dt of [0, 0.11]) {
        const src = ctx.createBufferSource();
        src.buffer = noise(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2500;
        src.connect(bp);
        bp.connect(envelope(ctx, dest, t0 + dt, { attack: 0.001, decay: 0.03, peak: 0.3 }));
        src.start(t0 + dt);
        src.stop(t0 + dt + 0.05);
        tone(ctx, dest, t0 + dt, { freq: 1200, attack: 0.001, decay: 0.07, peak: 0.3 });
      }
      return 0.19;
    },

    // Two square-wave blips gliding up, like a pager.
    blip(ctx, dest, t0) {
      for (const dt of [0, 0.09]) {
        tone(ctx, dest, t0 + dt, { type: 'square', freq: 1000, freqEnd: 1500, glide: 0.05, attack: 0.002, hold: 0.04, decay: 0.02, peak: 0.1 });
      }
      return 0.152;
    },

    // Two quick upward sweeps, like a bird.
    chirp(ctx, dest, t0) {
      tone(ctx, dest, t0, { freq: 900, freqEnd: 2200, glide: 0.12, attack: 0.01, decay: 0.12, peak: 0.25 });
      tone(ctx, dest, t0 + 0.15, { freq: 1100, freqEnd: 2600, glide: 0.12, attack: 0.01, decay: 0.12, peak: 0.25 });
      return 0.28;
    },

    // A plucked string: a sawtooth through a closing lowpass, G4 then D5.
    pluck(ctx, dest, t0) {
      for (const [f, dt] of [[392, 0], [587, 0.14]]) {
        tone(ctx, dest, t0 + dt, { type: 'sawtooth', freq: f, attack: 0.002, decay: 0.35, peak: 0.22, filter: lowpass(ctx, t0 + dt, 4000, 400, 0.3) });
      }
      return 0.492;
    },

    // A struck glass: two high sines, G6 and D7.
    glass(ctx, dest, t0) {
      tone(ctx, dest, t0, { freq: 1568, attack: 0.005, decay: 0.9, peak: 0.22 });
      tone(ctx, dest, t0, { freq: 2349, attack: 0.005, decay: 0.6, peak: 0.12 });
      return 0.905;
    },

    // A low horn: two sawtooths an octave apart through a 900 Hz lowpass.
    horn(ctx, dest, t0) {
      tone(ctx, dest, t0, { type: 'sawtooth', freq: 110, attack: 0.06, hold: 0.2, decay: 0.35, peak: 0.2, filter: lowpass(ctx, t0, 900) });
      tone(ctx, dest, t0, { type: 'sawtooth', freq: 220, attack: 0.06, hold: 0.2, decay: 0.3, peak: 0.12, filter: lowpass(ctx, t0, 900) });
      return 0.61;
    },
  };

  root.Synth = Synth;
  if (typeof module !== 'undefined' && module.exports) module.exports = Synth;
})(typeof window !== 'undefined' ? window : globalThis);
