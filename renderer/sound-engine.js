// The sound engine behind the hidden player window. It owns one AudioContext
// and checks before each play that the output is running and its clock moves.
// When resume() hangs or the clock stands still, it builds a new context and
// tries once more; after that the play fails with code 'output' instead of
// staying silent. Loads in the player window as window.SoundEngine and in
// Node tests through require().
(function (root) {
  'use strict';

  const FILE_MAX_S = 2.5; // long files are cut here, with a short fade
  const FADE_S = 0.15;
  const REPEAT_AFTER_MAX_S = 0.7; // a second play starts at most this far into the first
  const RESUME_MS = 1000; // resume() can hang without settling
  const CLOCK_MS = 500; // a running clock moves every few milliseconds
  const CLOCK_POLL_MS = 20;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (err) => String((err && err.message) || err);

  function coded(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /**
   * makeContext() returns a new AudioContext. synth holds the built-in sounds
   * (renderer/synth.js). load(id) resolves to a file sound's bytes. report(info)
   * hears each time the output opens or fails. wait(ms) is the delay, so tests
   * can skip it.
   * Returns { play(msg), reopen(why), state() }. play resolves once the sound
   * is scheduled and rejects with err.code 'output', 'file' or 'other'.
   */
  function createEngine({ makeContext, synth, load, report = () => {}, wait = sleep }) {
    let ctx = null;
    let master = null;
    let previewVoice = null;
    let seen = 0; // ctx.currentTime at the last check
    let checking = null;
    let stale = null; // why the next play should start from a new context
    // Decoded buffers work in any context, so they outlive a rebuild.
    const buffers = new Map();

    function open(why) {
      if (ctx) {
        const old = ctx;
        Promise.resolve().then(() => old.close()).catch(() => {});
      }
      ctx = null;
      stale = null;
      try {
        ctx = makeContext();
        master = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        master.connect(limiter);
        limiter.connect(ctx.destination);
      } catch (err) {
        ctx = null;
        report({ event: 'output failed', reason: why, error: text(err) });
        throw coded(`could not open the audio output: ${text(err)}`, 'output');
      }
      previewVoice = null;
      seen = ctx.currentTime;
      report({ event: why, state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency });
    }

    async function clockMoves() {
      for (let waited = 0; ; waited += CLOCK_POLL_MS) {
        if (ctx.currentTime > seen) {
          seen = ctx.currentTime;
          return true;
        }
        if (waited >= CLOCK_MS) return false;
        await wait(CLOCK_POLL_MS);
      }
    }

    /** Why the output cannot play right now, or null when it can. */
    async function problem() {
      if (ctx.state !== 'running') {
        const c = ctx;
        const resumed = await Promise.race([
          Promise.resolve().then(() => c.resume()).then(() => 'ok', (e) => `resume failed: ${text(e)}`),
          wait(RESUME_MS).then(() => 'timeout'),
        ]);
        if (c.state !== 'running') {
          if (resumed === 'timeout') return `stuck ${c.state}`;
          return resumed === 'ok' ? `state ${c.state}` : resumed;
        }
      }
      if (!(await clockMoves())) return 'clock stopped';
      return null;
    }

    async function check() {
      let why = !ctx ? 'output opened' : ctx.state === 'closed' ? 'reopened after close' : stale;
      for (let attempt = 1; ; attempt++) {
        if (why) open(why);
        const p = await problem();
        if (!p) return;
        report({ event: 'output not running', reason: p, attempt, state: ctx.state });
        if (attempt === 2) throw coded(`audio output is not running (${p})`, 'output');
        why = `reopened: ${p}`;
      }
    }

    /** One check at a time, so two alerts at once do not both rebuild. */
    function ready() {
      if (!checking) checking = check().finally(() => { checking = null; });
      return checking;
    }

    async function bufferFor(id) {
      if (!buffers.has(id)) {
        let buf;
        try {
          const bytes = await load(id);
          const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          buf = await ctx.decodeAudioData(copy);
        } catch (err) {
          throw coded(`could not load ${id}: ${text(err)}`, 'file');
        }
        buffers.set(id, buf);
      }
      return buffers.get(id);
    }

    function playBuffer(buf, dest, t0) {
      const len = Math.min(buf.duration, FILE_MAX_S);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(1, t0);
      if (buf.duration > FILE_MAX_S) {
        g.gain.setValueAtTime(1, t0 + len - FADE_S);
        g.gain.linearRampToValueAtTime(0, t0 + len);
      }
      src.connect(g);
      g.connect(dest);
      src.start(t0);
      src.stop(t0 + len + 0.01);
      return len;
    }

    async function play({ id, repeats = 1, gap = 0.18, volume = 0.8, preview = false }) {
      const name = String(id).startsWith('synth:') ? String(id).slice(6) : null;
      if (name !== null && !(Object.prototype.hasOwnProperty.call(synth, name) && typeof synth[name] === 'function')) {
        throw coded(`no built-in sound ${id}`, 'other');
      }
      await ready();
      const buf = name === null ? await bufferFor(id) : null;
      const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.8;
      master.gain.setValueAtTime(v, ctx.currentTime);
      // Each play gets its own gain node, so a new preview can cut off the last one.
      const voice = ctx.createGain();
      voice.connect(master);
      if (preview) {
        if (previewVoice) previewVoice.disconnect();
        previewVoice = voice;
      }
      const once = buf ? (t) => playBuffer(buf, voice, t) : (t) => synth[name](ctx, voice, t);
      let t = ctx.currentTime + 0.03;
      for (let i = 0; i < repeats; i++) t += Math.min(once(t), REPEAT_AFTER_MAX_S) + gap;
    }

    return {
      play,
      /** The next play starts from a new context, e.g. after the output devices changed. */
      reopen(why) {
        if (ctx) stale = why;
      },
      state: () => (ctx ? ctx.state : 'none'),
    };
  }

  const SoundEngine = { createEngine, RESUME_MS, CLOCK_MS };
  root.SoundEngine = SoundEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = SoundEngine;
})(typeof window !== 'undefined' ? window : globalThis);
