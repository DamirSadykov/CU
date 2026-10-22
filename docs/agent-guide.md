# CU — guide for an agent helping a user

You were asked to explain CU or help someone set it up. Answer in the user's
language. `<cli>` below is the CU command line the session hook printed
(`node "<install dir>/scripts/cli.mjs"`).

## What CU is

A Windows tray app. It shows Claude usage limits in real time, forecasts when
they run out, keeps local Claude Code and Codex analytics, and runs a task
board that Claude Code sessions read and update through `<cli>`.

Windows:

- **Tray flyout** — click the tray icon: session and weekly limits, forecast,
  gear to Settings. Can be pinned open.
- **Mini** — small always-on-top widget with the same limits, optional CPU/RAM.
- **Tasks** — task tree (project → plan → task), task cards with a status
  switch, plans, project overview.
- **Settings** — tabs listed below.
- **Analytics** — token, cost and efficiency history; opt-in.

## How to answer and when to open a window

1. Answer "where is X" in text first: the path in the UI, e.g.
   *Settings → Notifications → Quiet hours*.
2. Open a window only when the user asks for it ("open it", "show me").
   Offer it instead: end with "open it?". One yes opens one window.
3. To open: `<cli> open <route>`. It brings the running app to that screen
   without a second window. `<cli> open <route> --print` prints the
   `cu://` link without opening anything; give that link when the user wants
   to click it themselves.
4. `cu:// scheme not registered` means CU is not installed on this machine
   (or is a dev build). Say so; do not retry.

## Routes

| Route | Opens |
|---|---|
| `cu://settings` | Settings, first tab |
| `cu://settings/<tab>` | Settings on that tab |
| `cu://tasks` | Tasks window |
| `cu://tasks/<number>` | Tasks window with the card of task t#<number> |
| `cu://analytics` | Analytics window |

## Where things are

| Route | Tab | What lives there |
|---|---|---|
| `cu://settings/account` | Account | appearance (theme, skin), language, auto-start session after reset, system info in mini, keep Windows awake during AI work |
| `cu://settings/providers` | Providers | Claude session key and org ID, refresh interval; install the Claude Code CLI + hook and the Codex CLI hook |
| `cu://settings/limits` | Limits | colour thresholds (yellow / orange / red) for the session and weekly limits |
| `cu://settings/notifications` | Alerts | limit notifications, quiet hours, Claude service status, task notifications, memory-bloat alert |
| `cu://settings/budget` | Budget | Claude Code & Codex analytics switch (enables the Analytics window), user-corrections metric, daily budget |
| `cu://settings/insights` | Insights | optimisation tips during an active Claude Code session (beta) |
| `cu://settings/tasks` | Tasks | responsibility → model mapper, task context in sessions, role workflow at session start, auto runner, spec registry |
| `cu://settings/integrations` | Integrations | read-only mirror of an external task tracker (enrollment) |
| `cu://settings/updates` | Updates | check for updates, check interval, restart to update, open the log folder |

Per-project checks (flow check, mutation check, languages) live in the Tasks
window: open a project's overview from the board, section *Checks*.

## First steps for a new user

1. *Providers*: paste the Claude session key; limits appear in the tray.
2. *Providers*: install the Claude Code CLI + hook. From then on every Claude
   Code session starts with the task board and the CLI contract in context.
3. *Budget*: turn on analytics if the user wants cost and token history.
4. Add a first task from the Tasks window, or ask the agent:
   `<cli> todos add "<subject>"`.

## Task board from the CLI

- `<cli> todos list` — the board; `<cli> todos --help` — every command.
- `<cli> todos set status <id> queue|in_progress|review|done`.
- `<cli> plan list` / `<cli> plan show <id>` — plans and their steps.
- Never hand-edit `todos.json`; go through `<cli>`.

## Common problems

- **Limits do not load / "key expired"** on a 403: often a Cloudflare challenge,
  not an expired key. Check the log (*Updates → open log*) for `verdict=`
  before telling the user to replace the key.
- **Session does not see tasks**: the hook is not installed or points at an
  old path — reinstall it on *Providers*.
- **Analytics window is empty**: analytics is off — *Budget*.
