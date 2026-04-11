# superpowerd

Multi-account Claude Code workspace manager. Automatic rate limit detection, seamless account rotation, WezTerm multi-repo pane grid, and a real-time web dashboard. Works on macOS and Linux.

![Overview](screenshots/overview.png)

![History](screenshots/history.png)

![Insights](screenshots/insights.png)

## The problem

Claude Code's Max plan has usage limits. When you hit them, you wait. If you have multiple accounts, you can rotate between them — but doing it manually means logging out of claude.ai, switching Google accounts, re-authenticating the CLI, and repeating across every terminal. Superpowerd automates all of that.

## What it does

**Account rotation** — Detects rate limits from Claude's session logs and automatically rotates to the next account. Captures each account's OAuth tokens once up front, then rotates by swapping the Keychain entry — no browser, no re-auth, no `/login` prompt. Every Claude pane in your WezTerm grid, tmux server, **or** iTerm2 windows is exited and restarted with `--resume <session-id>` so you pick up exactly where you left off; all three muxes can coexist and get handled in the same rotation. Manual rotation is a single command. Without any mux, rotation still swaps the Keychain — you just restart any running `claude` processes yourself to pick up the new credentials.

**Token capture** — Run `npm run tokens:capture` (or `node rotation/tokens.js capture-all`) once to authenticate each account in `accounts.conf`. Each login writes the OAuth tokens into `data/tokens.json` keyed by email, alongside the org ID. After that, rotation is a pure Keychain swap — no browser automation needed.

**WezTerm workspace** — Reads `repos.conf` and opens a 2-column grid of terminal panes, one per repo, each running Claude Code. Pane titles show `repo · branch * · PR #123` in real-time. Global shortcuts let you jump to any pane, open/create PRs, or restart Claude.

**Dashboard** — React/TypeScript web UI at `localhost:3848` with three pages. **Overview** shows active sessions, messages, tokens, tool calls, 429 count, token TTL, account list with one-click rotation, CLI auth with lifetime stats, pool utilization bars, per-session cost breakdown by repo, activity sparklines, and a filterable live log stream. **History** shows daily cost and cumulative cost charts, daily and monthly prompt counts, a day-by-hour activity heatmap, cost by model and repo breakdowns, tool usage rankings, and streak/record stats. **Insights** profiles your coding rhythm — chronotype (Night Owl / Early Bird / Evening Coder / Afternoon Focused), peak hour, longest streak, time-of-day and day-of-week distributions, cost profile, and scale stats.

**OAuth recovery** — A custom Claude Code slash command (`/auto-updater`) that walks through diagnosis and repair when the auth flow breaks.

## Quick start

```bash
git clone git@github.com:abnegate/superpowerd.git ~/Local/superpowerd
cd ~/Local/superpowerd
bash setup.sh
```

The setup script:
1. Installs Homebrew, git, gh, Node.js, tmux, mosh, Claude Code, WezTerm, Fira Code Nerd Font, and skhd
2. Copies `.example` config files so you can edit your local copies
3. Clones every repo listed in `repos.conf` into `$SUPERPOWERD_WORKSPACE` (default `~/Local`)
4. Installs the WezTerm config, tmux config, pane-title shell hook, and skhd service
5. Installs Node dependencies (Playwright's Chromium is fetched by the postinstall hook)
6. Builds the dashboard and indexes historical sessions
7. Symlinks every `commands/*.md` slash command into `~/.claude/commands/`
8. Registers a `SessionStart` hook that captures OAuth tokens each time Claude starts
9. Installs the `monitor` and `dashboard` launchd agents (or systemd user units on Linux)
10. Adds `sp-rotate`, `sp-monitor`, `sp-update`, `sp-dashboard`, `sp-agent`, `sp-session`, and `sp-list` aliases to `.zshrc`

After setup, run `npm run tokens:capture` to log into each account once, then restart WezTerm to activate the pane grid.

## Configuration

Three config files in the project root. All are `.gitignore`d — edit your copies freely. The `.example` files are tracked as templates.

### accounts.conf

One Claude account email per line. Accounts rotate in order.

```
alice@company.com
alice.personal@gmail.com
alice.backup@gmail.com
```

Run `npm run tokens:capture` once to authenticate each account and cache its OAuth tokens in `data/tokens.json`. After that, rotation swaps Keychain entries in-place — no browser round-trip required.

### repos.conf

One repo per line. Format: `directory=org/repo`

```
myapp=myorg/myapp
backend=myorg/backend
frontend=myorg/frontend
```

`directory` is the folder name under `~/Local/`. `org/repo` is the GitHub slug used for cloning. Setup clones any repos that don't exist locally. A local shell pane is always added at the end of the grid.

### shortcuts.conf

Keyboard shortcuts for pane focus. Format: `directory=key`

```
myapp=m
backend=b
frontend=f
```

Each entry maps a repo name to `Opt+Cmd+<key>`. The local pane is always `Opt+Cmd+L`. If a repo has no entry, the first letter of its name is used.

## Usage

### Manual rotation

```bash
sp-rotate                             # Rotate to next account
sp-rotate alice.backup@gmail.com      # Switch to specific account
sp-rotate --status                    # Show current account and CLI auth state
sp-rotate --dry-run                   # Simulate a rotation without touching
                                      # anything — prints the pane mapping, the
                                      # candidate account, and every mutation it
                                      # would perform. Combine with an email to
                                      # dry-run a targeted switch.
SUPERPOWERD_ROTATE_GRACE=0 sp-rotate  # Skip the 10-second banner+sleep that
                                      # normally fires before the keychain swap
SUPERPOWERD_ROTATE_GRACE=60 sp-rotate # Give yourself a 60-second grace window
                                      # to Ctrl-C if anything looks wrong
```

What happens during rotation:
1. A lockfile is acquired so concurrent rotations can't race each other
2. The current account's OAuth tokens are re-captured via `tokens.js capture` (keeps the stored bundle fresh) and the dashboard's usage snapshot is refreshed
3. Every WezTerm pane, tmux pane, **and** iTerm2 session is mapped from pane → TTY → `claude` PID → Claude session ID. All three muxes are queried independently; rotation works with any combination installed. iTerm2 discovery is macOS-only and goes through AppleScript/`osascript`, guarded by a `System Events` check so probing for iTerm2 never accidentally launches it.
4. Accounts without stored tokens are skipped; the next account with tokens is chosen
5. **Grace period** — a desktop banner fires ("Rotating to *email* in 10s — *N* pane(s) will restart") and rotate sleeps for `SUPERPOWERD_ROTATE_GRACE` seconds (default 10, set to 0 to skip). This is the last point before anything destructive happens. Ctrl-C during the sleep aborts the rotation with zero side effects — the EXIT trap releases the lock, and tokens/state/keychain are all still untouched.
6. `tokens.js swap` rewrites the `Claude Code-credentials` Keychain entry in place, preserving any MCP OAuth tokens that live alongside it
7. `data/state.json` is updated with the new index, email, and timestamp
8. Each mapped pane receives `/exit` to quit Claude cleanly; stragglers are force-killed by PID after a 3-second wait (the PID came from Step 3, so no re-lookup is needed)
9. Each pane is restarted with `claude --dangerously-skip-permissions --resume <session-id>`, so you drop back into the exact conversation you were in. WezTerm panes are driven via `wezterm cli send-text`; tmux panes via `tmux send-keys -l`; iTerm2 sessions via AppleScript `tell session to write text "..."`.
10. A "continue where you left off" nudge is sent to every restarted pane
11. A macOS notification (or `notify-send` on Linux) confirms the switch

If no mux is reachable at all (no WezTerm GUI, no tmux server, no iTerm2 process), rotation still performs steps 1–7 (plus the grace period) and exits cleanly — it logs "No Claude sessions found in WezTerm, tmux, or iTerm2 panes" and skips 8–10. Your `claude` process keeps running on its cached in-memory tokens until you restart it manually, at which point it picks up the swapped Keychain entry.

**iTerm2 first-run caveat** — iTerm2 automation is gated by macOS TCC (Privacy & Security → Automation). The first time rotate sends keystrokes to iTerm2, macOS prompts to authorize the controlling process. **Run `sp-rotate --dry-run` from an interactive Terminal/iTerm2 session once and approve the prompt before relying on the monitor daemon** — launchd-spawned processes don't have a UI to present the dialog, so a denied/unanswered first prompt will silently cause the iTerm2 branch to fail under the daemon (rotation will still Keychain-swap, just skip the pane restart).

### Automatic rotation

```bash
sp-monitor --daemon    # Start background watcher
sp-monitor --stop      # Stop it
sp-monitor --status    # Check if running
```

Setup also installs a launchd agent (`com.superpowerd.monitor`) / systemd user unit (`superpowerd-monitor`) that keeps the monitor running across reboots, so the `--daemon` flag is only needed for one-off foreground runs.

The monitor tails every `~/.claude/projects/**/*.jsonl` file modified in the last 30 minutes and watches for rate-limit signals:
- `"isApiErrorMessage":true` entries containing "hit your limit", "rate limit", "limit reached", or "exceeded"
- Watchers refresh every 60 seconds to pick up new sessions and replace any that died

When a signal is detected, `sp-rotate` runs with a 5-minute cooldown between rotations.

### Agent switching

```bash
sp-agent          # Show current agent (defaults to claude)
sp-agent codex    # Switch to Codex CLI
sp-agent claude   # Switch back to Claude Code
```

The preference persists in `~/.config/superpowerd/agent` and is read by WezTerm on startup. After switching, restart WezTerm for all panes to launch the new agent. The `Opt+Cmd+R` restart shortcut also respects the current choice.

### Dashboard

```bash
sp-dashboard    # http://localhost:3848
```

**Overview** page:
- Metrics bar: active sessions, messages, tokens, tool calls, 429 count, token TTL
- Account list with active indicator, per-account "Switch" buttons, and "Rotate Next"
- CLI auth status: email, plan, org, and lifetime totals (sessions, messages, cost)
- Pool utilization: 5-hour and 7-day usage bars per account with reset countdown
- Active sessions table: per-session cost breakdown by repo, messages, output tokens, cache
- Activity sparklines: 7/14/30-day message and token trends
- Monitor start/stop controls
- Live log stream via SSE with filters (all, rotations, limits, errors)

**History** page:
- Daily cost bar chart (14/30/90/all day ranges) with average and total
- Cumulative cost area chart
- Daily and monthly prompt counts
- Day-by-hour activity heatmap spanning all recorded history
- Cost by model table with output tokens, cache reads, and cost columns
- Top 15 tool usage breakdown
- Cost by repo horizontal bar chart and detailed repo table
- Records: longest session, duration, speculation savings
- Streak stats: current and longest active-day streaks

**Insights** page:
- Top metrics: chronotype (*Night Owl* / *Early Bird* / *Evening Coder* / *Afternoon Focused*), prompts/day, tools/prompt, cost/prompt, current streak
- Work pattern: peak hour, peak day, weekend work %, late-night %, longest streak
- Cost profile: total API value, per-day / per-prompt cost, biggest-spend day, cache read ratio
- Time-of-day distribution bar (late night / morning / afternoon / evening)
- Day-of-week activity bar chart
- Coding DNA: repos worked on, top repo, favorite tool, total tool calls, one-liner %
- Scale: first session date, total prompts, active days, total sessions, total messages

For development, run the Vite dev server and API server separately:

```bash
cd dashboard
npm run dev      # Frontend at :3847 (proxies /api to :3848)
npm run serve    # API server at :3848
```

### WezTerm shortcuts

| Shortcut | Action |
|----------|--------|
| `Opt+Cmd+` `` ` `` | Toggle WezTerm visibility (via skhd) |
| `Opt+Cmd+<key>` | Focus repo pane (from `shortcuts.conf`) |
| `Opt+Cmd+L` | Focus local shell pane |
| `Opt+Cmd+P` | Open current repo's PR in browser |
| `Opt+Cmd+N` | Push branch and open GitHub "compare" page |
| `Opt+Cmd+R` | Kill and restart Claude in current pane |
| `Opt+Cmd+Down` | Add a row of 2 local panes at the bottom |

Standard macOS text editing shortcuts (Opt+arrows for word nav, Cmd+arrows for line start/end, Opt+Backspace for word delete) are also configured.

### OAuth recovery

If rotation fails — a stored refresh token got revoked, the Keychain entry is missing, the CLI is stuck on the wrong account, or a pane won't come back up — use the Claude Code slash command:

```
/auto-updater
```

It walks through diagnosing the CLI's auth state, the contents of `data/state.json` / `data/tokens.json`, the rotation log, and stepping you through a CLI auth reset, a targeted re-capture (`node rotation/tokens.js capture-all`), or the Playwright fallback in `rotation/browser-auth.js`.

## How token rotation works

Claude Code stores its OAuth credentials in a single macOS Keychain item named `Claude Code-credentials` (a JSON blob containing access token, refresh token, expiry, scopes, subscription type, and rate-limit tier under the `claudeAiOauth` key). `tokens.js` uses the `security` CLI to read that blob, splice in a different account's `claudeAiOauth` subtree, and write it back. Any MCP OAuth tokens stored alongside it in the same blob are preserved.

This means rotation is effectively an atomic Keychain swap — no browser, no `claude auth login`, no redirect URLs. The only prerequisite is that every account has already been authenticated once (via `npm run tokens:capture`) so its token bundle lives in `data/tokens.json`. Each bundle also caches the org ID, looked up from `https://api.anthropic.com/api/oauth/claude_cli/roles` at capture time.

A `SessionStart` hook (`rotation/capture-hook`) is registered in `~/.claude/settings.json` so that every time Claude starts, the current account's tokens are re-captured in the background. That keeps `data/tokens.json` fresh as Claude refreshes its access token, so swaps never install a stale bundle.

## Legacy: browser-driven login (`browser-auth.js`)

`rotation/browser-auth.js` is kept for the rare case where the Keychain swap flow fails (e.g. the stored refresh token has been revoked) and you need to re-authenticate through Google via Playwright. It imports cookies from Firefox (`cookies.sqlite`) or Chrome (decrypting via `Chrome Safe Storage` in the macOS Keychain, PBKDF2/`saltysalt`/1003 iterations/AES-128-CBC), drives the claude.ai sign-in flow, intercepts the `claude auth login` OAuth URL via a `BROWSER` trap script, and completes the callback. None of this runs during normal rotation. Trigger it manually with `node rotation/browser-auth.js login <email>` or seed cookies with `npm run browser:setup`.

## Project structure

```
superpowerd/
├── setup.sh                         # Bootstrap installer
├── package.json                     # Root deps (Playwright)
├── accounts.conf.example            # Template: Claude accounts
├── repos.conf.example               # Template: repos to open
├── shortcuts.conf.example           # Template: pane focus keys
│
├── wezterm/
│   ├── wezterm.lua                  # WezTerm config
│   │                                  Reads repos.conf + shortcuts.conf
│   │                                  Dynamic 2-column grid with tuned split ratios
│   │                                  Status bar: repo · branch · PR
│   │                                  Auto-generates skhd config on startup
│   └── pane-title.zsh               # Shell precmd hook
│                                      Updates pane titles with branch + PR info
│                                      Async PR lookup via gh, cached 5 min
│                                      Bell on commands longer than 10s
│
├── rotation/
│   ├── rotate                       # Account rotation (bash)
│   │                                  Round-robin or targeted rotation
│   │                                  Lockfile guards against concurrent rotations
│   │                                  Swaps Keychain via tokens.js, restarts panes with --resume
│   │                                  Mux-agnostic: drives WezTerm, tmux, and iTerm2
│   │                                    via a tiny abstraction (iTerm2 uses AppleScript)
│   │                                  Works with none installed (Keychain swap only)
│   │                                  --dry-run flag for safe flow verification
│   │                                  Desktop notifications (macOS + Linux)
│   ├── monitor                      # Rate limit watcher daemon (bash)
│   │                                  Tails ~/.claude/projects/**/*.jsonl
│   │                                  Matches "isApiErrorMessage":true + limit keywords
│   │                                  5-minute cooldown between rotations
│   │                                  Refreshes watchers every 60s as sessions come and go
│   ├── tokens.js                    # OAuth token store + Keychain swap
│   │                                  capture / capture-all / swap / list / status
│   │                                  Preserves MCP OAuth subtree on swap
│   ├── capture-hook                 # SessionStart hook — re-captures tokens on launch
│   ├── index-sessions.js            # Maps Claude sessions to repos and costs
│   ├── update                       # Self-update: git pull, rebuild, restart services
│   └── browser-auth.js              # Legacy Playwright fallback (cookie import + OAuth trap)
│
├── dashboard/
│   ├── server.ts                    # Express API server
│   │                                  GET  /api/status           — accounts, current, monitor
│   │                                  GET  /api/auth             — claude auth status
│   │                                  GET  /api/usage            — today's stats, totals, token expiry
│   │                                  GET  /api/claude-usage     — pool utilization per account
│   │                                  GET  /api/sessions         — active sessions with cost
│   │                                  GET  /api/history          — daily costs, per-repo breakdown
│   │                                  GET  /api/history-extended — prompts, heatmap, streaks, hourly
│   │                                  GET  /api/tools            — top tool usage
│   │                                  GET  /api/update/check     — check for superpowerd updates
│   │                                  POST /api/update           — trigger `sp-update`
│   │                                  POST /api/rotate           — trigger rotation
│   │                                  POST /api/monitor/{start,stop} — monitor control
│   │                                  GET  /api/logs             — SSE log stream
│   ├── vite.config.ts               # Vite + React + proxy
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                  # Router + state management (React 19)
│   │   ├── index.css                # Dark theme matching WezTerm
│   │   ├── pages/
│   │   │   ├── Overview.tsx         # Accounts, auth, sessions, activity, logs
│   │   │   ├── History.tsx          # Cost charts, heatmap, tool usage, repos
│   │   │   └── Insights.tsx         # Chronotype, peak hour, time/day distributions
│   │   └── components/
│   │       ├── Sidebar.tsx          # Navigation with status indicator (3 tabs)
│   │       ├── Charts.tsx           # Sparkline, BarChart, AreaChart, tooltips
│   │       └── UsageBar.tsx         # Pool utilization bar with countdown
│   └── dist/                        # Built assets (served by Express)
│
├── commands/
│   └── auto-updater.md              # Claude Code slash command
│                                      OAuth diagnosis + recovery procedures
│
├── screenshots/                     # Dashboard screenshots for README
│
└── data/                            # Runtime state (gitignored)
    ├── state.json                   # Current account index + timestamp
    ├── session-index.json           # Session-to-repo cost mapping
    ├── tokens.json                  # OAuth tokens per account
    ├── usage-history.json           # Usage burn rate tracking
    ├── usage-snapshots.json         # Last-known usage per account
    ├── monitor.pid                  # Monitor daemon PID
    ├── monitor.log                  # Monitor log (launchd/systemd stdout+stderr)
    ├── dashboard.log                # Dashboard log (launchd/systemd stdout+stderr)
    ├── rotate.log                   # Rotation log
    └── browser/                     # Playwright persistent profile
```

## Requirements

- macOS or Linux
- Node.js 20+
- Claude Code CLI (`claude`) — installed by `setup.sh`
- GitHub CLI (`gh`) — authenticated
- `sqlite3` (used by the legacy `browser-auth.js` cookie importer)
- macOS Keychain holds the `Claude Code-credentials` entry that rotation swaps; on Linux, the CLI's credential store is used instead
- Playwright installs its own Chromium automatically (only exercised by `browser-auth.js` fallbacks)
- skhd (macOS only, for global hotkeys — installed by `setup.sh`)

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERPOWERD_HOME` | `~/Local/superpowerd` | Project root, used by wezterm.lua and shell aliases |
| `SUPERPOWERD_WORKSPACE` | `~/Local` | Directory where repos are cloned |
| `SUPERPOWERD_ROTATE_GRACE` | `10` | Seconds to wait (with a banner notification) between pane mapping and the keychain swap in `rotation/rotate`. Set to `0` to skip the grace period and rotate immediately. |
| `PORT` | `3848` | Dashboard server port |

## License

MIT
