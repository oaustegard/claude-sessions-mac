'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { slim, toolSummary } = require('../reporter/report');

const REPORTER = path.join(__dirname, '..', 'reporter', 'report.js');
const base = { session_id: 's1', cwd: '/Users/me/work', transcript_path: 'x', permission_mode: 'default' };

test('slim keeps the pid from CLAUDE_PID, else the parent pid', () => {
  const ev = slim({ ...base, hook_event_name: 'Stop' }, { CLAUDE_PID: '4242' }, 99, 1000);
  assert.strictEqual(ev.pid, 4242);
  assert.strictEqual(slim({ ...base, hook_event_name: 'Stop' }, {}, 99, 1000).pid, 99);
});

test('slim never forwards the whole tool input', () => {
  const ev = slim({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/Users/me/work/secret-plans.md', content: 'x'.repeat(10000) },
    tool_use_id: 't1',
  }, {}, 1, 1);
  assert.strictEqual(ev.tool, 'Write');
  assert.strictEqual(ev.toolSummary, 'secret-plans.md');
  assert.ok(JSON.stringify(ev).length < 400);
  assert.strictEqual(ev.tool_input, undefined);
});

test('slim clips prompts and takes the first line of the last reply', () => {
  const p = slim({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'a'.repeat(500) }, {}, 1, 1);
  assert.strictEqual(p.prompt.length, 160);
  const s = slim({
    ...base,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '\n**DONE** Fixed the bug.\n\nMore detail here.',
    background_tasks: [{}, {}],
  }, {}, 1, 1);
  assert.strictEqual(s.lastMessage, 'DONE Fixed the bug.');
  assert.strictEqual(s.backgroundTasks, 2);
  assert.strictEqual(s.stopHookActive, false);
});

test('toolSummary describes questions, plans and commands', () => {
  assert.strictEqual(toolSummary('AskUserQuestion', { questions: [{ question: 'Which one?' }] }), 'Which one?');
  assert.strictEqual(toolSummary('ExitPlanMode', { plan: '...' }), 'Plan ready for review');
  assert.strictEqual(toolSummary('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests');
  assert.strictEqual(toolSummary('Bash', null), undefined);
});

test('notification and session end fields pass through', () => {
  const n = slim({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, {}, 1, 1);
  assert.strictEqual(n.notificationType, 'permission_prompt');
  assert.strictEqual(n.message, 'Claude needs your permission to use Bash');
  assert.strictEqual(slim({ ...base, hook_event_name: 'SessionEnd', reason: 'other' }, {}, 1, 1).reason, 'other');
});

function runReporter(dir, payload) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [REPORTER], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_SESSIONS_DIR: dir, CLAUDE_PID: '777' },
    timeout: 10000,
  });
  return { status: r.status, ms: Date.now() - t0 };
}

test('with no tray running the event goes to the spool and the hook exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rep-'));
  const r = runReporter(dir, { ...base, hook_event_name: 'Stop', stop_hook_active: false });
  assert.strictEqual(r.status, 0);
  const lines = fs.readFileSync(path.join(dir, 'spool.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.strictEqual(ev.event, 'Stop');
  assert.strictEqual(ev.pid, 777);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dead port in server.json spools within the timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rep-'));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 1, token: 'x' }));
  const r = runReporter(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.ms < 2500, `took ${r.ms} ms`);
  assert.ok(fs.existsSync(path.join(dir, 'spool.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('garbage on stdin exits 0 without spooling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rep-'));
  const r = spawnSync(process.execPath, [REPORTER], { input: 'not json', env: { ...process.env, CLAUDE_SESSIONS_DIR: dir } });
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'spool.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});
