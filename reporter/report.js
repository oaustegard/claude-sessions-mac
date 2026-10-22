// Claude Code hook command: forwards one hook event to the Claude Sessions tray.
// It runs on every hook of every session, so it only uses node core, waits at
// most 500 ms for the tray, appends to a spool file when the tray is down, and
// exits 0 whatever happens. A hook must never fail a session.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const DIR = process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSessions');
const SERVER_FILE = path.join(DIR, 'server.json');
const SPOOL_FILE = path.join(DIR, 'spool.jsonl');
const SPOOL_MAX = 5 * 1024 * 1024;
const POST_TIMEOUT_MS = 500;

function clip(s, n) {
  if (typeof s !== 'string') return undefined;
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function firstLine(s) {
  if (typeof s !== 'string') return undefined;
  const line = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line && line.replace(/\*\*|__|`/g, '');
}

/** A short description of a tool call: the question asked, the file touched, the command run. */
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  if (name === 'AskUserQuestion') {
    const q = Array.isArray(input.questions) && input.questions[0];
    return clip(q && q.question, 120);
  }
  if (name === 'ExitPlanMode') return 'Plan ready for review';
  const file = input.file_path || input.notebook_path;
  if (typeof file === 'string') return clip(path.basename(file), 80);
  const v = input.description || input.command || input.pattern || input.url || input.query || input.prompt;
  return clip(typeof v === 'string' ? v : undefined, 80);
}

/** The fields the tray uses. Prompts and replies are clipped; tool input never leaves this process whole. */
function slim(p, env, ppid, now) {
  const ev = {
    v: 1,
    ts: now,
    event: p.hook_event_name,
    sessionId: p.session_id,
    cwd: p.cwd,
    pid: Number(env.CLAUDE_PID) || ppid,
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT,
    termProgram: env.TERM_PROGRAM,
    agentId: typeof p.agent_id === 'string' ? p.agent_id : undefined, // set when a subagent fired it
  };
  switch (ev.event) {
    case 'SessionStart':
      ev.source = p.source;
      ev.model = p.model;
      break;
    case 'UserPromptSubmit':
      ev.prompt = clip(p.prompt, 160);
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest':
      ev.tool = p.tool_name;
      ev.toolSummary = toolSummary(p.tool_name, p.tool_input);
      ev.toolUseId = typeof p.tool_use_id === 'string' ? p.tool_use_id.slice(0, 64) : undefined;
      break;
    case 'Notification':
      ev.notificationType = p.notification_type;
      ev.message = clip(p.message, 200);
      break;
    case 'Stop':
      ev.stopHookActive = !!p.stop_hook_active;
      ev.lastMessage = clip(firstLine(p.last_assistant_message), 200);
      ev.backgroundTasks = Array.isArray(p.background_tasks) ? p.background_tasks.length : 0;
      break;
    case 'StopFailure': {
      const err = p.error !== undefined ? p.error : p.message;
      ev.message = clip(typeof err === 'string' ? err : JSON.stringify(err), 200);
      break;
    }
    case 'SessionEnd':
      ev.reason = p.reason;
      break;
  }
  return ev;
}

function spool(ev) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let size = 0;
    try { size = fs.statSync(SPOOL_FILE).size; } catch { /* no spool yet */ }
    if (size < SPOOL_MAX) fs.appendFileSync(SPOOL_FILE, JSON.stringify(ev) + '\n');
  } catch { /* nowhere left to put it */ }
}

function post(ev, server, done) {
  const body = JSON.stringify(ev);
  let finished = false;
  const finish = (ok) => { if (!finished) { finished = true; done(ok); } };
  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    path: '/event',
    method: 'POST',
    timeout: POST_TIMEOUT_MS,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-cs-token': server.token,
    },
  }, (res) => {
    res.resume();
    finish(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on('timeout', () => { req.destroy(); finish(false); });
  req.on('error', () => finish(false));
  req.end(body);
}

function main() {
  setTimeout(() => process.exit(0), 3000).unref();
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }
    const ev = slim(payload, process.env, process.ppid, Date.now());
    if (!ev.event) process.exit(0);
    let server = null;
    try { server = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')); } catch { /* tray not running */ }
    if (!server || !server.port || !server.token) {
      spool(ev);
      process.exit(0);
    }
    post(ev, server, (ok) => {
      if (!ok) spool(ev);
      process.exit(0);
    });
  });
}

if (require.main === module) main();

module.exports = { slim, clip, firstLine, toolSummary };
