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

# codex/grok/agy/cursor go to their pool wrappers by the same rule; update/login/logout go to the real CLI.
for pool in teamcodex teamgrok teamagy teamcursor; do
  printf '#!/bin/sh\necho "%s${*:+ $*}"\n' "$pool" > "$TEST_BIN/$pool"
done
for cli in codex grok agy cursor-agent; do
  printf '#!/bin/sh\necho "REAL %s $*"\n' "$cli" > "$TEST_BIN/$cli"
done
chmod +x "$TEST_BIN"/team* "$TEST_BIN"/codex "$TEST_BIN"/grok "$TEST_BIN"/agy "$TEST_BIN"/cursor-agent
short_calls='codex; codex --no-daemon; codex resume ID; codex update; codex login
grok; grok -p hi; grok models; grok logout
agy; agy -c; agy mcp list; agy update
cursor; cursor --yolo; cursor agent; cursor agent --yolo; cursor agent fix it; cursor ls; cursor update'
short_expected='teamcodex
teamcodex --no-daemon
teamcodex -- resume ID
REAL codex update
REAL codex login
teamgrok
teamgrok -p hi
teamgrok -- models
REAL grok logout
teamagy
teamagy -c
teamagy -- mcp list
REAL agy update
teamcursor
teamcursor --yolo
teamcursor
teamcursor --yolo
teamcursor -- agent fix it
teamcursor -- ls
REAL cursor-agent update'
short_bash=$(HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" \
  bash --noprofile --rcfile "$TEST_HOME/.bashrc" -ic "$short_calls" 2>/dev/null)
test "$short_bash" = "$short_expected"
short_zsh=$(PATH="$TEST_BIN:$PATH" \
  zsh -fc "alias codex=nope
source '$TEST_HOME/.claude/teamclaude-selector.sh'
$short_calls")
test "$short_zsh" = "$short_expected"

# Without a pool wrapper the short name is left alone (here only teamcodex is installed).
ONLY_CODEX_BIN="$TEST_DIR/only-codex-bin"
mkdir -p "$ONLY_CODEX_BIN"
cp "$TEST_BIN/teamcodex" "$ONLY_CODEX_BIN/"
test "$(PATH="$ONLY_CODEX_BIN:/usr/bin:/bin" bash -c \
  "source '$TEST_HOME/.claude/teamclaude-selector.sh'; type -t codex; type -t grok agy cursor || echo none")" = "function
none"
test "$(PATH="$ONLY_CODEX_BIN:/usr/bin:/bin" zsh -fc \
  "grok() { echo mine; }; source '$TEST_HOME/.claude/teamclaude-selector.sh'; whence -w codex agy cursor; grok")" = "codex: function
agy: none
cursor: none
mine"

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
