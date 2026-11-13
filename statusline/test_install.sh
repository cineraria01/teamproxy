#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

# Keep status-line invocations hermetic: a live installation on this machine
# shares the default cache path (and would leak real account data in), and
# ANSI colors would break the exact-line greps below.
export TC_SL_CACHE_FILE="$TEST_DIR/statusline-cache.json"
export NO_COLOR=1
export NO_RELOAD_PATCH=1

TEST_HOME="$TEST_DIR/home"
TEST_BIN="$TEST_DIR/bin"
mkdir -p "$TEST_HOME/.claude" "$TEST_BIN"
printf '%s\n' "alias claude='teamclaude run --'" "export KEEP_ME=1" > "$TEST_HOME/.bashrc"
printf '%s\n' '{"keep": true}' > "$TEST_HOME/.claude/settings.json"

cat > "$TEST_BIN/teamclaude" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = status ] && [ "${2:-}" = --json ]; then
  if [ -n "${TC_TEST_NO_ACCOUNTS:-}" ]; then
    printf '%s\n' '{"accounts":[]}'
  else
    printf '%s\n' '{"accounts":[{"name":"one@example.com"},{"name":"two@example.com"}]}'
  fi
  exit
fi
printf 'PIN=%s INDEX=%s ARGS=%s\n' \
  "${TC_ACCT:-}" "${TEAMCLAUDE_STATUSLINE_INDEX:-}" "$*"
SH
chmod +x "$TEST_BIN/teamclaude"

cat > "$TEST_BIN/claude" <<'SH'
#!/usr/bin/env bash
printf 'NATIVE=%s\n' "$*"
SH
chmod +x "$TEST_BIN/claude"

install_once() {
  HOME="$TEST_HOME" SHELL=/bin/bash CLAUDE_DIR="$TEST_HOME/.claude" \
    NO_PROBE=1 PATH="$TEST_BIN:$PATH" "$REPO_DIR/install.sh" >/dev/null
}

install_once
first_rc_checksum=$(cksum < "$TEST_HOME/.bashrc")
install_once
test "$first_rc_checksum" = "$(cksum < "$TEST_HOME/.bashrc")"

test -x "$TEST_HOME/.claude/statusline-teamclaude.py"
test -x "$TEST_HOME/.claude/statusline-wrapper.py"
test -r "$TEST_HOME/.claude/teamclaude-selector.sh"
test -x "$TEST_HOME/.claude/statusline-autoupdate.sh"
test -s "$TEST_HOME/.claude/teamclaude-statusline-installed-sha"
test "$(grep -c '^# >>> teamclaude-statusline selector >>>$' "$TEST_HOME/.bashrc")" -eq 1
grep -q '^export KEEP_ME=1$' "$TEST_HOME/.bashrc"
python3 - "$TEST_HOME/.claude/settings.json" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    settings = json.load(f)
assert settings["keep"] is True
assert settings["statusLine"]["command"].endswith("statusline-wrapper.py")
PY

selected=$(HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" \
  bash --noprofile --rcfile "$TEST_HOME/.bashrc" -ic 'claude 2 --continue' 2>/dev/null)
grep -q 'TeamClaude #2: two@example.com' <<< "$selected"
grep -q 'PIN=two@example.com INDEX=2 ARGS=--continue' <<< "$selected"
# Flags open the footer launcher (`teamclaude …`); a first word is a Claude subcommand (`teamclaude -- …`).
routed=$(HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" \
  bash --noprofile --rcfile "$TEST_HOME/.bashrc" -ic 'claude; claude -c; claude mcp list; claude 2 mcp list' 2>/dev/null)
grep -qx 'PIN= INDEX= ARGS=' <<< "$routed"
grep -qx 'PIN= INDEX= ARGS=-c' <<< "$routed"
grep -qx 'PIN= INDEX= ARGS=-- mcp list' <<< "$routed"
grep -qx 'PIN=two@example.com INDEX=2 ARGS=-- mcp list' <<< "$routed"

updated=$(HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" \
  bash --noprofile --rcfile "$TEST_HOME/.bashrc" -ic 'claude update' 2>/dev/null)
grep -qx 'NATIVE=update' <<< "$updated"

# codex/grok/agy/cursor/cursor-agent go to their pool wrappers by the same rule; update/login/logout go to the
# real CLI. Each stub prints every argument in brackets, so argument boundaries are checked too.
stub() {
  printf '#!/bin/sh\nprintf "%%s" "%s"; for a; do printf " [%%s]" "$a"; done; echo\n' "$2" > "$1"
  chmod +x "$1"
}
for pool in teamcodex teamgrok teamagy teamcursor; do stub "$TEST_BIN/$pool" "$pool"; done
for cli in codex grok agy cursor-agent; do stub "$TEST_BIN/$cli" "REAL $cli"; done
# Hermetic PATH: a real Cursor editor or installer shim on this machine must not decide what `cursor` is.
SHORT_PATH="$TEST_BIN:/usr/bin:/bin"
SELECTOR="$TEST_HOME/.claude/teamclaude-selector.sh"
short_calls='codex
codex --no-daemon
codex resume ID
codex exec "a b"
codex update
codex login
codex ""
grok
grok -p hi
grok models
grok logout
agy
agy -c
agy mcp list
agy update
cursor
cursor --yolo
cursor agent
cursor agent --yolo
cursor agent fix it
cursor agent ""
cursor ls
cursor update
cursor-agent
cursor-agent -p hi
cursor-agent agent --yolo
cursor-agent ls
cursor-agent login'
short_expected='teamcodex
teamcodex [--no-daemon]
teamcodex [--] [resume] [ID]
teamcodex [--] [exec] [a b]
REAL codex [update]
REAL codex [login]
teamcodex [--] []
teamgrok
teamgrok [-p] [hi]
teamgrok [--] [models]
REAL grok [logout]
teamagy
teamagy [-c]
teamagy [--] [mcp] [list]
REAL agy [update]
teamcursor
teamcursor [--yolo]
teamcursor
teamcursor [--yolo]
teamcursor [--] [agent] [fix] [it]
teamcursor [--] [agent] []
teamcursor [--] [ls]
REAL cursor-agent [update]
teamcursor
teamcursor [-p] [hi]
teamcursor [--yolo]
teamcursor [--] [ls]
REAL cursor-agent [login]'
check_short() {
  local label=$1 got=$2
  if [ "$got" != "$short_expected" ]; then
    printf 'short names (%s) differ:\n' "$label" >&2
    diff <(printf '%s\n' "$short_expected") <(printf '%s\n' "$got") >&2 || true
    return 1
  fi
}
check_short bash-rc "$(HOME="$TEST_HOME" PATH="$SHORT_PATH" \
  bash --noprofile --rcfile "$TEST_HOME/.bashrc" -ic "$short_calls" 2>/dev/null)"
# An alias of the same name is replaced (the next lines parse after the source).
check_short zsh "$(PATH="$SHORT_PATH" zsh -fc "alias codex=nope
source '$SELECTOR'
$short_calls")"
# Sourced under set -eu, twice.
check_short bash-eu-twice "$(PATH="$SHORT_PATH" bash -c "set -eu
. '$SELECTOR'
. '$SELECTOR'
$short_calls")"
check_short zsh-eu-twice "$(PATH="$SHORT_PATH" zsh -fc "set -eu
source '$SELECTOR'
source '$SELECTOR'
$short_calls")"
# Claude Code's shell snapshot keeps only functions not named `_x…` (typeset +f | grep -vE '^_[^_]'), so each
# function must work from its own body in a fresh shell that sources only the snapshot.
SNAPSHOT="$TEST_DIR/snapshot.zsh"
PATH="$SHORT_PATH" zsh -fc "source '$SELECTOR'
typeset +f | grep -vE '^_[^_]' | while read f; do typeset -f \$f; done > '$SNAPSHOT'"
check_short zsh-snapshot "$(PATH="$SHORT_PATH" zsh -fc "source '$SNAPSHOT'
$short_calls")"

# Without a pool wrapper the short name is left alone (here only teamcodex is installed).
ONLY_CODEX_BIN="$TEST_DIR/only-codex-bin"
mkdir -p "$ONLY_CODEX_BIN"
cp "$TEST_BIN/teamcodex" "$ONLY_CODEX_BIN/"
test "$(PATH="$ONLY_CODEX_BIN:/usr/bin:/bin" bash -c \
  "source '$SELECTOR'; type -t codex; type -t grok agy cursor cursor-agent || echo none")" = "function
none"
test "$(PATH="$ONLY_CODEX_BIN:/usr/bin:/bin" zsh -fc \
  "grok() { echo mine; }; source '$SELECTOR'; whence -w codex agy cursor cursor-agent; grok")" = "codex: function
agy: none
cursor: none
cursor-agent: none
mine"

# A Cursor editor's `cursor` on PATH keeps its name; `cursor-agent` is still routed. The cursor-agent
# installer's shim ($HOME/.local/bin/cursor) is not an editor.
EDITOR_BIN="$TEST_DIR/editor-bin"
mkdir -p "$EDITOR_BIN" "$TEST_HOME/.local/bin"
stub "$EDITOR_BIN/cursor" "EDITOR"
stub "$TEST_HOME/.local/bin/cursor" "SHIM"
test "$(HOME="$TEST_HOME" PATH="$EDITOR_BIN:$SHORT_PATH" bash -c \
  ". '$SELECTOR'; type -t cursor; cursor .; cursor-agent ls")" = "file
EDITOR [.]
teamcursor [--] [ls]"
test "$(HOME="$TEST_HOME" PATH="$EDITOR_BIN:$SHORT_PATH" zsh -fc \
  "source '$SELECTOR'; whence -w cursor cursor-agent")" = "cursor: command
cursor-agent: function"
test "$(HOME="$TEST_HOME" PATH="$TEST_HOME/.local/bin:$SHORT_PATH" bash -c \
  ". '$SELECTOR'; type -t cursor; cursor ls")" = "function
teamcursor [--] [ls]"

# POSIX shells cannot name a function `cursor-agent`: sourcing still finishes, `cursor` routes, `cursor-agent` is the CLI.
for posix_sh in "bash --posix" sh; do
  test "$(PATH="$SHORT_PATH" $posix_sh -c \
    ". '$SELECTOR'; cursor ls; cursor-agent -p hi")" = "teamcursor [--] [ls]
REAL cursor-agent [-p] [hi]"
done

HOME="$TEST_HOME" SHELL=/bin/zsh CLAUDE_DIR="$TEST_HOME/.claude" \
  PATH="$TEST_BIN:$PATH" \
  "$REPO_DIR/uninstall.sh" >/dev/null

test ! -e "$TEST_HOME/.claude/statusline-teamclaude.py"
test ! -e "$TEST_HOME/.claude/teamclaude-selector.sh"
! grep -q 'teamclaude-statusline selector' "$TEST_HOME/.bashrc"
grep -q "^alias claude='teamclaude run --'$" "$TEST_HOME/.bashrc"
grep -q '^export KEEP_ME=1$' "$TEST_HOME/.bashrc"
python3 - "$TEST_HOME/.claude/settings.json" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    settings = json.load(f)
assert settings == {"keep": True}
PY

ORCA_HOOK="$TEST_HOME/orca-statusline.sh"
printf '%s\n' '#!/bin/sh' "printf 'ORCA\\n'" > "$ORCA_HOOK"
chmod +x "$ORCA_HOOK"
python3 - "$TEST_HOME/.claude/settings.json" "$ORCA_HOOK" <<'PY'
import json, sys

settings_path, hook_path = sys.argv[1], sys.argv[2]
command = (
    f"if [ -x '{hook_path}' ]; then /bin/sh '{hook_path}'; "
    "else cat >/dev/null; fi"
)
with open(settings_path, "w") as f:
    json.dump({"keep": True, "statusLine": {"type": "command", "command": command}}, f)
PY
install_once
combined=$(printf '%s\n' '{"model":{"display_name":"Fable 5"}}' | \
  HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" \
  "$TEST_HOME/.claude/statusline-wrapper.py")
grep -q '^ORCA$' <<< "$combined"
grep -q '^Fable 5$' <<< "$combined"
test ! -e "$TEST_HOME/.claude/teamclaude-statusline-update-stamp"

HOME="$TEST_HOME" SHELL=/bin/bash CLAUDE_DIR="$TEST_HOME/.claude" \
  PATH="$TEST_BIN:$PATH" "$REPO_DIR/uninstall.sh" >/dev/null
python3 - "$TEST_HOME/.claude/settings.json" "$ORCA_HOOK" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    settings = json.load(f)
assert settings["keep"] is True
assert sys.argv[2] in settings["statusLine"]["command"]
PY

WEIRD_CLAUDE="$TEST_HOME/.claude weird ' \$()"
WEIRD_RC="$TEST_HOME/.weirdrc"
HOME="$TEST_HOME" SHELL=/bin/bash CLAUDE_DIR="$WEIRD_CLAUDE" \
  TEAMCLAUDE_SHELL_RC="$WEIRD_RC" NO_PROBE=1 PATH="$TEST_BIN:$PATH" \
  "$REPO_DIR/install.sh" >/dev/null
bash -n "$WEIRD_RC"
HOME="$TEST_HOME" CLAUDE_DIR="$WEIRD_CLAUDE" TEAMCLAUDE_SHELL_RC="$WEIRD_RC" \
  "$REPO_DIR/uninstall.sh" >/dev/null

NO_ACCOUNT_HOME="$TEST_DIR/no-account-home"
! HOME="$NO_ACCOUNT_HOME" SHELL=/bin/bash CLAUDE_DIR="$NO_ACCOUNT_HOME/.claude" \
  TC_TEST_NO_ACCOUNTS=1 NO_PROBE=1 PATH="$TEST_BIN:$PATH" \
  "$REPO_DIR/install.sh" >/dev/null 2>&1
test ! -e "$NO_ACCOUNT_HOME/.claude/settings.json"

NO_TC_HOME="$TEST_DIR/no-teamclaude-home"
NO_TC_BIN="$TEST_DIR/no-teamclaude-bin"
mkdir -p "$NO_TC_BIN"
ln -s /bin/bash "$NO_TC_BIN/bash"
ln -s "$(command -v python3)" "$NO_TC_BIN/python3"
! HOME="$NO_TC_HOME" SHELL=/bin/bash CLAUDE_DIR="$NO_TC_HOME/.claude" \
  NO_PROBE=1 PATH="$NO_TC_BIN" "$REPO_DIR/install.sh" >/dev/null 2>&1
test ! -e "$NO_TC_HOME/.claude/settings.json"
