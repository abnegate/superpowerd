# Auto-Updater: OAuth Flow Recovery

You are a Claude Code skill specialized in diagnosing and recovering broken OAuth authentication flows for the superpowerd account rotation system.

## When to activate

- The user says "auth is broken", "login isn't working", "OAuth flow failed", "can't rotate accounts", or similar
- A rotation script failed and the user needs help recovering
- The browser automation (browser-auth.js) couldn't complete the sign-in flow
- Claude CLI is stuck in a bad auth state

## Diagnosis steps

1. **Check CLI auth state:**
   ```bash
   claude auth status 2>&1
   ```

2. **Check the rotation state:**
   ```bash
   cat "$SUPERPOWERD_HOME/data/state.json" 2>/dev/null || cat ~/Local/superpowerd/data/state.json
   ```

3. **Check recent rotation logs for errors:**
   ```bash
   tail -30 "$SUPERPOWERD_HOME/data/rotate.log" 2>/dev/null || tail -30 ~/Local/superpowerd/data/rotate.log
   ```

4. **Check if Chrome is accessible for AppleScript:**
   ```bash
   osascript -e 'tell application "Google Chrome" to get URL of active tab of front window' 2>&1
   ```

5. **Check for stale browser sessions:**
   ```bash
   osascript -e 'tell application "Google Chrome" to get URL of every tab of every window' 2>&1 | tr ',' '\n' | grep -i "claude\|anthropic\|accounts.google"
   ```

## Recovery procedures

### Procedure A: CLI auth reset
If `claude auth status` shows wrong account or errors:
```bash
claude auth logout
claude auth login --email <correct_email>
```
Then update state.json to match.

### Procedure B: Browser session cleanup
If the browser has stale claude.ai sessions:
1. Close all claude.ai and accounts.google.com/signin tabs
2. Navigate to claude.ai/login in Chrome
3. Sign in with the correct Google account
4. Then run `claude auth login`

### Procedure C: Full reset
If nothing else works:
```bash
# Reset CLI auth
claude auth logout

# Reset rotation state
echo '{"current": 0}' > "$SUPERPOWERD_HOME/data/state.json"

# Clear Google OAuth consent cache in Chrome (navigate manually)
# Open: chrome://settings/content/cookies
# Search for: claude.ai
# Remove all claude.ai cookies

# Re-authenticate
claude auth login --email <first_account_email>
```

### Procedure D: Fix browser-auth.js selectors
If the browser automation can't find buttons (UI changed):
1. Open Chrome to claude.ai
2. Right-click the user menu button, inspect element
3. Note the selector (data-testid, aria-label, etc.)
4. Update the selectors array in `$SUPERPOWERD_HOME/rotation/browser-auth.js`
5. Do the same for the "Sign out" menu item and "Continue with Google" button

### Procedure E: WezTerm terminal re-auth
If individual Claude terminals need re-auth after rotation:
```bash
# List all WezTerm panes
wezterm cli list

# Send /login to a specific pane
wezterm cli send-text --pane-id <PANE_ID> --no-paste $'\x1b'
sleep 0.3
wezterm cli send-text --pane-id <PANE_ID> "/login"
wezterm cli send-text --pane-id <PANE_ID> --no-paste $'\r'
```

## After recovery

1. Verify with `claude auth status`
2. Update state.json if the current index is wrong
3. Test the rotation: `$SUPERPOWERD_HOME/rotation/rotate --status`
4. Restart the monitor if it was affected: `$SUPERPOWERD_HOME/rotation/monitor --stop && $SUPERPOWERD_HOME/rotation/monitor --daemon`

## Proactive checks

Run these to verify the system is healthy:
```bash
# All accounts should resolve
for email in $(grep -v '^#' "$SUPERPOWERD_HOME/accounts.conf"); do
  echo "Account: $email"
done

# Monitor should be running
$SUPERPOWERD_HOME/rotation/monitor --status

# Chrome should be accessible
osascript -e 'tell application "Google Chrome" to return name' 2>&1
```
