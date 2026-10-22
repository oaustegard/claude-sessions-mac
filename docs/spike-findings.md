> These notes come from the original Windows app ([drknowhow/claude-sessions](https://github.com/drknowhow/claude-sessions)) and were measured on Windows 11. The hook payloads and timings carry over to macOS; the process and window sections do not.

# Phase 0 spike findings (2026-10-19)

A log-only hook (`spike/log-hook.js`) was registered for every event in
`~/.claude/settings.json`, and throwaway sessions ran in classic console
windows. The hook was removed afterwards and the settings file compared equal
to its backup.

## Hooks
- Hooks added to `~/.claude/settings.json` take effect in sessions that are
  already running, within seconds. No restart needed.
- With the args form (`command: <node.exe>, args: [script]`) there is no shell
  in between, so `process.ppid` inside the hook is the `claude.exe` PID.
  `CLAUDE_PID` is also set in the hook's environment.
- `CLAUDE_CODE_ENTRYPOINT` and the other `CLAUDE_*` variables are inherited
  from any parent Claude process. A `claude` started from a shell that the
  desktop app spawned reports `claude-desktop`. The registry `entrypoint` is
  the reliable source.
- A node spawn for an empty hook costs about 53 ms wall time (10 runs, 42-86).
  The hooks are `async`, so the session does not wait on it. PreToolUse and
  PostToolUse stay on node; no http or curl fallback needed.
- A TCP connect to a closed port on 127.0.0.1 takes about 1 s on Windows
  (refused connections are retried). The reporter's 500 ms timeout bounds it.
- Not tested: whether an `http` hook stays quiet when the tray is down.
  Not needed, since the reporter stays a command hook.

## Event sequences seen
| Situation | Events, in order |
|---|---|
| Short prompt | UserPromptSubmit, Stop (2 s later), Notification `idle_prompt` (63 s after Stop) |
| Bash permission prompt (`--permission-mode default`) | PreToolUse + PermissionRequest (same second), Notification `permission_prompt` "Claude needs your permission" (about 6 s later) |
| AskUserQuestion (even in `bypassPermissions`) | PreToolUse `AskUserQuestion` + PermissionRequest `AskUserQuestion` (same second), Notification `permission_prompt` (6 s later) |
| Console window closed | SessionEnd `reason: "other"` within about 1 s; registry file removed |
| `taskkill /F` on claude.exe | No SessionEnd. The registry file stayed, then was gone about 2 min later (probably swept by another Claude process; cause not confirmed) |

Payload fields beyond the common `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `effort`:
- SessionStart: `source` (`startup`), `model`
- UserPromptSubmit: `prompt`
- PreToolUse: `tool_name`, `tool_input`, `tool_use_id`
- PostToolUse: the same plus `tool_response`, `duration_ms`
- PermissionRequest: `tool_name`, `tool_input`, `permission_suggestions`
- Notification: `message`, `notification_type`
- Stop: `stop_hook_active`, `last_assistant_message`, `background_tasks` (array), `session_crons`
- SessionEnd: `reason`

No payload carries a session title.

## Session registry (`~/.claude/sessions/<pid>.json`)
- `status` is `idle`, `busy` or `waiting`. `waiting` is set while a
  permission prompt or AskUserQuestion is pending.
- Keys: `pid`, `sessionId`, `cwd`, `startedAt` (epoch ms), `procStart`
  (Windows FILETIME, matches CIM creation time to within about 10 ticks),
  `version`, `kind`, `entrypoint` (`cli`, `claude-desktop`, `sdk-cli`,
  `sdk-py`), `name`, `nameSource`, `status`, `statusUpdatedAt`, `updatedAt`.
- `name` for CLI sessions is derived from the folder plus a hash
  (`shop-3fa`) unless the user renamed the session; desktop sessions
  carry their real title. Show `name` only when `nameSource` is not `derived`.
- `<pid>.<hash>.key` sidecar files sit in the same folder. Never open them.

## Processes and windows
- Terminal CLI: `claude.exe` <- `cmd.exe` <- `WindowsTerminal.exe`.
  Desktop: `claude` <- `claude` <- `sihost`. SDK (Python): `claude` <- `python`.
  Remote Control bridge: `claude` <- `claude` <- `powershell` <- `wscript`.
- A classic console window is owned by the shell's PID (`cmd.exe`) as far as
  `GetWindowThreadProcessId` is concerned; `conhost.exe` has
  `MainWindowHandle` 0. Focus code must look for top-level windows owned by
  any ancestor of `claude.exe`.
- Claude sets the terminal title to a glyph plus the session title:
  `✳` idle or waiting, `◐` busy. Windows Terminal's window title is the
  active tab's title, which could help a later exact-tab match.

## Design changes from the first plan
1. Needs-you is entered on registry `waiting`, on PreToolUse for
   `AskUserQuestion` or `ExitPlanMode`, or on a `permission_prompt` /
   elicitation Notification. It clears when the registry leaves `waiting`
   with a newer timestamp, or on PostToolUse, UserPromptSubmit or Stop.
   (The plan cleared it only on the next PreToolUse, which leaves the row
   amber after the last tool of a turn is approved.)
2. The needs-you sound and toast fire on the Notification, about 6 s after
   the prompt appears. Claude Code waits those 6 s itself, so a prompt you
   answer at once never alerts. A fallback alerts if a session stays in
   needs-you for 12 s with no Notification.
3. The done alert waits 1.5 s after Stop and is dropped if the session starts
   working again, so a Stop hook that forces a continuation does not alert.
4. Rows are keyed by `claude` PID, not `session_id`: `/clear` and `--resume`
   change the session id while the tab stays the same.
5. Liveness uses `process.kill(pid, 0)` every 15 s; it catches a hard-killed
   session before Claude sweeps its registry file. The `procStart` check
   against PID reuse moves to phase 3.
6. The hook installer copies the reporter to
   `%LOCALAPPDATA%\ClaudeSessions\reporter\report.js` and points the hooks
   there, since node cannot run a script from inside the packaged app's asar.
