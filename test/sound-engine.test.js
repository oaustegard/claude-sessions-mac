'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../renderer/sound-engine.js');

// A stand-in for AudioContext. Its clock moves on each read while it runs,
// and resume() can work, do nothing, hang or reject.
class FakeContext {
  constructor({ state = 'running', resume = 'ok', clock = true } = {}) {
    this.state = state;
    this.resumeMode = resume;
    this.clock = clock;
    this.t = 0;
    this.sampleRate = 48000;
    this.baseLatency = 0.01;
    this.destination = node();
    this.gains = [];
  }
  get currentTime() {
    if (this.state === 'running' && this.clock) this.t += 0.01;
    return this.t;
  }
  resume() {
    if (this.resumeMode === 'hang') return new Promise(() => {});
    if (this.resumeMode === 'reject') return Promise.reject(new Error('denied'));
    if (this.resumeMode === 'ok') this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    const g = node();
    g.gain = param();
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    return node();
  }
  createBufferSource() {
    const s = node();
    s.start = (t) => { s.startedAt = t; };
    s.stop = () => {};
    return s;
  }
  decodeAudioData(bytes) {
    return Promise.resolve({ duration: 1, size: bytes.byteLength });
  }
}

function node() {
  return {
    disconnected: false,
    connect() {},
    disconnect() { this.disconnected = true; },
  };
}

function param() {
  const p = { values: [] };
  p.setValueAtTime = (v) => p.values.push(v);
  p.linearRampToValueAtTime = () => {};
  return p;
}

/** plan lists each new context's options in order; the last one repeats. */
function setup(plan = [{}], extra = {}) {
  const made = [];
  const reports = [];
  const calls = [];
  const loads = [];
  const synth = {
    beep(ctx, dest, t) {
      calls.push({ ctx, dest, t });
      return 0.2;
    },
  };
  const engine = createEngine({
    makeContext: () => {
      const c = new FakeContext(plan[Math.min(made.length, plan.length - 1)]);
      made.push(c);
      return c;
    },
    synth,
    load: async (id) => {
      loads.push(id);
      return Buffer.from([1, 2, 3, 4]);
    },
    report: (info) => reports.push(info),
    wait: () => new Promise((r) => setImmediate(r)),
    ...extra,
  });
  return { engine, made, reports, calls, loads };
}

test('plays a built-in sound and reports the output it opened', async () => {
  const { engine, made, reports, calls } = setup();
  await engine.play({ id: 'synth:beep' });
  assert.strictEqual(made.length, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].ctx, made[0]);
  assert.deepStrictEqual(reports, [{ event: 'output opened', state: 'running', sampleRate: 48000, baseLatency: 0.01 }]);
  assert.strictEqual(engine.state(), 'running');
});

test('a suspended output that resumes plays on the first context', async () => {
  const { engine, made, calls } = setup([{ state: 'suspended' }]);
  await engine.play({ id: 'synth:beep' });
  assert.strictEqual(made.length, 1);
  assert.strictEqual(calls.length, 1);
});

test('a resume that never settles gets a new context, which plays', async () => {
  const { engine, made, reports, calls } = setup([{ state: 'suspended', resume: 'hang' }, {}]);
  await engine.play({ id: 'synth:beep' });
  assert.strictEqual(made.length, 2);
  assert.strictEqual(calls[0].ctx, made[1]);
  assert.strictEqual(made[0].state, 'closed');
  const bad = reports.find((r) => r.event === 'output not running');
  assert.deepStrictEqual(bad, { event: 'output not running', reason: 'stuck suspended', attempt: 1, state: 'suspended' });
  assert.strictEqual(reports.at(-1).event, 'reopened: stuck suspended');
});

test('a second hung resume fails the play with code output', async () => {
  const { engine, made, reports, calls } = setup([{ state: 'suspended', resume: 'hang' }]);
  await assert.rejects(engine.play({ id: 'synth:beep' }), (err) => {
    assert.strictEqual(err.code, 'output');
    assert.match(err.message, /stuck suspended/);
    return true;
  });
  assert.strictEqual(made.length, 2);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(reports.filter((r) => r.event === 'output not running').map((r) => r.attempt), [1, 2]);
});

test('a resume that does nothing or rejects is reported with its reason', async () => {
  const quiet = setup([{ state: 'suspended', resume: 'noop' }]);
  await assert.rejects(quiet.engine.play({ id: 'synth:beep' }), /state suspended/);
  const denied = setup([{ state: 'suspended', resume: 'reject' }]);
  await assert.rejects(denied.engine.play({ id: 'synth:beep' }), /resume failed: denied/);
});

test('a clock that stands still counts as an output that is not running', async () => {
  const { engine, made, reports } = setup([{ clock: false }]);
  await assert.rejects(engine.play({ id: 'synth:beep' }), { code: 'output' });
  assert.strictEqual(made.length, 2);
  assert.ok(reports.some((r) => r.reason === 'clock stopped'));
});

test('a closed context is replaced before the next play', async () => {
  const { engine, made, reports, calls } = setup();
  await engine.play({ id: 'synth:beep' });
  made[0].state = 'closed';
  await engine.play({ id: 'synth:beep' });
  assert.strictEqual(made.length, 2);
  assert.strictEqual(calls[1].ctx, made[1]);
  assert.strictEqual(reports.at(-1).event, 'reopened after close');
});

test('an output that cannot be created fails with code output', async () => {
  const { engine, reports } = setup([{}], { makeContext: () => { throw new Error('no audio device'); } });
  await assert.rejects(engine.play({ id: 'synth:beep' }), (err) => {
    assert.strictEqual(err.code, 'output');
    assert.match(err.message, /no audio device/);
    return true;
  });
  assert.deepStrictEqual(reports, [{ event: 'output failed', reason: 'output opened', error: 'no audio device' }]);
  assert.strictEqual(engine.state(), 'none');
});

test('reopen() makes the next play start a new context, and file buffers carry over', async () => {
  const { engine, made, reports, loads } = setup();
  engine.reopen('before any output'); // nothing open yet, so nothing to do
  await engine.play({ id: 'file:chime' });
  engine.reopen('output devices changed');
  await engine.play({ id: 'file:chime' });
  assert.strictEqual(made.length, 2);
  assert.deepStrictEqual(loads, ['file:chime']);
  assert.deepStrictEqual(reports.map((r) => r.event), ['output opened', 'output devices changed']);
});

test('a file that will not load fails with code file', async () => {
  const { engine } = setup([{}], { load: async () => { throw new Error('ENOENT'); } });
  await assert.rejects(engine.play({ id: 'file:gone' }), (err) => {
    assert.strictEqual(err.code, 'file');
    assert.match(err.message, /file:gone.*ENOENT/);
    return true;
  });
});

test('an unknown built-in sound fails with code other and opens no output', async () => {
  const { engine, made } = setup();
  await assert.rejects(engine.play({ id: 'synth:nope' }), { code: 'other' });
  await assert.rejects(engine.play({ id: 'synth:constructor' }), { code: 'other' });
  assert.strictEqual(made.length, 0);
});

test('two plays at once share one check and one context', async () => {
  const { engine, made, calls } = setup([{ state: 'suspended' }]);
  await Promise.all([engine.play({ id: 'synth:beep' }), engine.play({ id: 'synth:beep' })]);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(calls.length, 2);
});

test('a new preview cuts off the last preview but not an alert', async () => {
  const { engine, calls } = setup();
  await engine.play({ id: 'synth:beep', preview: true });
  await engine.play({ id: 'synth:beep' });
  await engine.play({ id: 'synth:beep', preview: true });
  assert.deepStrictEqual(calls.map((c) => c.dest.disconnected), [true, false, false]);
});

test('repeats play the sound again after it, and volume is clamped', async () => {
  const { engine, made, calls } = setup();
  await engine.play({ id: 'synth:beep', repeats: 2, gap: 0.1, volume: 2 });
  assert.strictEqual(calls.length, 2);
  assert.ok(Math.abs(calls[1].t - calls[0].t - 0.3) < 1e-9);
  await engine.play({ id: 'synth:beep', volume: NaN });
  const master = made[0].gains[0];
  assert.deepStrictEqual(master.gain.values, [1, 0.8]);
});
