'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reduce, summarize, stateLine, rowLabel, pruneLoaded, NEEDS_FALLBACK_MS, DONE_DELAY_MS, ENDED_KEEP_MS } = require('../state');

const PID = 4242;

/** Feeds inputs in order and collects every effect. */
function run(inputs, start = {}) {
  let sessions = start;
  const effects = [];
  for (const input of inputs) {
    const r = reduce(sessions, input);
    sessions = r.sessions;
    effects.push(...r.effects);
  }
  return { sessions, effects, row: sessions[String(PID)] };
}

const hook = (event, ts, extra = {}) => ({ type: 'hook', ev: { v: 1, event, ts, pid: PID, sessionId: 's1', cwd: 'C:\\work\\shop', entrypoint: 'cli', ...extra } });
const alerts = (effects) => effects.filter((e) => e.type === 'alert').map((e) => e.kind);
const reg = (entries, now, present) => ({ type: 'registry', now, snapshot: { ok: true, entries, present: present || entries.map((e) => e.pid) } });

test('a prompt runs, stops, and alerts done after the delay', () => {
  const r = run([
    hook('SessionStart', 1000, { source: 'startup', model: 'claude-opus-5-5' }),
    hook('UserPromptSubmit', 2000, { prompt: 'fix the bug' }),
    hook('PreToolUse', 2100, { tool: 'Edit', toolSummary: 'state.js', toolUseId: 't1' }),
    hook('PostToolUse', 2200, { tool: 'Edit', toolUseId: 't1' }),
    hook('Stop', 3000, { lastMessage: 'Fixed it.' }),
    { type: 'tick', now: 3000 + DONE_DELAY_MS - 1 },
  ]);
  assert.strictEqual(r.row.state, 'done');
  assert.deepStrictEqual(alerts(r.effects), []);
  const after = run([{ type: 'tick', now: 3000 + DONE_DELAY_MS }], r.sessions);
  assert.deepStrictEqual(alerts(after.effects), ['done']);
  assert.strictEqual(r.row.firstPrompt, 'fix the bug');
  assert.strictEqual(r.row.lastMessage, 'Fixed it.');
  assert.strictEqual(r.row.model, 'claude-opus-5-5');
  // A second tick does not alert again.
  assert.deepStrictEqual(alerts(run([{ type: 'tick', now: 9000 }], after.sessions).effects), []);
});

test('a Stop hook that forces a continuation cancels the done alert', () => {
  const r = run([
    hook('UserPromptSubmit', 1000, { prompt: 'go' }),
    hook('Stop', 2000),
    hook('PreToolUse', 2500, { tool: 'Bash', toolUseId: 't2' }),
    { type: 'tick', now: 2000 + DONE_DELAY_MS + 10 },
  ]);
  assert.strictEqual(r.row.state, 'working');
  assert.deepStrictEqual(alerts(r.effects), []);
  const end = run([hook('Stop', 4000, { stopHookActive: true }), { type: 'tick', now: 4000 + DONE_DELAY_MS }], r.sessions);
  assert.strictEqual(end.row.state, 'done');
  assert.deepStrictEqual(alerts(end.effects), ['done']);
});

test('a permission prompt: registry waiting, then the Notification alerts once, then approval clears it', () => {
  const r = run([
    hook('UserPromptSubmit', 1000, { prompt: 'deploy' }),
    hook('PreToolUse', 1100, { tool: 'Bash', toolSummary: 'npm publish', toolUseId: 't1' }),
    reg([{ pid: PID, cwd: 'C:\\work\\shop', entrypoint: 'cli', status: 'waiting', statusUpdatedAt: 1200 }], 1250),
  ]);
  assert.strictEqual(r.row.state, 'needs');
  assert.strictEqual(r.row.needsReason, 'Needs permission: Bash');
  const n = run([hook('Notification', 7100, { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })], r.sessions);
  assert.deepStrictEqual(alerts(n.effects), ['needs']);
  assert.strictEqual(n.row.needsReason, 'Claude needs your permission to use Bash');
  // The fallback tick must not alert a second time.
  assert.deepStrictEqual(alerts(run([{ type: 'tick', now: 1200 + NEEDS_FALLBACK_MS + 1 }], n.sessions).effects), []);
  const ok = run([hook('PostToolUse', 9000, { tool: 'Bash', toolUseId: 't1' })], n.sessions);
  assert.strictEqual(ok.row.state, 'working');
  assert.strictEqual(ok.row.needsReason, undefined);
});

test('needs-you alerts on the 12 s fallback when no Notification comes', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('PreToolUse', 1100, { tool: 'AskUserQuestion', toolSummary: 'Which database?', toolUseId: 'q1' }),
    { type: 'tick', now: 1100 + NEEDS_FALLBACK_MS - 1 },
  ]);
  assert.strictEqual(r.row.state, 'needs');
  assert.strictEqual(r.row.needsReason, 'Question: Which database?');
  assert.deepStrictEqual(alerts(r.effects), []);
  assert.deepStrictEqual(alerts(run([{ type: 'tick', now: 1100 + NEEDS_FALLBACK_MS }], r.sessions).effects), ['needs']);
});

test('a question answered before its late Notification does not alert', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('PreToolUse', 1100, { tool: 'AskUserQuestion', toolSummary: 'Which?', toolUseId: 'q1' }),
    hook('PostToolUse', 3000, { tool: 'AskUserQuestion', toolUseId: 'q1' }),
    hook('Notification', 7100, { notificationType: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' }),
  ]);
  assert.strictEqual(r.row.state, 'working');
  assert.deepStrictEqual(alerts(r.effects), []);
});

test('another tool finishing does not clear a question', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('PreToolUse', 1100, { tool: 'AskUserQuestion', toolUseId: 'q1' }),
    hook('PostToolUse', 1200, { tool: 'Read', toolUseId: 'r1' }),
  ]);
  assert.strictEqual(r.row.state, 'needs');
});

test('ExitPlanMode needs you with a plan reason', () => {
  const r = run([hook('UserPromptSubmit', 1000), hook('PreToolUse', 1100, { tool: 'ExitPlanMode', toolUseId: 'p1' })]);
  assert.strictEqual(r.row.state, 'needs');
  assert.strictEqual(r.row.needsReason, 'Plan ready for review');
});

test('idle_prompt is ignored, so a finished turn alerts once', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('Stop', 2000),
    { type: 'tick', now: 2000 + DONE_DELAY_MS },
    hook('Notification', 65000, { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' }),
    { type: 'tick', now: 70000 },
  ]);
  assert.strictEqual(r.row.state, 'done');
  assert.deepStrictEqual(alerts(r.effects), ['done']);
});

test('StopFailure is an error with an immediate alert, cleared by the next prompt', () => {
  const r = run([hook('UserPromptSubmit', 1000), hook('StopFailure', 2000, { message: 'rate_limit' })]);
  assert.strictEqual(r.row.state, 'error');
  assert.strictEqual(r.row.error, 'rate_limit');
  assert.deepStrictEqual(alerts(r.effects), ['error']);
  assert.strictEqual(run([hook('UserPromptSubmit', 3000)], r.sessions).row.state, 'working');
});

test('subagent tool calls do not move the main session', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('Stop', 2000),
    hook('PreToolUse', 2100, { tool: 'Grep', agentId: 'a1' }),
    hook('PostToolUse', 2200, { tool: 'Grep', agentId: 'a1' }),
  ]);
  assert.strictEqual(r.row.state, 'done');
});

test('a late PostToolUse that loses the race with Stop keeps the row done', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('PreToolUse', 1900, { tool: 'Bash', toolUseId: 't1' }),
    hook('Stop', 2000),
    hook('PostToolUse', 1950, { tool: 'Bash', toolUseId: 't1' }), // arrived late, fired earlier
  ]);
  assert.strictEqual(r.row.state, 'done');
});

test('spooled events replayed out of order end in the right state with no alerts', () => {
  const events = [
    hook('Stop', 5000, { lastMessage: 'second turn done' }),
    hook('UserPromptSubmit', 1000, { prompt: 'first' }),
    hook('Stop', 2000),
    hook('UserPromptSubmit', 4000, { prompt: 'second' }),
  ].sort((a, b) => a.ev.ts - b.ev.ts).map((h) => ({ ...h, replay: true }));
  const r = run([...events, { type: 'tick', now: 9000 }]);
  assert.strictEqual(r.row.state, 'done');
  assert.strictEqual(r.row.lastMessage, 'second turn done');
  assert.strictEqual(r.row.firstPrompt, 'first');
  assert.deepStrictEqual(alerts(r.effects), []);
  // A duplicate of an old event (POST timed out after delivery) changes nothing.
  const dup = run([hook('UserPromptSubmit', 4000, { prompt: 'second' })], r.sessions);
  assert.strictEqual(dup.row.state, 'done');
});

test('a replayed question does not alert after the tray starts', () => {
  const r = run([
    { ...hook('PreToolUse', 1000, { tool: 'AskUserQuestion', toolUseId: 'q' }), replay: true },
    { type: 'tick', now: 1000 + NEEDS_FALLBACK_MS * 2 },
  ]);
  assert.strictEqual(r.row.state, 'needs');
  assert.deepStrictEqual(alerts(r.effects), []);
});

test('compact keeps the state; /clear goes idle and starts a new conversation', () => {
  const r = run([
    hook('UserPromptSubmit', 1000, { prompt: 'long job' }),
    hook('SessionStart', 1500, { source: 'compact' }),
  ]);
  assert.strictEqual(r.row.state, 'working');
  const c = run([hook('Stop', 2000), hook('SessionStart', 3000, { source: 'clear', sessionId: 's2' })], r.sessions);
  assert.strictEqual(c.row.state, 'idle');
  assert.strictEqual(c.row.sessionId, 's2');
  assert.strictEqual(c.row.firstPrompt, undefined);
  assert.strictEqual(run([hook('UserPromptSubmit', 4000, { prompt: 'new topic', sessionId: 's2' })], c.sessions).row.firstPrompt, 'new topic');
});

test('registry hints never override done or error, and stale hints are ignored', () => {
  const r = run([hook('UserPromptSubmit', 1000), hook('Stop', 2000)]);
  const idle = run([reg([{ pid: PID, status: 'idle', statusUpdatedAt: 2100 }], 2200)], r.sessions);
  assert.strictEqual(idle.row.state, 'done');
  const busy = run([reg([{ pid: PID, status: 'busy', statusUpdatedAt: 2100 }], 2200)], r.sessions);
  assert.strictEqual(busy.row.state, 'done');
  const stale = run([reg([{ pid: PID, status: 'waiting', statusUpdatedAt: 1500 }], 2200)], r.sessions);
  assert.strictEqual(stale.row.state, 'done');
  const w = run([hook('UserPromptSubmit', 3000), reg([{ pid: PID, status: 'idle', statusUpdatedAt: 3500 }], 3600)], r.sessions);
  assert.strictEqual(w.row.state, 'idle');
});

test('a session that started before the hooks shows up from the registry', () => {
  const r = run([reg([{ pid: PID, cwd: 'U:\\proj', entrypoint: 'cli', status: 'busy', statusUpdatedAt: 500, startedAt: 100, name: 'my title', nameSource: 'user' }], 1000)]);
  assert.strictEqual(r.row.state, 'working');
  assert.strictEqual(r.row.name, 'my title');
  assert.deepStrictEqual(r.effects.filter((e) => e.type === 'needLabels'), [{ type: 'needLabels', pid: PID, cwd: 'U:\\proj' }]);
  const derived = run([reg([{ pid: 7, cwd: 'U:\\p', status: 'idle', name: 'p-ab', nameSource: 'derived' }], 1000)]);
  assert.strictEqual(derived.sessions['7'].name, undefined);
});

test('a vanished registry file ends the row after 3 s; a dead pid ends it at once', () => {
  const entry = { pid: PID, status: 'idle', statusUpdatedAt: 100, startedAt: 50 };
  const r = run([reg([entry], 1000), reg([], 2000), reg([], 4000)]);
  assert.strictEqual(r.row.state, 'idle');
  assert.strictEqual(run([reg([], 5000)], r.sessions).row.state, 'ended');
  // A failed read never ends anything.
  const failed = run([{ type: 'registry', now: 9000, snapshot: { ok: false, entries: [], present: [] } }], run([reg([entry], 1000), reg([], 2000)]).sessions);
  assert.strictEqual(failed.row.state, 'idle');
  const dead = run([hook('UserPromptSubmit', 1000), { type: 'dead', pids: [PID], now: 1500 }]);
  assert.strictEqual(dead.row.state, 'ended');
  assert.strictEqual(dead.row.endReason, 'process gone');
});

test('a lingering registry file does not revive a killed session, but pid reuse does', () => {
  const ended = run([reg([{ pid: PID, status: 'busy', statusUpdatedAt: 100, startedAt: 50 }], 1000), { type: 'dead', pids: [PID], now: 2000 }]);
  const linger = run([reg([{ pid: PID, status: 'busy', statusUpdatedAt: 100, startedAt: 50 }], 3000)], ended.sessions);
  assert.strictEqual(linger.row.state, 'ended');
  const reused = run([reg([{ pid: PID, status: 'idle', statusUpdatedAt: 5000, startedAt: 4000, cwd: 'C:\\other' }], 6000)], ended.sessions);
  assert.strictEqual(reused.row.state, 'idle');
  assert.strictEqual(reused.row.cwd, 'C:\\other');
});

test('SessionEnd ends the row; ended rows are purged after 10 minutes', () => {
  const r = run([hook('UserPromptSubmit', 1000), hook('SessionEnd', 2000, { reason: 'other' })]);
  assert.strictEqual(r.row.state, 'ended');
  assert.ok(run([{ type: 'tick', now: 2000 + ENDED_KEEP_MS - 1 }], r.sessions).row);
  assert.strictEqual(run([{ type: 'tick', now: 2000 + ENDED_KEEP_MS + 1 }], r.sessions).row, undefined);
  // A new event after the end means a new process with the same pid.
  assert.strictEqual(run([hook('UserPromptSubmit', 3000)], r.sessions).row.state, 'working');
});

test('seen turns done into idle; labels apply only to the current cwd', () => {
  const r = run([hook('UserPromptSubmit', 1000), hook('Stop', 2000), { type: 'seen', pid: PID, now: 2500 }]);
  assert.strictEqual(r.row.state, 'idle');
  assert.deepStrictEqual(alerts(run([{ type: 'tick', now: 9000 }], r.sessions).effects), []);
  const l = run([{ type: 'labels', pid: PID, cwd: 'C:\\work\\shop', project: 'shop', branch: 'main' }, { type: 'labels', pid: PID, cwd: 'C:\\old', project: 'old' }], r.sessions);
  assert.strictEqual(l.row.project, 'shop');
  assert.strictEqual(l.row.branch, 'main');
});

test('summarize orders by urgency and hides non-terminal sessions unless asked', () => {
  const s = {
    1: { pid: 1, state: 'idle', entrypoint: 'cli', lastActivity: 9 },
    2: { pid: 2, state: 'needs', entrypoint: 'cli', lastActivity: 1 },
    3: { pid: 3, state: 'done', entrypoint: 'cli', lastActivity: 5 },
    4: { pid: 4, state: 'needs', entrypoint: 'claude-desktop', lastActivity: 5 },
    5: { pid: 5, state: 'ended', entrypoint: 'cli', lastActivity: 5 },
  };
  const sum = summarize(s, false);
  assert.deepStrictEqual(sum.rows.map((r) => r.pid), [2, 3, 1]);
  assert.strictEqual(sum.badge, 2);
  assert.strictEqual(sum.top, 'needs');
  assert.strictEqual(summarize(s, true).total, 4);
});

test('labels and state lines read well', () => {
  const row = { pid: 1, state: 'done', since: 0, project: 'shop', branch: 'checkout', firstPrompt: 'a'.repeat(60), backgroundTasks: 2 };
  assert.deepStrictEqual(rowLabel(row), { where: 'shop · checkout', name: 'a'.repeat(39) + '…' });
  assert.deepStrictEqual(rowLabel(row, 'my alias'), { where: 'shop · my alias', name: '' });
  assert.strictEqual(rowLabel({ pid: 9, cwd: 'C:\\x\\proj\\' }, 'tmp').where, 'proj · tmp');
  assert.strictEqual(rowLabel({ pid: 9 }, 'tmp').where, 'tmp');
  assert.strictEqual(rowLabel({ pid: 9, cwd: 'C:\\x\\proj\\' }).where, 'proj');
  assert.strictEqual(stateLine(row, 120000), 'Done 2m ago · 2 background tasks');
  assert.strictEqual(stateLine({ state: 'working', since: 0, tool: 'Edit' }, 360000), 'Working 6m · Edit');
  assert.strictEqual(stateLine({ state: 'needs', since: 0, needsReason: 'Needs permission: Bash' }, 60000), 'Needs permission: Bash · 1m');
});

test('pruneLoaded drops old rows and never repeats an alert', () => {
  const now = 100 * 3600 * 1000;
  const loaded = pruneLoaded({
    1: { pid: 1, state: 'done', lastActivity: now - 1000, doneAlertDue: now - 500 },
    2: { pid: 2, state: 'idle', lastActivity: now - 25 * 3600 * 1000 },
    3: { pid: 3, state: 'needs', lastActivity: now - 1000, needsAlerted: false },
    x: { state: 'idle' },
  }, now);
  assert.deepStrictEqual(Object.keys(loaded).sort(), ['1', '3']);
  assert.strictEqual(loaded['1'].doneAlertDue, undefined);
  assert.strictEqual(loaded['3'].needsAlerted, true);
});

test('forget hides a live session until its next prompt and drops an ended one', () => {
  const r = run([
    hook('SessionStart', 1000),
    hook('UserPromptSubmit', 2000, { prompt: 'go' }),
    hook('Stop', 3000),
    { type: 'forget', pid: PID },
    { type: 'tick', now: 3000 + DONE_DELAY_MS + 10 },
  ]);
  assert.strictEqual(r.row.hidden, true);
  assert.deepStrictEqual(alerts(r.effects), []);
  assert.strictEqual(summarize(r.sessions, true).total, 0);
  const back = run([hook('UserPromptSubmit', 9000, { prompt: 'again' })], r.sessions);
  assert.strictEqual(back.row.hidden, undefined);
  assert.strictEqual(back.row.state, 'working');
  const ended = run([hook('SessionEnd', 10000), { type: 'forget', pid: PID }], back.sessions);
  assert.strictEqual(ended.row, undefined);
  assert.strictEqual(run([{ type: 'forget', pid: 1 }]).effects.length, 0);
});
