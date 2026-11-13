# Numbered account selector for teamclaude-statusline.
# Sourced by Bash/Zsh; `claude` keeps automatic rotation and `claude N` pins
# the new session to account N in `teamclaude status --json` order.
# Like `teamclaude`: no arguments or Claude flags open Claude Code with the
# account footer; a first word (a Claude subcommand) runs directly, without it.

unalias claude 2>/dev/null || true

claude() {
    if ! command -v teamclaude >/dev/null 2>&1; then
        printf 'TeamClaude is not installed. Run: npm install -g @karpeleslab/teamclaude\n' >&2
        return 127
    fi

    case "${1:-}" in
        update)
            command claude "$@"
            return
            ;;
        ''|-*)
            command teamclaude "$@"
            return
            ;;
        *[!0-9]*)
            command teamclaude -- "$@"
            return
            ;;
    esac

    local number=$1 account
    shift
    account=$(command teamclaude status --json 2>/dev/null | python3 -c '
import json
import sys

accounts = json.load(sys.stdin).get("accounts", [])
index = int(sys.argv[1]) - 1
print(accounts[index].get("name", "") if 0 <= index < len(accounts) else "")
' "$number" 2>/dev/null)

    # Fallback for teamclaude builds without `status --json`: ask the running
    # proxy's status endpoint directly.
    if [ -z "$account" ]; then
        account=$(python3 -c '
import json
import sys
import urllib.request

port = 3456
api_key = None
try:
    with open("'"$HOME"'/.config/teamclaude.json") as f:
        proxy = json.load(f).get("proxy") or {}
        port = proxy.get("port") or 3456
        api_key = proxy.get("apiKey")
except (OSError, ValueError):
    pass
try:
    req = urllib.request.Request(f"http://127.0.0.1:{port}/teamclaude/status",
        headers={"x-teamcodex-status-identity": "1", **({"x-api-key": api_key} if api_key else {})})
    with urllib.request.urlopen(req, timeout=3) as res:
        accounts = json.load(res).get("accounts", [])
except OSError:
    accounts = []
index = int(sys.argv[1]) - 1
print(accounts[index].get("name", "") if 0 <= index < len(accounts) else "")
' "$number" 2>/dev/null)
    fi

    if [ -z "$account" ]; then
        printf 'TeamClaude account number not found: %s\n' "$number" >&2
        return 2
    fi

    printf 'TeamClaude #%s: %s\n' "$number" "$account"
    case "${1:-}" in
        ''|-*) ;;
        *) set -- -- "$@" ;;
    esac
    TEAMCLAUDE_STATUSLINE_INDEX="$number" TC_ACCT="$account" \
        command teamclaude "$@"
}

# The other pools' short names, by the same rule: no arguments or CLI flags open the CLI with the account
# footer (`teamgrok …`), a first word (a CLI subcommand) goes after `--` (`teamgrok -- models`). grok, agy and
# cursor run a subcommand without the footer; the teamcodex wrapper hands `--` to its launcher, so a Codex
# subcommand keeps it (`teamcodex -- resume ID`, docs/install/HUD.md).
# update/login/logout manage the CLI itself (codex, grok and cursor-agent all list them, agy lists update),
# so they go to the real CLI. `cursor-agent` too, so Herdr's Cursor menu entry (it runs `cursor-agent`)
# gets the footer. Each is defined only where its pool wrapper is installed; elsewhere `codex` and the
# others stay as they are. The wrappers and the pool run the real CLI by absolute path or without a shell
# (TEAMCURSOR_CURSOR_BIN, node spawn), so nothing recurses into these functions.
# Each function carries its whole body, calling no helper: Claude Code's shell snapshot drops functions
# whose name starts with a single `_` (typeset +f | grep -vE '^_[^_]').

# A Cursor editor's `cursor` (any executable `cursor` on PATH other than the cursor-agent installer's shim,
# the shim's own find_cursor test) keeps its name; `cursor-agent` is still defined.
_tp_editor= _tp_path=$PATH:
while [ -n "$_tp_path" ]; do
    _tp_dir=${_tp_path%%:*}
    _tp_path=${_tp_path#*:}
    if [ -n "$_tp_dir" ] && [ -f "$_tp_dir/cursor" ] && [ -x "$_tp_dir/cursor" ] \
        && ! [ "$_tp_dir/cursor" -ef "$HOME/.local/bin/cursor" ]; then
        _tp_editor=1
        break
    fi
done

for _tp_entry in codex:teamcodex:codex grok:teamgrok:grok agy:teamagy:agy cursor:teamcursor:cursor-agent \
        cursor-agent:teamcursor:cursor-agent; do
    _tp_name=${_tp_entry%%:*}
    _tp_rest=${_tp_entry#*:}
    _tp_pool=${_tp_rest%%:*}
    _tp_cli=${_tp_rest#*:}
    # sh and `bash --posix` reject `-` in a function name, and that eval error would abort the sourcing shell.
    case $_tp_name in
        *-*) [ -n "${ZSH_VERSION:-}" ] || { [ -n "${BASH_VERSION:-}" ] && ! shopt -oq posix; } || continue ;;
        cursor) [ -z "$_tp_editor" ] || continue ;;
    esac
    command -v "$_tp_pool" >/dev/null 2>&1 || continue
    # `cursor agent` is how the cursor-agent installer's `cursor` shim starts the agent: alone or with flags it
    # opens the agent like plain `cursor`.
    _tp_agent=
    if [ "$_tp_cli" = cursor-agent ]; then
        _tp_agent='if [ "${1-}" = agent ]; then
        if [ "$#" -eq 1 ]; then shift; else case "$2" in -*) shift ;; esac; fi
    fi
    '
    fi
    unalias "$_tp_name" 2>/dev/null || true
    # eval: the name comes from the loop, and an alias of that name is gone before this parses.
    eval "$_tp_name"'() {
    '"$_tp_agent"'case "${1-}" in
        update|login|logout) command '"$_tp_cli"' "$@" ;;
        -*) command '"$_tp_pool"' "$@" ;;
        *) if [ "$#" -eq 0 ]; then command '"$_tp_pool"'; else command '"$_tp_pool"' -- "$@"; fi ;;
    esac
}'
done
unset _tp_editor _tp_path _tp_dir _tp_entry _tp_name _tp_rest _tp_pool _tp_cli _tp_agent
