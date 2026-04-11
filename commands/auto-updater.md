# Auto-Updater: OAuth Flow Recovery

You are a Claude Code skill specialized in diagnosing and recovering broken OAuth authentication flows for the superpowerd account rotation system.

## When to activate

- The user says "auth is broken", "login isn't working", "can't rotate accounts", "rotation failed", or similar
- `sp-rotate` fails or leaves Claude stuck on the wrong account
- `data/tokens.json` is missing an account or `tokens.js swap` reports a missing bundle
- A refresh token has been revoked and the Keychain swap no longer produces a working session

## How rotation works (context)

Rotation is a Keychain swap, not a browser flow:

1. `rotation/tokens.js capture-all` authenticates each account in `accounts.conf` once via `claude auth login --email <email>` and writes every account's OAuth bundle into `data/tokens.json`.
2. `rotation/rotate` runs `tokens.js swap <email>` to rewrite the `claudeAiOauth` subtree of the `Claude Code-credentials` Keychain entry in place, preserving any MCP OAuth tokens that live alongside it.
3. Each WezTerm pane is mapped to its Claude session ID, exited with `/exit`, and restarted with `claude --dangerously-skip-permissions --resume <session-id>`.
4. A `SessionStart` hook (`rotation/capture-hook`) re-captures the current account's tokens every time Claude starts, so `data/tokens.json` stays fresh as the CLI refreshes its access token.

`rotation/browser-auth.js` is a legacy Playwright fallback. It is **not** used during normal rotation. Only reach for it if a refresh token has been revoked and you need to re-authenticate through Google in a scripted browser.

## Diagnosis steps

1. **CLI auth state:**
   ```bash
   claude auth status 2>&1
   ```

2. **Rotation state:**
   ```bash
   cat "$SUPERPOWERD_HOME/data/state.json"
   ```

3. **Stored token bundles (should list every account in `accounts.conf`):**
   ```bash
   node "$SUPERPOWERD_HOME/rotation/tokens.js" list
   ```

4. **Keychain entry contents:**
   ```bash
   node "$SUPERPOWERD_HOME/rotation/tokens.js" status
   ```

5. **Recent rotation log:**
   ```bash
   tail -50 "$SUPERPOWERD_HOME/data/rotate.log"
   ```

6. **Monitor log (if auto-rotation is stuck):**
   ```bash
   tail -50 "$SUPERPOWERD_HOME/data/monitor.log"
   ```

## Recovery procedures

### Procedure A: Re-sync the CLI and the state file

If `claude auth status` shows the wrong account or `data/state.json` is out of sync with the Keychain:

```bash
# Option 1: let rotate sync state from the CLI
"$SUPERPOWERD_HOME/rotation/rotate" --status

# Option 2: force a swap to the desired account
node "$SUPERPOWERD_HOME/rotation/tokens.js" swap <email>
"$SUPERPOWERD_HOME/rotation/rotate" --status
```

### Procedure B: Re-capture a single account

If `tokens.js list` shows `[-]` next to an account, or `tokens.js swap` says "No stored tokens":

```bash
claude auth logout
claude auth login --email <email>
node "$SUPERPOWERD_HOME/rotation/tokens.js" capture
```

`capture` reads whatever is currently in the Keychain and writes it under the CLI-reported email, including the org ID fetched from the `roles` endpoint.

### Procedure C: Re-capture every account

If `data/tokens.json` is missing, corrupted, or full of stale bundles:

```bash
rm -f "$SUPERPOWERD_HOME/data/tokens.json"
node "$SUPERPOWERD_HOME/rotation/tokens.js" capture-all
```

This loops over `accounts.conf` and runs `claude auth login --email <email>` interactively for each one.

### Procedure D: Stale rotation lock

If `rotate` exits immediately with "Rotation already in progress" but nothing is actually running:

```bash
rm -f "$SUPERPOWERD_HOME/data/rotate.lock"
```

### Procedure E: Revoked refresh token (Playwright fallback)

If `tokens.js swap` succeeds but the CLI still fails against the API, the refresh token has probably been revoked. Re-auth that account through the Playwright fallback:

```bash
node "$SUPERPOWERD_HOME/rotation/browser-auth.js" login <email>
node "$SUPERPOWERD_HOME/rotation/tokens.js" capture
```

If the claude.ai UI has shifted and the selectors in `browser-auth.js` no longer match, open claude.ai in a real browser, inspect the user menu and "Log out" control, and update the selector arrays in `rotation/browser-auth.js` accordingly.

## After recovery

1. Verify with `claude auth status`
2. Confirm `tokens.js list` shows `[+]` for every account
3. Test rotation end-to-end: `"$SUPERPOWERD_HOME/rotation/rotate"`
4. If auto-rotation was affected: `"$SUPERPOWERD_HOME/rotation/monitor" --stop && "$SUPERPOWERD_HOME/rotation/monitor" --daemon`

## Proactive checks

```bash
# Every account in accounts.conf has a stored bundle
node "$SUPERPOWERD_HOME/rotation/tokens.js" list

# Monitor is running
"$SUPERPOWERD_HOME/rotation/monitor" --status

# SessionStart hook is installed
node -e 'var s=require(process.env.HOME+"/.claude/settings.json");console.log(JSON.stringify((s.hooks&&s.hooks.SessionStart)||[],null,2))'
```
