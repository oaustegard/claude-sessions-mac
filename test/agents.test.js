'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reduce, agentRuns, agentText, agentTime, pruneLoaded, AGENT_KEEP_MS, AGENT_STALE_MS, AGENTS_MAX } = require('../state');

const PID = 4242;

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
const meta = (agentId, m) => ({ type: 'agentMeta', pid: PID, agentId, meta: m });
const reg = (status, statusUpdatedAt, now) => ({ type: 'registry', now, snapshot: { ok: true, entries: [{ pid: PID, sessionId: 's1', status, statusUpdatedAt, entrypoint: 'cli' }], present: [PID] } });
const metaPath = (id) => `C:\\h\\s1\\subagents\\agent-${id}.meta.json`;

/** The parent's Agent call, then the run's start, as Claude Code sends them. */
function launch(ts, id, { description, type = 'Explore', background = false, by, toolUseId = `tu-${id}` } = {}) {
  const spawn = { description, type, background };
  const parent = by ? { agentId: by, agentType: 'general-purpose', agentMetaPath: metaPath(by) } : {};
  const out = [
    hook('PreToolUse', ts, { tool: 'Agent', toolSummary: description, toolUseId, spawn, ...parent }),
    hook('SubagentStart', ts + 100, { agentId: id, agentType: type, agentMetaPath: metaPath(id) }),
  ];
  if (background) out.push(hook('PostToolUse', ts + 150, { tool: 'Agent', toolUseId, spawn: { ...spawn, agentId: id, status: 'async_launched' }, ...parent }));
  return out;
}

const lines = (row) => agentRuns(row).map(({ run: r, depth }) => `${'  '.repeat(depth)}${r.state} ${r.type} ${r.description}`);

test('a background run is listed from its launch and finishes on SubagentStop', () => {
  const r = run([
    hook('UserPromptSubmit', 1000, { prompt: 'look around' }),
    ...launch(1100, 'a1', { description: 'List txt files', background: true }),
    hook('PreToolUse', 1300, { tool: 'Glob', agentId: 'a1', agentType: 'Explore', toolUseId: 'g1' }),
  ]);
  assert.strictEqual(r.row.state, 'working');
  assert.deepStrictEqual(lines(r.row), ['running Explore List txt files']);
  assert.strictEqual(agentText(r.row.agents.a1), 'List txt files · Glob');
  assert.strictEqual(r.row.agents.a1.background, true);
  assert.deepStrictEqual(r.effects.filter((e) => e.type === 'needAgentMeta'), [{ type: 'needAgentMeta', pid: PID, agentId: 'a1', path: metaPath('a1') }]);

  const after = run([hook('SubagentStop', 1500, { agentId: 'a1', agentType: 'Explore', lastMessage: 'a.txt' })], r.sessions);
  assert.strictEqual(after.row.agents.a1.state, 'done');
  assert.strictEqual(after.row.agents.a1.lastMessage, 'a.txt');
  assert.strictEqual(after.row.state, 'working', 'a run finishing does not move the session');
});

test('subagent events never move the session or its hook clock', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'a1', { description: 'Background check', background: true }),
    hook('Stop', 2000, { backgroundAgents: ['a1'] }),
    hook('PreToolUse', 2400, { tool: 'Grep', agentId: 'a1', toolUseId: 'g1' }),
    hook('PostToolUse', 2500, { tool: 'Grep', agentId: 'a1', toolUseId: 'g1' }),
    hook('SubagentStop', 2600, { agentId: 'a1' }),
  ]);
  assert.strictEqual(r.row.state, 'done');
  assert.strictEqual(r.row.lastHookTs, 2000);
  // A parent event that fired before the run's last event is not taken as late.
  const late = run([hook('Notification', 1900, { notificationType: 'idle_prompt' })], r.sessions);
  assert.strictEqual(late.row.lastHookTs, 2000);
});

test('parallel runs of one type pair with their Agent calls in order', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('PreToolUse', 1100, { tool: 'Agent', toolUseId: 'tu1', spawn: { description: 'First', type: 'Explore' } }),
    hook('PreToolUse', 1110, { tool: 'Agent', toolUseId: 'tu2', spawn: { description: 'Second', type: 'Explore' } }),
    hook('SubagentStart', 1200, { agentId: 'a1', agentType: 'Explore' }),
    hook('SubagentStart', 1210, { agentId: 'a2', agentType: 'Explore' }),
  ]);
  assert.strictEqual(r.row.agents.a1.description, 'First');
  assert.strictEqual(r.row.agents.a2.description, 'Second');
  // The call's PostToolUse is the truth: it swaps a wrong guess.
  const fixed = run([hook('PostToolUse', 1500, { tool: 'Agent', toolUseId: 'tu2', spawn: { description: 'Second', type: 'Explore', agentId: 'a1', status: 'completed' } })], r.sessions);
  assert.strictEqual(fixed.row.agents.a1.description, 'Second');
  assert.strictEqual(fixed.row.agents.a1.state, 'done');
  assert.strictEqual(fixed.row.agents.a2.description, 'First');
});

test('a SubagentStart that arrives before its Agent call still pairs', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('SubagentStart', 1100, { agentId: 'a1', agentType: 'Plan' }),
    hook('PreToolUse', 1050, { tool: 'Agent', toolUseId: 'tu1', spawn: { description: 'Review the plan', type: 'Plan' } }),
  ]);
  assert.strictEqual(r.row.agents.a1.description, 'Review the plan');
});

test('the meta file fills in a run and outranks a guess', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('SubagentStart', 1100, { agentId: 'a1', agentType: 'Explore', agentMetaPath: metaPath('a1') }),
  ]);
  assert.deepStrictEqual(agentRuns(r.row), [], 'no description yet: hidden');
  const m = run([meta('a1', { agentType: 'Explore', description: 'Map the auth module', toolUseId: 'tu1', spawnDepth: 1, requestShape: 'foreground' })], r.sessions);
  assert.deepStrictEqual(lines(m.row), ['running Explore Map the auth module']);
  assert.strictEqual(m.row.agents.a1.background, false);
});

test('an agent with no Agent call and no meta file stays hidden', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('SubagentStop', 1100, { agentId: 'x1', agentType: '', agentMetaPath: metaPath('x1') }),
    meta('x1', null),
  ]);
  assert.deepStrictEqual(agentRuns(r.row), []);
  assert.strictEqual(r.row.agents.x1.state, 'done');
});

test('a missing meta file is asked for again when the run stops', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('SubagentStart', 1100, { agentId: 'a1', agentType: 'Explore', agentMetaPath: metaPath('a1') }),
    meta('a1', null),
    hook('PreToolUse', 1200, { tool: 'Glob', agentId: 'a1', agentMetaPath: metaPath('a1'), toolUseId: 'g1' }),
    hook('SubagentStop', 1300, { agentId: 'a1', agentMetaPath: metaPath('a1') }),
  ]);
  assert.strictEqual(r.effects.filter((e) => e.type === 'needAgentMeta').length, 2);
});

test('a nested run sits under the run that started it', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'p1', { description: 'Nested spawn test', type: 'general-purpose', background: true }),
    ...launch(1400, 'c1', { description: 'Inner listing', by: 'p1' }),
    ...launch(1600, 'a2', { description: 'Another top run', background: true }),
  ]);
  assert.deepStrictEqual(lines(r.row), [
    'running general-purpose Nested spawn test',
    '  running Explore Inner listing',
    'running Explore Another top run',
  ]);
  assert.strictEqual(r.row.agents.c1.depth, 2);
});

test('the parent Stop closes foreground runs and runs no longer in flight', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'bg', { description: 'Still going', background: true }),
    ...launch(1200, 'gone', { description: 'Missed its stop', background: true }),
    ...launch(1300, 'kid', { description: 'Under the live one', by: 'bg' }),
    ...launch(1400, 'fg', { description: 'Foreground' }),
    hook('Stop', 2000, { backgroundAgents: ['bg'], backgroundTasks: 1 }),
  ]);
  const s = Object.fromEntries(Object.values(r.row.agents).map((a) => [a.id, a.state]));
  assert.deepStrictEqual(s, { bg: 'running', gone: 'done', kid: 'running', fg: 'done' });
});

test('a background task notice ends its run with the status it reports', () => {
  const r = run([
    hook('UserPromptSubmit', 1000, { prompt: 'sleep' }),
    ...launch(1100, 'a1', { description: 'Sleeper', type: 'general-purpose', background: true }),
    hook('UserPromptSubmit', 1500, { taskNotice: { id: 'a1', status: 'killed' } }),
  ]);
  assert.strictEqual(r.row.agents.a1.state, 'stopped');
  assert.strictEqual(r.row.lastPrompt, 'sleep', 'a notice is not a prompt');
});

test('a prompt typed after an interrupted turn stops its foreground runs only', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'fg', { description: 'Foreground' }),
    ...launch(1200, 'bg', { description: 'Background', background: true }),
    reg('idle', 1500, 1600),
  ]);
  assert.strictEqual(r.row.state, 'idle');
  assert.strictEqual(r.row.agents.fg.state, 'stopped', 'idle with no Stop is an interrupt');
  assert.strictEqual(r.row.agents.bg.state, 'running');
  const typed = run([...launch(1700, 'fg2', { description: 'Again' }), hook('UserPromptSubmit', 1650)], r.sessions);
  assert.strictEqual(typed.row.agents.bg.state, 'running');
});

test('a prompt sent mid-turn leaves foreground runs running', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'fg', { description: 'Foreground' }),
    hook('UserPromptSubmit', 1500, { prompt: 'also check the tests' }),
  ]);
  assert.strictEqual(r.row.agents.fg.state, 'running');
});

test('a run waiting on a permission prompt shows needs-you until its tool finishes', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'a1', { description: 'Edit config', type: 'general-purpose' }),
    hook('PreToolUse', 1300, { tool: 'Bash', agentId: 'a1', toolUseId: 'b1' }),
    hook('Notification', 7300, { agentId: 'a1', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
  ]);
  assert.strictEqual(r.row.agents.a1.state, 'needs');
  assert.strictEqual(r.row.state, 'needs');
  assert.strictEqual(agentText(r.row.agents.a1), 'Edit config');
  assert.strictEqual(agentTime(r.row.agents.a1, 9000), 'needs you');
  const ok = run([hook('PostToolUse', 8000, { tool: 'Bash', agentId: 'a1', toolUseId: 'b1' })], r.sessions);
  assert.strictEqual(ok.row.agents.a1.state, 'running');
});

test('a resumed run reopens', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'a1', { description: 'Research', background: true }),
    hook('SubagentStop', 1500, { agentId: 'a1' }),
    hook('SubagentStart', 3000, { agentId: 'a1', agentType: 'Explore' }),
  ]);
  assert.strictEqual(r.row.agents.a1.state, 'running');
  assert.strictEqual(r.row.agents.a1.startedAt, 3000);
});

test('/clear and session end clear or stop the runs', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'a1', { description: 'Research', background: true }),
  ]);
  const ended = run([hook('SessionEnd', 2000, { reason: 'exit' })], r.sessions);
  assert.strictEqual(ended.row.agents.a1.state, 'stopped');
  const cleared = run([hook('SessionStart', 2000, { sessionId: 's2', source: 'clear' })], r.sessions);
  assert.deepStrictEqual(cleared.row.agents, {});
});

test('finished runs drop after the keep time and silent ones stop under an idle session', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    ...launch(1100, 'done1', { description: 'Finished', background: true }),
    hook('SubagentStop', 1200, { agentId: 'done1' }),
    ...launch(1300, 'quiet', { description: 'Went quiet', background: true }),
    hook('Stop', 1400, { backgroundAgents: ['quiet'] }),
  ]);
  const kept = run([{ type: 'tick', now: 1200 + AGENT_KEEP_MS }], r.sessions);
  assert.ok(kept.row.agents.done1);
  const later = run([{ type: 'tick', now: 1450 + AGENT_STALE_MS + 1 }], r.sessions);
  assert.strictEqual(later.row.agents.done1, undefined);
  assert.strictEqual(later.row.agents.quiet.state, 'stopped');
});

test('a row keeps at most AGENTS_MAX runs, open ones first', () => {
  const inputs = [hook('UserPromptSubmit', 1000)];
  for (let i = 0; i < AGENTS_MAX + 5; i++) {
    inputs.push(...launch(2000 + i * 1000, `a${i}`, { description: `Run ${i}`, background: true }));
    if (i > 0) inputs.push(hook('SubagentStop', 2500 + i * 1000, { agentId: `a${i}` }));
  }
  inputs.push({ type: 'tick', now: 60000 });
  const r = run(inputs);
  const ids = Object.keys(r.row.agents);
  assert.strictEqual(ids.length, AGENTS_MAX);
  assert.ok(ids.includes('a0'), 'the open run stays');
  assert.ok(!ids.includes('a1'), 'the oldest finished goes');
});

test('agentTime counts up while running and says how a run ended', () => {
  assert.strictEqual(agentTime({ state: 'running', startedAt: 0 }, 40000), '40s');
  assert.strictEqual(agentTime({ state: 'running', startedAt: 0 }, 180000), '3m');
  assert.strictEqual(agentTime({ state: 'done', endedAt: 0 }, 10000), 'just now');
  assert.strictEqual(agentTime({ state: 'stopped', endedAt: 0 }, 120000), 'stopped 2m ago');
  assert.strictEqual(agentTime({ state: 'failed', endedAt: 0 }, 120000), 'failed 2m ago');
});

test('a restarted tray keeps runs and lets them ask for meta again', () => {
  const r = run([
    hook('UserPromptSubmit', 1000),
    hook('SubagentStart', 1100, { agentId: 'a1', agentType: 'Explore', agentMetaPath: metaPath('a1') }),
  ]);
  assert.strictEqual(r.row.agents.a1.metaAsked, true);
  const loaded = pruneLoaded(JSON.parse(JSON.stringify(r.sessions)), 2000);
  assert.strictEqual(loaded[String(PID)].agents.a1.metaAsked, false);
  const again = run([hook('PreToolUse', 2100, { tool: 'Glob', agentId: 'a1', agentMetaPath: metaPath('a1'), toolUseId: 'g' })], loaded);
  assert.strictEqual(again.effects.filter((e) => e.type === 'needAgentMeta').length, 1);
});
