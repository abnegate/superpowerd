#!/bin/bash
set -euo pipefail

# Bootstrap superpowerd on a fresh macOS machine.
#
# Installs: Homebrew, git, gh, Claude Code, WezTerm, skhd
# Configures: WezTerm grid, pane titles, account rotation, dashboard
#
# Usage:
#   bash setup.sh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
WORKSPACE="${SUPERPOWERD_WORKSPACE:-$HOME/Local}"

echo ""
echo "  superpowerd setup"
echo ""

# Install Homebrew
echo "==> Homebrew"
if ! command -v brew &>/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

echo "==> Packages"
brew install --quiet git gh node 2>/dev/null || true
brew install --cask --quiet wezterm 2>/dev/null || true
brew install --cask --quiet font-fira-code-nerd-font 2>/dev/null || true
brew install --quiet koekeishiya/formulae/skhd 2>/dev/null || true

echo "==> Claude Code"
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi

echo "==> GitHub auth"
if ! gh auth status &>/dev/null 2>&1; then
  echo "    Run: gh auth login"
  echo "    Then re-run this script."
  exit 1
fi

# Config files
echo "==> Config files"
if [[ ! -f "$PROJECT_DIR/repos.conf" ]]; then
  cp "$PROJECT_DIR/repos.conf.example" "$PROJECT_DIR/repos.conf"
  echo "    Created repos.conf (edit to customize)"
fi
if [[ ! -f "$PROJECT_DIR/accounts.conf" ]]; then
  cp "$PROJECT_DIR/accounts.conf.example" "$PROJECT_DIR/accounts.conf"
  echo "    Created accounts.conf (edit with your accounts)"
fi
if [[ ! -f "$PROJECT_DIR/shortcuts.conf" ]]; then
  cp "$PROJECT_DIR/shortcuts.conf.example" "$PROJECT_DIR/shortcuts.conf"
  echo "    Created shortcuts.conf (edit to customize)"
fi

# Workspace
echo "==> Workspace: $WORKSPACE"
mkdir -p "$WORKSPACE"

# Clone repos
echo "==> Cloning repos"
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  dir=$(echo "$line" | cut -d= -f1)
  rest=$(echo "$line" | cut -d= -f2)
  remote=$(echo "$rest" | cut -d: -f1)
  if [[ ! -d "$WORKSPACE/$dir" ]]; then
    echo "    $remote -> $dir"
    gh repo clone "$remote" "$WORKSPACE/$dir" 2>/dev/null || echo "    (skipped $dir)"
  fi
done < "$PROJECT_DIR/repos.conf"

# WezTerm
echo "==> WezTerm config"
mkdir -p "$HOME/.config/wezterm"
cp "$PROJECT_DIR/wezterm/wezterm.lua" "$HOME/.config/wezterm/wezterm.lua"

# Pane title hook
echo "==> Shell hooks"
mkdir -p "$HOME/.config/iterm2"
cp "$PROJECT_DIR/wezterm/pane-title.zsh" "$HOME/.config/iterm2/pane-title.zsh"

# skhd
echo "==> skhd"
mkdir -p "$HOME/.config/skhd"
skhd --install-service 2>/dev/null || true
skhd --restart-service 2>/dev/null || true

# .zshrc modifications
echo "==> Shell config"
ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"

if grep -q '# DISABLE_AUTO_TITLE="true"' "$ZSHRC"; then
  sed -i '' 's/# DISABLE_AUTO_TITLE="true"/DISABLE_AUTO_TITLE="true"/' "$ZSHRC"
elif ! grep -q 'DISABLE_AUTO_TITLE="true"' "$ZSHRC"; then
  echo 'DISABLE_AUTO_TITLE="true"' >> "$ZSHRC"
fi

if ! grep -q "SUPERPOWERD_HOME" "$ZSHRC"; then
  cat >> "$ZSHRC" << BLOCK

# superpowerd
export SUPERPOWERD_HOME="$PROJECT_DIR"
export SUPERPOWERD_WORKSPACE="$WORKSPACE"
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
[[ -f ~/.config/iterm2/pane-title.zsh ]] && source ~/.config/iterm2/pane-title.zsh
alias sp-rotate="$PROJECT_DIR/rotation/rotate"
alias sp-monitor="$PROJECT_DIR/rotation/monitor"
alias sp-update="$PROJECT_DIR/rotation/update"
alias sp-dashboard="node $PROJECT_DIR/dashboard/server.js"
BLOCK
fi

# Make scripts executable
chmod +x "$PROJECT_DIR/rotation/rotate" "$PROJECT_DIR/rotation/monitor" "$PROJECT_DIR/rotation/browser-auth.js" "$PROJECT_DIR/rotation/tokens.js" "$PROJECT_DIR/rotation/update"

# Initialize data directory
mkdir -p "$PROJECT_DIR/data"
if [[ ! -f "$PROJECT_DIR/data/state.json" ]]; then
  echo '{"current": 0}' > "$PROJECT_DIR/data/state.json"
fi

# Capture current account's tokens
echo "==> Capturing tokens"
node "$PROJECT_DIR/rotation/tokens.js" capture 2>/dev/null && \
  echo "    Saved current account tokens" || \
  echo "    (no session — run: node rotation/tokens.js capture-all after authenticating)"

# Install root deps (Playwright)
echo "==> Playwright"
cd "$PROJECT_DIR"
npm install --silent 2>/dev/null
npx playwright install chromium 2>/dev/null || echo "    (chromium install failed, run: npx playwright install chromium)"

# Install dashboard deps
echo "==> Dashboard"
cd "$PROJECT_DIR/dashboard"
npm install --silent 2>/dev/null
npm run build 2>/dev/null || echo "    (build skipped, run npm run build later)"

# Index historical sessions
echo "==> Session index"
cd "$PROJECT_DIR"
node rotation/index-sessions.js 2>/dev/null || echo "    (indexing skipped)"

# Install custom slash commands
echo "==> Claude commands"
COMMANDS_DIR="$HOME/.claude/commands"
mkdir -p "$COMMANDS_DIR"
for cmd in "$PROJECT_DIR"/commands/*.md; do
  [[ -f "$cmd" ]] && ln -sf "$cmd" "$COMMANDS_DIR/$(basename "$cmd")"
done

# Install SessionStart hook for auto token capture
echo "==> Auto-capture hook"
SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  node -e "
    var fs = require('fs');
    var settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    var hookCmd = '$PROJECT_DIR/rotation/capture-hook';
    var exists = settings.hooks.SessionStart.some(function(h) {
      return h.hooks && h.hooks.some(function(hh) { return hh.command && hh.command.includes('capture-hook'); });
    });
    if (!exists) {
      settings.hooks.SessionStart.push({
        matcher: '',
        hooks: [{ type: 'command', command: hookCmd }]
      });
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
      console.log('    Installed SessionStart hook');
    } else {
      console.log('    Hook already installed');
    }
  "
fi

# Install persistent monitor
echo "==> Monitor service"
NODE_PATH=$(which node)
if [[ "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.superpowerd.monitor.plist"
  cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.superpowerd.monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$PROJECT_DIR/rotation/monitor</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/data/monitor.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/data/monitor.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$(dirname "$NODE_PATH")</string>
    </dict>
</dict>
</plist>
PLIST
  launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
  echo "    Installed launchd service (com.superpowerd.monitor)"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/superpowerd-monitor.service" << UNIT
[Unit]
Description=superpowerd rate limit monitor

[Service]
ExecStart=/bin/bash $PROJECT_DIR/rotation/monitor
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_PATH")

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now superpowerd-monitor 2>/dev/null || true
  echo "    Installed systemd user service (superpowerd-monitor)"
fi

# Dashboard service
NPX_PATH=$(which npx)
echo "==> Dashboard service"
if [[ "$(uname)" == "Darwin" ]]; then
  DASH_PLIST="$HOME/Library/LaunchAgents/com.superpowerd.dashboard.plist"
  cat > "$DASH_PLIST" << DASHPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.superpowerd.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NPX_PATH</string>
        <string>tsx</string>
        <string>$PROJECT_DIR/dashboard/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR/dashboard</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/data/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/data/dashboard.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$(dirname "$NODE_PATH")</string>
    </dict>
</dict>
</plist>
DASHPLIST
  launchctl bootout gui/$(id -u) "$DASH_PLIST" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$DASH_PLIST" 2>/dev/null || launchctl load "$DASH_PLIST" 2>/dev/null || true
  echo "    Installed launchd service (com.superpowerd.dashboard)"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/superpowerd-dashboard.service" << DASHUNIT
[Unit]
Description=superpowerd dashboard
After=network.target

[Service]
ExecStart=$NPX_PATH tsx $PROJECT_DIR/dashboard/server.ts
WorkingDirectory=$PROJECT_DIR/dashboard
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_PATH")

[Install]
WantedBy=default.target
DASHUNIT
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now superpowerd-dashboard 2>/dev/null || true
  echo "    Installed systemd user service (superpowerd-dashboard)"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Running services:"
echo "  Monitor:    watching ~/.claude/debug/ for rate limits"
echo "  Dashboard:  http://localhost:3848"
echo ""
echo "Commands:"
echo "  sp-rotate             Rotate to next account"
echo "  sp-rotate --status    Show current account"
echo "  sp-monitor --status   Check monitor"
echo ""
echo "Shortcuts (in WezTerm):"
echo "  Opt+Cmd+\`   Toggle WezTerm"
echo "  Opt+Cmd+P   Open PR in browser"
echo "  Opt+Cmd+N   Create PR"
echo "  Opt+Cmd+R   Restart Claude"
echo ""
echo "Next: Open WezTerm (or restart it) to activate the pane grid."
