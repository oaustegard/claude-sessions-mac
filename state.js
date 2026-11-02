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
const AGENT_KEEP_MS = 30 * 60 * 1000;  // a finished subagent run stays listed this long
const AGENT_STALE_MS = 30 * 60 * 1000; // a silent run under an idle session is taken as stopped
const AGENTS_MAX = 20;
const SPAWN_LINK_MS = 3000;            // the Agent call and its SubagentStart arrive ~0.1 s apart
const SPAWNS_MAX = 10;

const URGENCY = { needs: 5, error: 4, done: 3, working: 2, idle: 1, ended: 0 };
const AGENT_OPEN = new Set(['running', 'needs']);
const NOTICE_STATES = { completed: 'done', killed: 'stopped', failed: 'failed' };

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
  row.agents = {};
  row.spawns = [];
}

// ---------------------------------------------------------------- subagent runs
//
// row.agents holds the session's subagent runs by agent id. Each update
// replaces row.agents and the run, so earlier states stay untouched.

function putAgent(row, id, ts, patch) {
  const prev = (row.agents || {})[id];
  const run = prev
    ? { ...prev, ...patch }
    : { id, state: 'running', startedAt: ts, lastTs: ts, depth: 1, pending: [], ...patch };
  row.agents = { ...(row.agents || {}), [id]: run };
  return run;
}

function finishAgent(row, id, ts, state, extra) {
  const run = (row.agents || {})[id];
  if (!run || !AGENT_OPEN.has(run.state)) return;
  putAgent(row, id, ts, { state, endedAt: ts, tool: undefined, toolSummary: undefined, pending: [], ...extra });
}

/** Ends the open runs `pick` selects, started no later than ts. */
function finishAgents(row, ts, state, pick) {
  for (const run of Object.values(row.agents || {})) {
    if (AGENT_OPEN.has(run.state) && (run.startedAt || 0) <= ts && pick(run)) finishAgent(row, run.id, ts, state);
  }
}

/** The run and the runs above it, nearest first. */
function lineage(row, run) {
  const out = [];
  const seen = new Set();
  for (let r = run; r && !seen.has(r.id); r = r.parentAgentId && (row.agents || {})[r.parentAgentId]) {
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** A run the session's own turn waits on: no background run in its lineage. */
const tiedToTurn = (row) => (run) => lineage(row, run).every((r) => r.background !== true);

function depthUnder(row, by) {
  const parent = by && (row.agents || {})[by];
  return parent ? (parent.depth || 1) + 1 : 1;
}

/** What a spawn tells about its run; the meta file, once read, outranks it. */
function spawnFields(row, s) {
  const f = { toolUseId: s.toolUseId, parentAgentId: s.by || undefined };
  if (s.description) f.description = s.description;
  if (s.type) f.type = s.type;
  if (s.background) f.background = true;
  f.depth = depthUnder(row, s.by);
  return f;
}

/**
 * Pairs runs that have no description yet with Agent calls made just before
 * them, oldest first and by agent type. A wrong pair is fixed by the call's
 * PostToolUse or by the meta file.
 */
function linkSpawns(row) {
  const spawns = [...(row.spawns || [])];
  if (!spawns.length) return;
  const runs = Object.values(row.agents || {})
    .filter((r) => !r.toolUseId && !r.metaDone)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const run of runs) {
    const i = spawns.findIndex((s) => (!s.type || !run.type || s.type === run.type) && Math.abs(run.startedAt - s.ts) <= SPAWN_LINK_MS);
    if (i < 0) continue;
    const [s] = spawns.splice(i, 1);
    const f = spawnFields(row, s);
    if (run.description) delete f.description;
    putAgent(row, run.id, run.lastTs, f);
  }
  row.spawns = spawns;
}

/** An Agent tool call by the session (by: undefined) or by one of its runs. */
function applySpawn(row, ev, ts, by) {
  const s = ev.spawn;
  if (ev.event === 'PreToolUse') {
    if (!ev.toolUseId) return;
    const kept = (row.spawns || []).filter((x) => x.toolUseId !== ev.toolUseId && ts - x.ts <= SPAWN_LINK_MS * 3);
    row.spawns = [...kept, { toolUseId: ev.toolUseId, by, ts, type: s.type, description: s.description, background: s.background }].slice(-SPAWNS_MAX);
    linkSpawns(row);
    return;
  }
  if (ev.event !== 'PostToolUse' || !s.agentId) return;
  row.spawns = (row.spawns || []).filter((x) => x.toolUseId !== ev.toolUseId);
  const runs = row.agents || {};
  const target = runs[s.agentId];
  // The run that was paired with this call by guess gets the guess that was made for target.
  const swapped = Object.values(runs).find((r) => r.toolUseId === ev.toolUseId && r.id !== s.agentId);
  if (swapped && target && !swapped.metaDone) {
    putAgent(row, swapped.id, swapped.lastTs, { toolUseId: target.toolUseId, description: target.description, type: target.type || swapped.type });
  } else if (swapped && !swapped.metaDone) {
    putAgent(row, swapped.id, swapped.lastTs, { toolUseId: undefined, description: undefined });
  }
  const f = spawnFields(row, { toolUseId: ev.toolUseId, by, type: s.type, description: s.description, background: s.background });
  if (target && target.metaDone) {
    delete f.description;
    delete f.depth;
  }
  putAgent(row, s.agentId, ts, f);
  if (s.status === 'completed') finishAgent(row, s.agentId, ts, 'done');
}

/** Hook events a subagent fired. They describe its run and never move the session's own state. */
function applyAgentEvent(row, ev, ts, effects) {
  const id = ev.agentId;
  const prev = (row.agents || {})[id];
  const wantMeta = (run) => {
    if (ev.agentMetaPath && !run.metaDone && !run.metaAsked) {
      putAgent(row, id, run.lastTs, { metaAsked: true });
      effects.push({ type: 'needAgentMeta', pid: row.pid, agentId: id, path: ev.agentMetaPath });
    }
  };
  switch (ev.event) {
    case 'SubagentStart': {
      const reopen = !prev || !AGENT_OPEN.has(prev.state);
      const run = putAgent(row, id, ts, {
        state: 'running',
        startedAt: reopen ? ts : prev.startedAt,
        endedAt: undefined,
        lastTs: ts,
        type: ev.agentType || (prev && prev.type),
      });
      linkSpawns(row);
      wantMeta(run);
      return;
    }
    case 'SubagentStop': {
      // A stop with no start: the tray missed the start, or Claude Code ran one
      // of its own agents, which has no meta file and so stays hidden.
      if (!prev) putAgent(row, id, ts, { type: ev.agentType, startedAt: ts });
      finishAgent(row, id, ts, 'done', { lastMessage: ev.lastMessage });
      if (prev && !AGENT_OPEN.has(prev.state) && ev.lastMessage) putAgent(row, id, prev.lastTs, { lastMessage: ev.lastMessage });
      // The meta file exists by the time a run stops, so look again if earlier tries found nothing.
      if (!row.agents[id].metaDone) putAgent(row, id, ts, { metaAsked: false });
      wantMeta(row.agents[id]);
      return;
    }
    case 'PreToolUse':
    case 'PostToolUse': {
      if (prev && !AGENT_OPEN.has(prev.state)) return; // a late event of a finished run
      const run = prev || putAgent(row, id, ts, { type: ev.agentType });
      const pending = ev.event === 'PreToolUse'
        ? [...(run.pending || []).filter((p) => p !== ev.toolUseId), ev.toolUseId].filter(Boolean).slice(-PENDING_MAX)
        : (run.pending || []).filter((p) => p !== ev.toolUseId);
      const patch = { pending, lastTs: Math.max(run.lastTs || 0, ts) };
      if (ev.event === 'PreToolUse') {
        patch.tool = ev.tool;
        patch.toolSummary = ev.toolSummary;
      } else if (run.state === 'needs') {
        patch.state = 'running';
      }
      putAgent(row, id, ts, patch);
      if (ev.spawn) applySpawn(row, ev, ts, id);
      wantMeta(row.agents[id]);
      return;
    }
    default:
      return;
  }
}

/** A permission prompt or question inside a run; the session row handles its own needs-you. */
function agentNeeds(row, ev, ts) {
  const run = (row.agents || {})[ev.agentId];
  if (!run || !AGENT_OPEN.has(run.state)) return;
  if (ev.notificationType === 'permission_prompt' && run.state !== 'needs' && !(run.pending || []).length) return;
  putAgent(row, run.id, ts, { state: 'needs', lastTs: Math.max(run.lastTs || 0, ts) });
}

function applyAgentMeta(row, agentId, meta) {
  const run = (row.agents || {})[agentId];
  if (!run) return row;
  // No file yet: metaAsked stays set, so only the run's SubagentStop asks again.
  if (!meta) return row;
  const next = { ...row };
  const patch = { metaDone: true };
  if (meta.description) patch.description = String(meta.description).slice(0, 200);
  if (meta.agentType) patch.type = String(meta.agentType).slice(0, 64);
  if (meta.toolUseId) patch.toolUseId = meta.toolUseId;
  if (meta.parentAgentId) patch.parentAgentId = meta.parentAgentId;
  if (Number.isInteger(meta.spawnDepth) && meta.spawnDepth > 0) patch.depth = meta.spawnDepth;
  if (meta.requestShape) patch.background = meta.requestShape === 'background';
  putAgent(next, agentId, run.lastTs, patch);
  return next;
}

/** Drops runs that finished long ago, stops silent ones, and keeps the newest AGENTS_MAX. */
function tidyAgents(row, now) {
  const runs = Object.values(row.agents || {});
  if (!runs.length) return null;
  let changed = false;
  const next = { ...row };
  for (const run of runs) {
    if (AGENT_OPEN.has(run.state) && row.state !== 'working' && now - (run.lastTs || 0) > AGENT_STALE_MS) {
      finishAgent(next, run.id, now, 'stopped');
      changed = true;
    }
  }
  let kept = Object.values(next.agents).filter((r) => AGENT_OPEN.has(r.state) || now - (r.endedAt || 0) <= AGENT_KEEP_MS);
  if (kept.length > AGENTS_MAX) {
    kept = kept.sort((a, b) => (AGENT_OPEN.has(b.state) - AGENT_OPEN.has(a.state)) || ((b.endedAt || b.lastTs || 0) - (a.endedAt || a.lastTs || 0))).slice(0, AGENTS_MAX);
  }
  if (kept.length !== Object.keys(next.agents).length) {
    next.agents = Object.fromEntries(kept.map((r) => [r.id, r]));
    changed = true;
  }
  return changed ? next : null;
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
  finishAgents(row, ts, 'stopped', () => true);
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
  // A subagent's events run beside the main turn: they describe its run and
  // must not undo the session's done state or count as its latest hook.
  const fromAgent = !!ev.agentId && ev.event !== 'Notification';
  const isNew = !row;
  if (!fromAgent && !isNew && ts < row.lastHookTs - JITTER_MS && ev.event !== 'SessionEnd') return; // replayed or late
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
  row.lastActivity = Math.max(row.lastActivity || 0, ts);
  if (fromAgent) {
    applyAgentEvent(row, ev, ts, effects);
    if (isNew) effects.push({ type: 'new', pid: ev.pid });
    out[key] = row;
    return;
  }
  row.lastHookTs = Math.max(row.lastHookTs, ts);

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
      if (ev.taskNotice && ev.taskNotice.id && NOTICE_STATES[ev.taskNotice.status]) {
        finishAgent(row, ev.taskNotice.id, ts, NOTICE_STATES[ev.taskNotice.status]);
      } else if (!ev.taskNotice && row.state !== 'working') {
        // A prompt typed after the turn ended: a foreground run still open was interrupted.
        finishAgents(row, ts, 'stopped', tiedToTurn(row));
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
      if (ev.spawn) applySpawn(row, ev, ts, undefined);
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
      if (ev.spawn) applySpawn(row, ev, ts, undefined);
      if (!canMove) break;
      // With parallel tool calls another tool can finish while a prompt is up;
      // only the tool that asked clears needs-you.
      if (row.state === 'needs' && row.needsTool && row.needsTool !== ev.tool) break;
      enter(row, 'working', ts);
      break;
    case 'Notification': {
      if (!NEEDS_NOTIFICATIONS.has(ev.notificationType)) break; // idle_prompt and the rest
      if (ev.agentId) agentNeeds(row, ev, ts);
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
      // Runs still open that Claude Code no longer lists as in flight have finished.
      if (Array.isArray(ev.backgroundAgents)) {
        const live = new Set(ev.backgroundAgents);
        for (const id of live) {
          const run = (row.agents || {})[id];
          if (run && run.background !== true) putAgent(row, id, run.lastTs, { background: true });
        }
        finishAgents(row, ts, 'done', (run) => !lineage(row, run).some((r) => live.has(r.id)));
      } else {
        finishAgents(row, ts, 'done', tiedToTurn(row));
      }
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
      finishAgents(row, ts, 'stopped', tiedToTurn(row));
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
        // Idle with no Stop means the turn was interrupted, and its foreground runs with it.
        const tied = tiedToTurn(row);
        finishAgents(row, at, 'stopped', (run) => (run.lastTs || 0) < at && tied(run));
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
    const tidied = tidyAgents(out[key], now);
    if (tidied) out[key] = tidied;
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
    case 'agentMeta': {
      const row = out[String(input.pid)];
      if (row && input.agentId) out[String(input.pid)] = applyAgentMeta(row, input.agentId, input.meta);
      break;
    }
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

/**
 * The session's subagent runs to list, each followed by the runs it started:
 * open runs first in the order they started, then the newest finished. A run
 * with no description yet is left out.
 */
function agentRuns(row) {
  const runs = Object.values(row.agents || {}).filter((r) => r.description);
  const ids = new Set(runs.map((r) => r.id));
  const order = (a, b) => {
    const ao = AGENT_OPEN.has(a.state);
    const bo = AGENT_OPEN.has(b.state);
    if (ao !== bo) return ao ? -1 : 1;
    return ao ? (a.startedAt || 0) - (b.startedAt || 0) : (b.endedAt || 0) - (a.endedAt || 0);
  };
  const children = new Map();
  const roots = [];
  for (const r of runs) {
    const p = r.parentAgentId && r.parentAgentId !== r.id && ids.has(r.parentAgentId) ? r.parentAgentId : null;
    if (!p) roots.push(r);
    else children.set(p, [...(children.get(p) || []), r]);
  }
  const out = [];
  const seen = new Set();
  const walk = (list, depth) => {
    for (const r of [...list].sort(order)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ run: r, depth });
      walk(children.get(r.id) || [], depth + 1);
    }
  };
  walk(roots, 0);
  for (const r of runs) if (!seen.has(r.id)) out.push({ run: r, depth: 0 }); // a parent cycle
  return out;
}

const isAgentOpen = (run) => AGENT_OPEN.has(run.state);

function agentText(run) {
  const d = run.description || '';
  return run.state === 'running' && run.tool ? `${d} · ${run.tool}` : d;
}

/**
 * The right-hand column, which a long description can't push out of sight:
 * elapsed time while running, how it ended and when after.
 */
function agentTime(run, now) {
  const at = (t) => (Number.isFinite(t) ? t : now);
  if (run.state === 'needs') return 'needs you';
  if (run.state === 'running') {
    const s = Math.max(0, Math.round((now - at(run.startedAt)) / 1000));
    return s < 60 ? `${s}s` : ago(s * 1000);
  }
  const t = ago(now - at(run.endedAt));
  const when = t === 'now' ? 'just now' : `${t} ago`;
  if (run.state === 'failed') return `failed ${when}`;
  if (run.state === 'stopped') return `stopped ${when}`;
  return when;
}

/** Drop rows a restarted tray should not resurrect, and alerts it should not repeat. */
function pruneLoaded(sessions, now) {
  const out = {};
  for (const [key, row] of Object.entries(sessions || {})) {
    if (!row || !Number.isInteger(row.pid)) continue;
    if (row.state === 'ended' && now - (row.endedAt || 0) > ENDED_KEEP_MS) continue;
    if (now - (row.lastActivity || 0) > STALE_MS) continue;
    // Meta lookups in flight died with the old tray, so let runs ask again.
    const agents = Object.fromEntries(Object.entries(row.agents || {}).map(([id, run]) => [id, { ...run, metaAsked: false }]));
    out[key] = { ...row, doneAlertDue: undefined, needsAlerted: row.state === 'needs' ? true : row.needsAlerted, pending: row.pending || [], agents, spawns: [] };
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
  agentRuns,
  agentText,
  agentTime,
  isAgentOpen,
  pruneLoaded,
  URGENCY,
  NEEDS_FALLBACK_MS,
  DONE_DELAY_MS,
  ENDED_KEEP_MS,
  AGENT_KEEP_MS,
  AGENT_STALE_MS,
  AGENTS_MAX,
};
