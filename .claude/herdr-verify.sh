#!/usr/bin/env bash
# teamproxy landing check — `hc-lane land main` runs it after the rebase and pushes only when it passes.
# The full `npm test` is not the gate: 41~48 environment-bound failures exist on origin/main too. So:
#   1. npx eslint src/
#   2. node --test on what changed since `git merge-base HEAD origin/main`: changed test/*.test.js, plus
#      test/<name>.test.js and test/<name>-*.test.js for each changed src/<name>.js
#   3. python3 test/hud/test_*.py when src/hud/ or test/hud/ changed
# Tests run without the variables a teamclaude session hands down (run-env/run-recovery fail under them).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base=$(git merge-base HEAD origin/main)
clean=(env -u TEAMCLAUDE_SESSION_SUPERVISED -u TEAMCLAUDE_HUD -u TMUX -u TMUX_PANE)

echo "[herdr-verify] eslint src/"
npx --yes eslint src/

tests=()
hud=0
while IFS= read -r f; do
  case $f in
    test/hud/*|src/hud/*) hud=1 ;;
    test/*.test.js) [ -f "$f" ] && tests+=("$f") ;;
    src/*.js)
      name=$(basename "$f" .js)
      for t in "test/$name.test.js" test/"$name"-*.test.js; do [ -f "$t" ] && tests+=("$t"); done ;;
  esac
done < <(git diff --name-only "$base" HEAD)

if [ "${#tests[@]}" -gt 0 ]; then
  # Unique, in a stable order (bash 3.2: no mapfile).
  list=$(printf '%s\n' "${tests[@]}" | sort -u)
  tests=()
  while IFS= read -r t; do tests+=("$t"); done <<< "$list"
  echo "[herdr-verify] node --test ${tests[*]}"
  "${clean[@]}" node --test --test-concurrency=1 "${tests[@]}"
else
  echo "[herdr-verify] no changed node tests since $(git rev-parse --short "$base")"
fi

if [ "$hud" = 1 ]; then
  for t in test/hud/test_*.py; do
    echo "[herdr-verify] python3 $t"
    "${clean[@]}" python3 "$t"
  done
fi
echo "[herdr-verify] ok"
