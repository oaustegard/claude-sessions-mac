// Session state machine. reduce(sessions, input) returns the next sessions
// object and a list of effects (alerts, label lookups) for main.js to run.
// It never reads the clock or the disk, so every transition is testable.
//
// Rows are keyed by the claude process id: /clear and --resume change the
// session id while the terminal tab stays the same.
'use strict';

const NEEDS_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const NEEDS_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const NEEDS_FALLBACK_MS = 12000; // alert even if Claude Code never sends its Notification
const DONE_DELAY_MS = 1500;      // a Stop hook that forces a continuation cancels the alert
const ENDED_KEEP_MS = 10 * 60 * 1000;
const REGISTRY_MISSING_MS = 3000; // a vanished registry file must stay gone this long
const JITTER_MS = 250;           // hook processes start 40-90 ms apart, so close events can swap
const STALE_MS = 24 * 3600 * 1000;
const PENDING_MAX = 20;

const URGENCY = { needs: 5, error: 4, done: 3, working: 2, idle: 1, ended: 0 };

function newRow(pid, now) {
  return { pid, state: 'idle', since: now, lastHookTs: 0, lastRegistryTs: 0, lastActivity: now, registrySeen: false, pending: [] };
}

function resetConversation(row) {
  row.firstPrompt = undefined;
  row.lastPrompt = undefined;
  row.lastMessage = undefined;
  row.backgroundTasks = 0;
  row.error = undefined;
  row.pending = [];
}

function enter(row, state, ts) {
  if (row.state === state) return;
  if (row.state === 'needs') {
    row.needsReason = undefined;
    row.needsTool = undefined;
    row.needsWeak = undefined;
    row.needsAlerted = false;
  }
  if (row.state === 'done') row.doneAlertDue = undefined;
  if (state === 'working') row.doneAlerted = false;
  row.state = state;
  row.since = ts;
}

/** weak: the reason is a guess (from the registry) that a hook may replace. */
function enterNeeds(row, ts, reason, tool, weak) {
  if (row.state !== 'needs') {
    enter(row, 'needs', ts);
    row.needsAlerted = false;
  }
  if (!row.needsReason || (row.needsWeak && !weak)) {
    row.needsReason = reason;
    row.needsWeak = !!weak;
  }
  if (tool && !row.needsTool) row.needsTool = tool;
}

function endRow(row, ts, reason) {
  enter(row, 'ended', ts);
  row.endedAt = ts;
  row.endReason = reason;
  row.doneAlertDue = undefined;
  return row;
}

function toolFromMessage(msg) {
  const m = /permission to use (\w+)/i.exec(msg || '');
  return m ? m[1] : undefined;
}

/** Tool calls that started and have not finished: a permission prompt needs one. */
function addPending(row, ev) {
  const id = ev.toolUseId || `tool:${ev.tool}`;
  row.pending = [...(row.pending || []).filter((p) => p !== id), id].slice(-PENDING_MAX);
}

function removePending(row, ev) {
  const list = row.pending || [];
  let i = ev.toolUseId ? list.indexOf(ev.toolUseId) : -1;
  if (i < 0) i = list.indexOf(`tool:${ev.tool}`);
  row.pending = i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}

function applyHook(out, ev, replay, effects) {
  const key = String(ev.pid);
  const ts = Number(ev.ts) || 0;
  let row = out[key];
  if (row && row.state === 'ended' && ev.event !== 'SessionEnd' && ts > (row.endedAt || 0)) row = undefined; // pid reused
  if (!row && ev.event === 'SessionEnd') return;
  // A subagent's tool calls run beside the main turn; they would undo its done state.
  if (ev.agentId && ev.event !== 'Notification') return;
  const isNew = !row;
  if (!isNew && ts < row.lastHookTs - JITTER_MS && ev.event !== 'SessionEnd') return; // replayed or late
  row = isNew ? newRow(ev.pid, ts) : { ...row };
  // An event older than the current state's start updates details but never
  // the state: a PostToolUse that loses the race with its Stop stays done.
  const canMove = isNew || ts >= (row.since || 0);

  if (ev.sessionId && ev.sessionId !== row.sessionId) {
    if (row.sessionId) resetConversation(row);
    row.sessionId = ev.sessionId;
  }
  if (ev.cwd && ev.cwd !== row.cwd) {
    row.cwd = ev.cwd;
    effects.push({ type: 'needLabels', pid: ev.pid, cwd: ev.cwd });
  }
  if (!row.registrySeen && ev.entrypoint) row.entrypoint = ev.entrypoint;
  if (ev.termProgram) row.termProgram = ev.termProgram;
  row.lastHookTs = Math.max(row.lastHookTs, ts);
  row.lastActivity = Math.max(row.lastActivity || 0, ts);

  switch (ev.event) {
    case 'SessionStart':
      if (ev.model) row.model = ev.model;
      // startup: a new row starts idle, and an existing one (made from the
      // registry a moment earlier) keeps its state. compact: mid-turn, no change.
      if (canMove && (ev.source === 'clear' || ev.source === 'resume')) enter(row, 'idle', ts);
      break;
    case 'UserPromptSubmit':
      if (ev.prompt) {
        row.lastPrompt = ev.prompt;
        if (!row.firstPrompt && !isInjected(ev.prompt)) row.firstPrompt = ev.prompt;
      }
      row.pending = [];
      row.hidden = undefined; // a forgotten session comes back when you use it
      if (!canMove) break;
      row.tool = undefined;
      row.toolSummary = undefined;
      row.error = undefined;
      enter(row, 'working', ts);
      break;
    case 'PreToolUse':
      addPending(row, ev);
      if (!canMove) break;
      row.tool = ev.tool;
      row.toolSummary = ev.toolSummary;
      if (NEEDS_TOOLS.has(ev.tool)) {
        const reason = ev.tool === 'AskUserQuestion' ? `Question: ${ev.toolSummary || 'Claude is asking you something'}` : 'Plan ready for review';
        enterNeeds(row, ts, reason, ev.tool, false);
      } else if (row.state !== 'needs') {
        enter(row, 'working', ts);
      }
      break;
    case 'PostToolUse':
      removePending(row, ev);
      if (!canMove) break;
      // With parallel tool calls another tool can finish while a prompt is up;
      // only the tool that asked clears needs-you.
      if (row.state === 'needs' && row.needsTool && row.needsTool !== ev.tool) break;
      enter(row, 'working', ts);
      break;
    case 'Notification': {
      if (!NEEDS_NOTIFICATIONS.has(ev.notificationType)) break; // idle_prompt and the rest
      // Claude Code sends permission_prompt ~6 s after the prompt opens, even
      // when you answered sooner. With no tool call open, nothing is waiting.
      const stale = ev.notificationType === 'permission_prompt' && row.state !== 'needs' && !(row.pending || []).length;
      if (stale || !canMove) break;
      enterNeeds(row, ts, ev.message || 'Claude needs you', toolFromMessage(ev.message), false);
      if (!row.needsAlerted) {
        row.needsAlerted = true;
        if (!replay) effects.push({ type: 'alert', kind: 'needs', pid: ev.pid });
      }
      break;
    }
    case 'Stop': {
      row.pending = [];
      if (!canMove) break;
      const wasDone = row.state === 'done';
      row.lastMessage = ev.lastMessage;
      row.backgroundTasks = ev.backgroundTasks || 0;
      enter(row, 'done', ts);
      if (!wasDone) row.seen = false;
      if (!replay && !(wasDone && (row.doneAlerted || row.doneAlertDue))) row.doneAlertDue = ts + DONE_DELAY_MS;
      break;
    }
    case 'StopFailure':
      row.pending = [];
      if (!canMove) break;
      row.error = ev.message || 'The turn ended with an API error';
      enter(row, 'error', ts);
      if (!replay) effects.push({ type: 'alert', kind: 'error', pid: ev.pid });
      break;
    case 'SessionEnd':
      endRow(row, ts, ev.reason || 'exit');
      break;
    default:
      break;
  }
  // Replayed events describe the past: never alert for them later either.
  if (replay && row.state === 'needs') row.needsAlerted = true;
  if (isNew) effects.push({ type: 'new', pid: ev.pid });
  out[key] = row;
}

function applyRegistry(out, snapshot, now, effects) {
  if (!snapshot || !snapshot.ok) return;
  const present = new Set(snapshot.present || snapshot.entries.map((e) => e.pid));
  for (const e of snapshot.entries) {
    const key = String(e.pid);
    let row = out[key];
    if (row && row.state === 'ended') {
      // The file of a killed process lingers; only a process that started
      // after the row ended (pid reuse) gets a fresh row.
      if (!(e.startedAt && row.endedAt && e.startedAt > row.endedAt)) continue;
      row = undefined;
    }
    if (row && row.startedAt && e.startedAt && row.startedAt !== e.startedAt) row = undefined; // pid reused
    const isNew = !row;
    row = isNew ? newRow(e.pid, now) : { ...row };
    row.registrySeen = true;
    row.missingSince = undefined;
    if (e.sessionId && !row.sessionId) row.sessionId = e.sessionId; // hooks own the session id after that
    if (e.cwd && !row.cwd) {
      row.cwd = e.cwd;
      effects.push({ type: 'needLabels', pid: e.pid, cwd: e.cwd });
    }
    if (e.entrypoint) row.entrypoint = e.entrypoint;
    if (e.startedAt) row.startedAt = e.startedAt;
    if (e.procStart) row.procStart = e.procStart;
    if (e.hostSessionId) row.hostSessionId = e.hostSessionId;
    if (e.version) row.version = e.version;
    // A derived name is a slug of the folder; any other is a real title.
    // Claude Desktop writes its titles with no nameSource at all.
    row.name = e.name && e.nameSource !== 'derived' ? e.name : undefined;
    row.regName = e.name || undefined; // Claude Code puts it in the terminal title, so focus matches on it

    // The registry status is a hint: it applies only when it is newer than the
    // last hook event, because only hooks report done and why you are needed.
    const sts = e.statusUpdatedAt || 0;
    if (e.status && (isNew || (sts > row.lastHookTs && sts > (row.lastRegistryTs || 0)))) {
      const at = sts || now;
      row.lastRegistryTs = Math.max(row.lastRegistryTs || 0, sts);
      const settled = row.state === 'done' || row.state === 'error'; // only hooks move these
      if (e.status === 'waiting') {
        enterNeeds(row, at, row.tool ? `Needs permission: ${row.tool}` : 'Waiting for you', undefined, true);
      } else if (e.status === 'busy' && !settled) {
        if (row.state !== 'working') enter(row, 'working', at);
      } else if (e.status === 'idle' && !settled) {
        enter(row, 'idle', at);
      }
      row.lastActivity = Math.max(row.lastActivity || 0, at);
    }
    if (isNew) effects.push({ type: 'new', pid: e.pid });
    out[key] = row;
  }
  for (const [key, row] of Object.entries(out)) {
    if (!row.registrySeen || row.state === 'ended' || present.has(row.pid)) continue;
    if (!row.missingSince) {
      out[key] = { ...row, missingSince: now };
    } else if (now - row.missingSince >= REGISTRY_MISSING_MS) {
      out[key] = endRow({ ...row }, now, 'registry');
    }
  }
}

function applyTick(out, now, effects) {
  for (const [key, row] of Object.entries(out)) {
    if (row.state === 'ended') {
      if (now - (row.endedAt || 0) > ENDED_KEEP_MS) delete out[key];
      continue;
    }
    if (row.state === 'needs' && !row.needsAlerted && now - row.since >= NEEDS_FALLBACK_MS) {
      out[key] = { ...row, needsAlerted: true };
      effects.push({ type: 'alert', kind: 'needs', pid: row.pid });
    } else if (row.state === 'done' && row.doneAlertDue && now >= row.doneAlertDue) {
      out[key] = { ...row, doneAlertDue: undefined, doneAlerted: true };
      effects.push({ type: 'alert', kind: 'done', pid: row.pid });
    }
  }
}

function reduce(sessions, input) {
  const out = { ...sessions };
  const effects = [];
  switch (input.type) {
    case 'hook':
      if (input.ev && Number.isInteger(input.ev.pid) && typeof input.ev.event === 'string') {
        applyHook(out, input.ev, !!input.replay, effects);
      }
      break;
    case 'registry':
      applyRegistry(out, input.snapshot, input.now, effects);
      break;
    case 'dead':
      for (const pid of input.pids) {
        const row = out[String(pid)];
        if (row && row.state !== 'ended') out[String(pid)] = endRow({ ...row }, input.now, 'process gone');
      }
      break;
    case 'seen': {
      const row = out[String(input.pid)];
      if (row && row.state === 'done') {
        const next = { ...row, seen: true, doneAlertDue: undefined };
        enter(next, 'idle', input.now);
        out[String(input.pid)] = next;
      }
      break;
    }
    case 'labels': {
      const row = out[String(input.pid)];
      if (row && row.cwd === input.cwd) out[String(input.pid)] = { ...row, project: input.project, branch: input.branch };
      break;
    }
    case 'tick':
      applyTick(out, input.now, effects);
      break;
    case 'forget': {
      // An ended row goes; a live one hides until its next prompt.
      const key = String(input.pid);
      const row = out[key];
      if (!row) break;
      if (row.state === 'ended') delete out[key];
      else out[key] = { ...row, hidden: true, doneAlertDue: undefined };
      break;
    }
    default:
      break;
  }
  return { sessions: out, effects };
}

// ---------------------------------------------------------------- display

// Sessions with a window you work in: terminal runs and Claude Desktop's Code tab.
const FOREGROUND = new Set(['cli', 'claude-desktop']);

function isVisible(row, showAll) {
  return !row.hidden && (showAll || !row.entrypoint || FOREGROUND.has(row.entrypoint));
}

/** Remote Control bridges and SDK runs (`sdk-cli`, `sdk-py`) run with no window to show. */
function isBackground(row) {
  return String(row.entrypoint || '').startsWith('sdk-');
}

/** Visible live rows, most urgent first, then most recently active. */
function visibleRows(sessions, showAll) {
  return Object.values(sessions)
    .filter((r) => r.state !== 'ended' && isVisible(r, showAll))
    .sort((a, b) => (URGENCY[b.state] - URGENCY[a.state]) || ((b.lastActivity || 0) - (a.lastActivity || 0)));
}

function summarize(sessions, showAll) {
  const rows = visibleRows(sessions, showAll);
  const counts = { needs: 0, error: 0, done: 0, working: 0, idle: 0 };
  for (const r of rows) counts[r.state]++;
  return {
    rows,
    counts,
    total: rows.length,
    top: rows.length ? rows[0].state : null,
    badge: counts.needs + counts.error + counts.done,
  };
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function clipText(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * "shop · checkout" and a name: the session's own title or its first prompt.
 * An alias you set takes the branch's place, "shop · my alias", so a long
 * project and branch can't push it out of sight.
 */
/**
 * True for a prompt the app wrote rather than the person: Claude Desktop
 * submits background-task results and similar as XML-tagged turns, such as
 * "<task-notification> …". Those make a poor session name.
 */
function isInjected(prompt) {
  return /^\s*<[a-z][\w-]*[\s>]/i.test(String(prompt || ''));
}

function rowLabel(row, alias) {
  const folder = row.cwd ? row.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
  if (alias) {
    const place = row.project || folder;
    return { where: place ? `${place} · ${alias}` : alias, name: '' };
  }
  const where = row.project ? (row.branch ? `${row.project} · ${row.branch}` : row.project) : (folder || `pid ${row.pid}`);
  const name = row.name || clipText(row.firstPrompt, 40) || '';
  return { where, name };
}

function stateLine(row, now) {
  const t = ago(now - (typeof row.since === 'number' ? row.since : now));
  switch (row.state) {
    case 'needs': return `${row.needsReason || 'Needs you'} · ${t}`;
    case 'error': return `Error: ${row.error || 'turn failed'}`;
    case 'done': {
      const bg = row.backgroundTasks ? ` · ${row.backgroundTasks} background task${row.backgroundTasks > 1 ? 's' : ''}` : '';
      return `Done ${t === 'now' ? 'just now' : t + ' ago'}${bg}`;
    }
    case 'working': return `Working ${t}${row.tool ? ' · ' + row.tool : ''}`;
    case 'idle': return `Idle ${t}`;
    case 'ended': return `Ended ${t === 'now' ? 'just now' : t + ' ago'}`;
    default: return row.state;
  }
}

/** Drop rows a restarted tray should not resurrect, and alerts it should not repeat. */
function pruneLoaded(sessions, now) {
  const out = {};
  for (const [key, row] of Object.entries(sessions || {})) {
    if (!row || !Number.isInteger(row.pid)) continue;
    if (row.state === 'ended' && now - (row.endedAt || 0) > ENDED_KEEP_MS) continue;
    if (now - (row.lastActivity || 0) > STALE_MS) continue;
    out[key] = { ...row, doneAlertDue: undefined, needsAlerted: row.state === 'needs' ? true : row.needsAlerted, pending: row.pending || [] };
  }
  return out;
}

module.exports = {
  reduce,
  summarize,
  visibleRows,
  isVisible,
  isBackground,
  rowLabel,
  stateLine,
  ago,
  pruneLoaded,
  URGENCY,
  NEEDS_FALLBACK_MS,
  DONE_DELAY_MS,
  ENDED_KEEP_MS,
};
