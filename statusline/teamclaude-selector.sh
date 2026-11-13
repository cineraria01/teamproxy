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
# footer (`teamcodex …`), a first word (a CLI subcommand) runs without it (`teamcodex -- …`).
# update/login/logout manage the CLI itself (codex, grok and cursor-agent all list them, agy lists update),
# so they go to the real CLI. `cursor-agent` too, so Herdr's Cursor menu entry (it runs `cursor-agent`)
# gets the footer. Each is defined only where its pool wrapper is installed; elsewhere `codex` and the
# others stay as they are. The wrappers and the pool run the real CLI by absolute path or without a shell
# (TEAMCURSOR_CURSOR_BIN, node spawn), so nothing recurses into these functions.
_teamproxy_short() {
    local pool=$1 cli=$2
    shift 2
    # `cursor agent` is how the cursor-agent installer's `cursor` shim starts the agent.
    if [ "$cli" = cursor-agent ] && [ "${1:-}" = agent ]; then
        case "${2:-}" in ''|-*) shift ;; esac
    fi
    case "${1:-}" in
        update|login|logout) command "$cli" "$@" ;;
        ''|-*) command "$pool" "$@" ;;
        *) command "$pool" -- "$@" ;;
    esac
}

for _tp_entry in codex:teamcodex:codex grok:teamgrok:grok agy:teamagy:agy cursor:teamcursor:cursor-agent \
        cursor-agent:teamcursor:cursor-agent; do
    _tp_name=${_tp_entry%%:*}
    _tp_rest=${_tp_entry#*:}
    # sh and `bash --posix` reject `-` in a function name, and that eval error would abort the sourcing shell.
    case $_tp_name in
        *-*) [ -n "${ZSH_VERSION:-}" ] || { [ -n "${BASH_VERSION:-}" ] && ! shopt -oq posix; } || continue ;;
    esac
    if command -v "${_tp_rest%%:*}" >/dev/null 2>&1; then
        unalias "$_tp_name" 2>/dev/null || true
        # eval: the function name comes from the loop, and an alias of that name is gone before this parses.
        eval "$_tp_name() { _teamproxy_short ${_tp_rest%%:*} ${_tp_rest#*:} \"\$@\"; }"
    fi
done
unset _tp_entry _tp_name _tp_rest
