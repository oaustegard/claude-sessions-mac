# Claude Sessions for macOS

A menu bar app for people who run several Claude Code sessions at once. It
tells you when a session finishes or is waiting for you, and gives each
project its own sound so you know which one it was without looking.

This is a macOS port of [drknowhow/claude-sessions](https://github.com/drknowhow/claude-sessions),
a Windows tray app by Dr. Know How. The session tracking, the popup, the
sounds and the hooks are that project's code; the process, window, path and
packaging layers were rewritten for macOS.

Claude Sessions is an unofficial tool. It is not affiliated with or endorsed by Anthropic.

## What it does

- A notification and the session's sound when a session finishes a turn,
  when it is waiting for you (a permission prompt or a question), and when a
  turn fails.
- One menu bar icon whose colour is the most urgent session: amber needs
  you, red failed, green finished, blue working.
- A popup listing every terminal session with its project, branch, first
  prompt and state.
- Clicking a session's row, its menu line or its notification brings its
  terminal to the front. In Terminal and iTerm2 it also selects the
  session's tab.

Everything stays on your Mac. The hooks talk to the app over `127.0.0.1`
with a token, and nothing is sent anywhere else.

## Install

You need:

- macOS 11 or later, on Apple Silicon or Intel.
- [Claude Code](https://github.com/anthropics/claude-code), run in a terminal.
- [Node.js](https://nodejs.org/). The hooks run a small Node script. The app
  looks for `node` in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`,
  then asks your login shell, which covers nvm and similar.

Build the app from source (there is no signed release yet):

```bash
npm install
```

```bash
npm run dist
```

Then open `dist/Claude Sessions-<version>-arm64.dmg` (or `-x64` on Intel)
and drag the app to Applications. The app is signed ad hoc, not with a
Developer ID, so the first open is blocked: right-click the app, choose
**Open**, then **Open** again. On recent macOS you may instead have to allow
it under System Settings, Privacy & Security.

Then:

1. The menu bar icon starts as a gray square with `!`, which means the hooks
   are not installed yet. Right-click it and choose **Install hooks into
   Claude Code**. Sessions that are already running pick up the hooks
   without a restart.
2. Turn on **Start at login** in the same menu if you want the app to start
   when you log in. It is off until you turn it on.
3. The first time you click a session that runs in Terminal or iTerm2,
   macOS asks whether Claude Sessions may control that app. Allow it so the
   app can select the session's tab. If you decline, the app still comes
   forward; you can change the answer later in System Settings, Privacy &
   Security, Automation.

To uninstall, remove the hooks and turn off Start at login from the menu,
quit, and delete the app. Its data is in
`~/Library/Application Support/ClaudeSessions`.

## The icon

- Gray ring: no sessions.
- Dot: no alerts. Blue while a session is working, gray when all are idle.
- Square with a number: the most urgent colour wins. Amber means a session
  needs you, red means a turn failed, green means a session finished and you
  have not seen it. The number counts those sessions.
- Gray square with `!`: the hooks are not installed.

Hovering over the icon opens the popup after 250 ms, and it closes 300 ms
after the pointer leaves. Clicking pins it open so you can rename a session
or pick a sound; click the icon again, press Esc or click elsewhere to close
it.

Right-click (or Control-click) opens the menu: one line per session, Do not
disturb, a toggle for desktop-app and SDK sessions, Start at login, install
or remove hooks, the data folder, and quit. Opening the menu marks finished
sessions as seen.

## The popup

The popup is 320 pt wide and follows the system light or dark appearance.

- The header has the session counts, a bell for Do not disturb (30 minutes,
  1 hour, until 08:00, off) and a gear for settings: volume, the desktop and
  SDK toggle, Start at login, and the data folder.
- Rows are sorted most urgent first: needs you, failed, finished, working,
  idle. The three most recently ended sessions follow, dimmed.
- Each row has a status dot, "project · branch" (or "project · alias" once
  you rename it), the session's name or first prompt, and a state line such
  as "Needs permission: Bash · 1m", "Done 2m ago" or "Working 6m · Edit".
- The sound chip shows the row's sound. The speaker mutes or unmutes the
  session, the name opens the sound picker, and ▶ plays the sound.
- The expand button brings the session's terminal forward, and ⋯ opens
  Rename… and Forget. Pointing at a row also shows buttons that copy its
  resume command (`claude --resume <id>`) and open its folder in Finder.

## Sounds

- Built-in: eight tones synthesized in the app (marimba, bell, wood, blip,
  chirp, pluck, glass, low horn). They need no files.
- macOS: the system alert sounds in `/System/Library/Sounds` (Basso, Glass,
  Tink and the rest). Chromium cannot decode AIFF, so the app converts each
  one to WAV with `afconvert` the first time it starts and keeps the copies
  in its data folder.
- Custom: "Add sound…" in the picker copies a `.wav`, `.mp3`, `.ogg`, `.m4a`
  or `.aiff` file into the data folder's `sounds` directory.

Each new project gets the next built-in sound no other project uses, and
keeps it. A finished turn plays the sound once; a session that needs you
plays it twice. Notifications are silent, so macOS adds no sound of its own.
Muting a session or turning on Do not disturb stops both its sound and its
notification; the icon and the popup still update.

Notifications appear only if macOS allows them for Claude Sessions (System
Settings, Notifications). A Focus mode can hide them too.

## How it works

- Hooks in `~/.claude/settings.json` run `reporter/report.js` on
  SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification,
  Stop, StopFailure and SessionEnd. They are `async`, so a session never
  waits for them.
- The reporter posts each event to the app on `127.0.0.1`, with the port and
  a per-run token from `server.json`. When the app is not running it appends
  the event to `spool.jsonl`, which the app reads at start and every 15
  seconds.
- The app also watches `~/.claude/sessions/<pid>.json`, the file Claude Code
  keeps for each running process, so sessions started before the hooks were
  installed still show up.
- Every 15 seconds the app checks that each session's process is alive. A
  live PID whose start time (`ps -o lstart`) differs from the `procStart`
  Claude Code recorded is a new program that reused the PID, so that session
  ends too.
- To bring a session forward, the app walks up from its `claude` process
  with `ps` to the first ancestor inside an `.app` bundle (Terminal, iTerm2,
  Ghostty, WezTerm, VS Code, Cursor, and so on). For Terminal and iTerm2 it
  runs a short AppleScript that finds the tab whose tty matches the
  session's and selects it. For any other app it runs `open -a`, which
  brings the app forward without picking a window.

## Hooks

Install, remove or check the hooks from the menu, or from a terminal in a
source checkout with `node hooks-install.js install`, `uninstall` or
`status`.

The installer copies the reporter to
`~/Library/Application Support/ClaudeSessions/reporter/` and runs it with an
absolute `node` path, backs up `settings.json` before each write, writes
nothing if the file does not parse or changes while it works, and touches
only hook entries whose path contains `claudesessions/reporter/report.js`.

Claude Code can also raise its own notification (`preferredNotifChannel` in
its `/config`). If one event gives you two alerts, turn that one off.

## Files

`~/Library/Application Support/ClaudeSessions/` holds `server.json` (port
and token), `spool.jsonl`, `state.json`, `config.json`, `tray.log`, the
reporter copy, `sounds/` and `system-sounds/`.

## Build from source

`npm start` runs the app from the checkout. `npm run dist` builds a DMG and
a zip for arm64 and x64 in `dist/`, signed ad hoc by
`scripts/adhoc-sign.js`. `npm run icon` draws `build/icon.png` from the
brand mark in `scripts/brand-mark.js`.

`npx electron scripts/render-popup.js [folder]` draws the popup with made-up
sessions, in light and dark, to PNG files.

## Tests

`npm test` runs the unit tests under plain Node; CI runs them on macOS for
every push and pull request.

## Known gaps

- Only Terminal and iTerm2 get their tab selected. Other terminals come
  forward as a whole app, showing whichever window was last in front.
- Sessions over ssh or in a container have no app on this Mac to bring
  forward; clicking one marks it seen.
- Claude desktop-app sessions bring the Claude app forward.
- An idle session's time counts from when the app first saw it, not from its
  last turn.
- `/clear` starts a new session id, so the session loses its alias, its own
  sound and its mute.
- The app is not notarized.

## License

MIT, as the original. See [LICENSE](LICENSE).

"Claude" and "Claude Code" are trademarks of Anthropic.
