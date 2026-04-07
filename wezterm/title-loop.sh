#!/bin/bash

# Background loop to update pane title with repo info.
# Uses OSC 0 which works in both direct terminals and tmux (with set-titles on).

while true; do
  sleep 5
  T=$(basename "$PWD")
  B=$(git symbolic-ref --short HEAD 2>/dev/null)
  if [ -n "$B" ]; then
    T="$T · $B"
    [ -n "$(git status --porcelain 2>/dev/null | head -1)" ] && T="$T *"
    PR=$(cat "/tmp/.superpowerd-pr-$(printf '%s' "${PWD}:${B}" | md5 -q)" 2>/dev/null)
    [ -n "$PR" ] && T="$T · $PR"
  fi
  printf '\033]0;%s\a' "$T"
done
