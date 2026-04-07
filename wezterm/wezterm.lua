local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action

local config = wezterm.config_builder()

local home = os.getenv("HOME")
local superpowerd = os.getenv("SUPERPOWERD_HOME") or home .. "/Local/superpowerd"
local workspace = os.getenv("SUPERPOWERD_WORKSPACE") or home .. "/Local"

config.colors = {
  foreground = "#f8f8f8",
  background = "#0b2f20",
  cursor_bg = "#336442",
  cursor_fg = "#f8f8f8",
  selection_bg = "#245032",
  selection_fg = "#f8f8f8",
  split = "#555555",
  ansi = {
    "#000000", "#fd6209", "#41a83e", "#ffe862",
    "#245032", "#f8f8f8", "#9df39f", "#ffffff",
  },
  brights = {
    "#323232", "#ff943b", "#73da70", "#ffff94",
    "#568264", "#ffffff", "#cfffd1", "#ffffff",
  },
  tab_bar = {
    background = "#062419",
    active_tab = { bg_color = "#0b2f20", fg_color = "#f8f8f8" },
    inactive_tab = { bg_color = "#062419", fg_color = "#888888" },
  },
}

config.font = wezterm.font("FiraCode Nerd Font")
config.font_size = 12

config.window_decorations = "RESIZE"
config.window_padding = { left = 4, right = 4, top = 4, bottom = 4 }
config.window_close_confirmation = "NeverPrompt"
config.adjust_window_size_when_changing_font_size = false
config.inactive_pane_hsb = { brightness = 0.92 }
config.initial_cols = 240
config.initial_rows = 70
config.pane_focus_follows_mouse = true
config.audible_bell = "SystemBeep"

config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.hide_tab_bar_if_only_one_tab = false
config.show_new_tab_button_in_tab_bar = false
config.tab_max_width = 50

-- Repos from repos.conf (directory=org/repo)
-- Shortcuts from shortcuts.conf (directory=key)

-- Read preferred AI agent (claude or codex)
local agent_cmd = "claude --dangerously-skip-permissions"
local af = io.open(home .. "/.config/superpowerd/agent", "r")
if af then
  local agent = af:read("*l")
  af:close()
  if agent == "codex" then
    agent_cmd = "codex --full-auto"
  end
end

local repos = {}
local f = io.open(superpowerd .. "/repos.conf", "r")
  or io.open(workspace .. "/repos.conf", "r")
if f then
  for line in f:lines() do
    if not line:match("^#") and line:match("=") then
      local name, remote = line:match("^(%S+)=(%S+)")
      if name and remote then
        table.insert(repos, { name = name, remote = remote, key = name:sub(1, 1) })
      end
    end
  end
  f:close()
end

local sf = io.open(superpowerd .. "/shortcuts.conf", "r")
if sf then
  for line in sf:lines() do
    if not line:match("^#") and line:match("=") then
      local name, key = line:match("^(%S+)=(%a)")
      if name and key then
        for _, r in ipairs(repos) do
          if r.name == name then r.key = key end
        end
      end
    end
  end
  sf:close()
end

local total = #repos + 1
local columns = 2
local rows = math.ceil(total / columns)

local function shell(cmd)
  local h = io.popen(cmd .. " 2>/dev/null")
  if not h then return nil end
  local out = h:read("*l")
  h:close()
  return (out and out ~= "") and out or nil
end

local split_ratios = {
  [2] = { 0.5 },
  [3] = { 0.64, 0.46 },
  [4] = { 0.74, 0.62, 0.46 },
  [5] = { 0.80, 0.72, 0.62, 0.46 },
}

wezterm.on("format-tab-title", function() return " " end)

wezterm.on("update-right-status", function(window, pane)
  local full = pane:get_title() or ""
  local parts = {}
  for part in full:gmatch("[^·]+") do
    table.insert(parts, part:match("^%s*(.-)%s*$"))
  end
  local name = parts[1] or ""
  local branch = parts[2] or ""
  local pr = parts[3] or ""

  local labels = {}
  table.insert(labels, { Foreground = { Color = "#5fafff" } })
  table.insert(labels, { Text = "  " .. name })
  if branch ~= "" then
    table.insert(labels, { Foreground = { Color = "#73da70" } })
    table.insert(labels, { Text = " · " .. branch })
  end
  if pr ~= "" then
    table.insert(labels, { Foreground = { Color = "#ff943b" } })
    table.insert(labels, { Text = " · " .. pr })
  end
  table.insert(labels, { Text = "  " })
  window:set_right_status(wezterm.format(labels))
end)

wezterm.on("gui-startup", function()
  local pane_defs = {}
  for _, r in ipairs(repos) do
    table.insert(pane_defs, { name = r.name, cwd = workspace .. "/" .. r.name, claude = true })
  end
  table.insert(pane_defs, { name = "local", cwd = workspace, claude = false })

  if #pane_defs % 2 == 1 then
    table.insert(pane_defs, { name = "local-2", cwd = workspace, claude = false })
  end

  local grid_rows = #pane_defs / 2
  local ratios = split_ratios[grid_rows] or split_ratios[3]

  local tab, left_top, window = mux.spawn_window({ cwd = pane_defs[1].cwd })

  local right_top = left_top:split({ direction = "Right", size = 0.5, cwd = pane_defs[2].cwd })

  local left_panes = { left_top }
  local current = left_top
  for i = 1, #ratios do
    local idx = 1 + (i * 2)
    if idx <= #pane_defs then
      current = current:split({
        direction = "Bottom",
        size = ratios[i],
        cwd = pane_defs[idx].cwd,
      })
      table.insert(left_panes, current)
    end
  end

  local right_panes = { right_top }
  current = right_top
  for i = 1, #ratios do
    local idx = 2 + (i * 2)
    if idx <= #pane_defs then
      current = current:split({
        direction = "Bottom",
        size = ratios[i],
        cwd = pane_defs[idx].cwd,
      })
      table.insert(right_panes, current)
    end
  end

  local all_panes = {}
  for i = 1, math.max(#left_panes, #right_panes) do
    if left_panes[i] then table.insert(all_panes, left_panes[i]) end
    if right_panes[i] then table.insert(all_panes, right_panes[i]) end
  end

  local session = superpowerd .. "/sp-session"
  for i, pane in ipairs(all_panes) do
    local def = pane_defs[i]
    if def then
      if def.claude then
        pane:send_text(session .. " " .. def.name .. " " .. def.cwd .. agent_cmd .. "\n")
      else
        pane:send_text(session .. " " .. def.name .. " " .. def.cwd .. "\n")
      end
    end
  end

  wezterm.background_child_process({ "caffeinate", "-d" })
  window:gui_window():maximize()
end)

wezterm.on("bell", function(window, pane)
  local ok, active = pcall(function() return window:active_pane() end)
  if ok and active and pane:pane_id() ~= active:pane_id() then
    local title = pane:get_title():match("^(%S+)") or "pane"
    window:toast_notification("WezTerm", title .. " needs attention", nil, 3000)
  end
end)

local function pane_index(i)
  local idx
  if i % 2 == 1 then
    local row = math.ceil(i / 2)
    idx = row == 1 and 0 or row
  else
    local row = math.floor(i / 2)
    idx = row == 1 and 1 or (rows + row - 1)
  end
  return math.floor(idx)
end

config.keys = {}

for i, r in ipairs(repos) do
  table.insert(config.keys, {
    key = r.key, mods = "OPT|CMD",
    action = act.ActivatePaneByIndex(pane_index(i)),
  })
end

table.insert(config.keys, {
  key = "l", mods = "OPT|CMD",
  action = act.ActivatePaneByIndex(pane_index(#repos + 1)),
})

table.insert(config.keys, {
  key = "p", mods = "OPT|CMD",
  action = wezterm.action_callback(function(_, pane)
    local repo = pane:get_title():match("^(%S+)")
    if repo and repo ~= "local" then
      wezterm.background_child_process({
        "bash", "-c", "cd " .. workspace .. "/" .. repo .. " && gh pr view --web 2>/dev/null &"
      })
    end
  end),
})

table.insert(config.keys, {
  key = "n", mods = "OPT|CMD",
  action = wezterm.action_callback(function(window, pane)
    local repo = pane:get_title():match("^(%S+)")
    if repo and repo ~= "local" then
      window:toast_notification("WezTerm", "Pushing " .. repo .. "...", nil, 5000)
      wezterm.background_child_process({
        "bash", "-c", [[
          cd ]] .. workspace .. "/" .. repo .. [[ || exit 1
          git push -u origin HEAD 2>/dev/null
          REMOTE=$(git remote get-url origin 2>/dev/null | sed 's/git@github.com:/https:\/\/github.com\//' | sed 's/\.git$//')
          BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
          open "${REMOTE}/compare/${BRANCH}?expand=1"
        ]]
      })
    end
  end),
})

table.insert(config.keys, {
  key = "r", mods = "OPT|CMD",
  action = wezterm.action_callback(function(_, pane)
    pane:send_text("\x03")
    wezterm.time.call_after(0.5, function()
      pane:send_text(agent_cmd .. "\n")
    end)
  end),
})

table.insert(config.keys, {
  key = "DownArrow", mods = "OPT|CMD",
  action = wezterm.action_callback(function(_, pane)
    local tab = pane:tab()
    local info = tab:panes_with_info()
    table.sort(info, function(a, b) return a.top > b.top end)
    local bottom_left, bottom_right
    for _, p in ipairs(info) do
      if not bottom_left then
        bottom_left = p
      elseif not bottom_right and p.top == bottom_left.top then
        bottom_right = p
      end
    end
    if bottom_left and bottom_right and bottom_left.left > bottom_right.left then
      bottom_left, bottom_right = bottom_right, bottom_left
    end
    local next = tonumber(shell("tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^local'")) or 0
    local session = superpowerd .. "/sp-session"
    if bottom_left then
      local new_left = bottom_left.pane:split({ direction = "Bottom", size = 0.5, cwd = workspace })
      new_left:send_text(session .. " local-" .. (next + 1) .. " " .. workspace .. "\n")
    end
    if bottom_right then
      local new_right = bottom_right.pane:split({ direction = "Bottom", size = 0.5, cwd = workspace })
      new_right:send_text(session .. " local-" .. (next + 2) .. " " .. workspace .. "\n")
    end
  end),
})

for _, binding in ipairs({
  { key = "LeftArrow",  mods = "OPT",       action = act.SendString("\x1bb") },
  { key = "RightArrow", mods = "OPT",       action = act.SendString("\x1bf") },
  { key = "LeftArrow",  mods = "CMD",       action = act.SendString("\x01") },
  { key = "RightArrow", mods = "CMD",       action = act.SendString("\x05") },
  { key = "Backspace",  mods = "OPT",       action = act.SendString("\x1b\x7f") },
  { key = "Backspace",  mods = "CMD",       action = act.SendString("\x15") },
  { key = "LeftArrow",  mods = "OPT|SHIFT", action = act.SendString("\x1b[1;10D") },
  { key = "RightArrow", mods = "OPT|SHIFT", action = act.SendString("\x1b[1;10C") },
}) do
  table.insert(config.keys, binding)
end

local function generate_skhd()
  local lines = {
    "# Auto-generated by superpowerd — do not edit manually",
    "",
    "# Toggle WezTerm",
    'alt + cmd - 0x32 : if [ "$(osascript -e \'tell application "System Events" to return visible of process "wezterm-gui"\' 2>/dev/null)" = "true" ]; then osascript -e \'tell application "System Events" to set visible of process "wezterm-gui" to false\'; elif pgrep -xq wezterm-gui; then osascript -e \'tell application "System Events" to set visible of process "wezterm-gui" to true\' -e \'tell application "WezTerm" to activate\'; else open -a WezTerm; fi',
    "",
    "# Focus panes",
  }
  local show = "osascript -e 'tell application \"System Events\" to set visible of process \"wezterm-gui\" to true' -e 'tell application \"WezTerm\" to activate' 2>/dev/null"
  for i, r in ipairs(repos) do
    table.insert(lines, "alt + cmd - " .. r.key .. " : " .. show .. "; wezterm cli activate-pane --pane-id " .. pane_index(i) .. " 2>/dev/null")
  end
  table.insert(lines, "alt + cmd - l : " .. show .. "; wezterm cli activate-pane --pane-id " .. pane_index(#repos + 1) .. " 2>/dev/null")

  local out = io.open(home .. "/.config/skhd/skhdrc", "w")
  if out then
    out:write(table.concat(lines, "\n") .. "\n")
    out:close()
    os.execute("skhd --restart-service 2>/dev/null &")
  end
end

generate_skhd()

return config
