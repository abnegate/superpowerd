# Update pane title: directory · branch [*] · PR #n
_superpowerd_title() {
    local directory=${PWD##*/}
    local branch=$(git symbolic-ref --short HEAD 2>/dev/null)
    local title="$directory"
    if [[ -n "$branch" ]]; then
        title+=" · $branch"
        [[ -n "$(git status --porcelain 2>/dev/null | head -1)" ]] && title+=" *"
        local cache="/tmp/.superpowerd-pr-$(printf '%s' "${PWD}:${branch}" | md5 -q)"
        if [[ ! -f "$cache" ]] || [[ $(( $(date +%s) - $(stat -f %m "$cache") )) -gt 300 ]]; then
            { gh pr view --json number -q '"PR #\(.number)"' > "$cache" 2>/dev/null || touch "$cache"; } &!
        fi
        [[ -s "$cache" ]] && title+=" · $(cat "$cache")"
    fi
    printf '\033]0;%s\a' "$title"
}
precmd_functions+=(_superpowerd_title)

# Ring bell when a long-running command finishes (triggers WezTerm notification)
_superpowerd_bell() {
    local duration=$SECONDS
    if [[ $duration -gt 10 ]]; then
        printf '\a'
    fi
}
precmd_functions+=(_superpowerd_bell)
