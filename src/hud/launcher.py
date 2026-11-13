#!/usr/bin/env python3
"""Launch Claude Code (teamclaude --claude), Codex (teamcodex), agy (teamagy --agy), grok (teamgrok --grok) or
cursor-agent (teamcursor --cursor) with a read-only account footer: a Herdr split inside Herdr core, a new
Herdr core terminal outside it. Without hc the CLI runs alone (tmux footer removed 2026-11-13)."""

import json
import os
import shutil
import signal
import subprocess
import sys
import uuid
from pathlib import Path

from statusline import claude_rows, read_status, render
from codex_login import login

# Each wrapper names its pool with the first argument (teamcodex passes none). `oneshot` flags print once and
# exit, so a footer would vanish with them; those runs, and runs without a terminal, skip the footer.
# `yolo` is the CLI's own flag that skips every approval; `--yolo` stands for it in every pool.
MODES = {
    "claude": ("teamclaude", "Claude", ("p", "print", "v", "version"), "--dangerously-skip-permissions"),
    "agy": ("teamagy", "agy", ("p", "print", "prompt", "version"), "--dangerously-skip-permissions"),
    "codex": ("teamcodex", "Codex", ("V", "version"), "--dangerously-bypass-approvals-and-sandbox"),
    "grok": ("teamgrok", "Grok", ("p", "single", "prompt-file", "prompt-json", "v", "version"), "--always-approve"),
    # --yolo is cursor-agent's own flag already.
    "cursor": ("teamcursor", "Cursor", ("p", "print", "list-models", "v", "version", "h"), "--yolo"),
}
# Subcommands that print and exit (or manage settings), so they skip the footer like the oneshot flags.
# cursor-agent's chat commands (agent, ls, resume) keep it.
ONESHOT_SUBCOMMANDS = {
    "grok": ("agent", "models", "version"),
    "cursor": ("about", "bedrock", "create-chat", "generate-rule", "help", "install-shell-integration", "login",
               "logout", "mcp", "models", "persist", "plugin", "rule", "status", "team",
               "uninstall-shell-integration", "update", "whoami", "worker"),
}
# The caller's choices that must reach the CLI in a new hc terminal (it gets the core's environment, not ours):
# Codex home, and `claude N`'s pinned account.
FORWARD = ("CODEX_HOME", "TC_ACCT", "TEAMCLAUDE_STATUSLINE_INDEX")
# Set in the terminal hc_terminal starts: that launch must never start another one.
HC_STARTED = "TEAMPROXY_HUD_HC_STARTED"


def oneshot(arguments, flags):
    return any(a.startswith("-") and a.lstrip("-").split("=")[0] in flags for a in arguments)


def with_effort(arguments):
    # The conversation session gets xhigh from the launcher unless the caller chose an effort; CLAUDE_CODE_EFFORT_LEVEL
    # is not used because it would override subagent effort too (2026-11-04 to 11-09 this was max).
    # 2026-11-10 사용자 결정: 지휘 기본 Fable 5.2 xhigh, 모델은 settings.json 기본값
    # (no --model here: `<pool> run` adds the config's launchModel, so keep that equal to the settings.json model).
    if any(a == "--effort" or a.startswith("--effort=") for a in arguments):
        return arguments
    return [*arguments, "--effort", "xhigh"]


def herdr_footer(mode, cli):
    """Run the CLI in this Herdr terminal with the account footer as a Herdr split under it. Without
    herdr-app or hc, or when this terminal has no pane (a background hc run), the CLI runs alone and says why in
    one line, except Claude without herdr-app: its status line shows the accounts then."""
    app, hc = shutil.which("herdr-app"), shutil.which("hc")

    # Herdr calls never get the terminal: after a hangup it is gone and a program reading it fails to start.
    def call(*args):
        return json.loads(subprocess.run(args, check=True, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                         timeout=5).stdout)

    footer, child = {}, []

    def close():
        if footer.get("pane"):
            subprocess.run([app, "do", "pane.close", json.dumps({"pane": footer["pane"]})],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=5)

    # Hangup or kill reaches the whole job: `teamcodex run` starts the real CLI as its own child, so sending it
    # to the direct child alone would leave the CLI holding the terminal. The launcher, now ignoring both, waits
    # for the CLI and closes the footer. Before the CLI runs it just ends the launcher (through the finally).
    def forward(sig, _frame):
        if not child:
            raise SystemExit(1)
        for each in (signal.SIGHUP, signal.SIGTERM):
            signal.signal(each, signal.SIG_IGN)
        # A shell without job control (`sh -c 'teamcodex; next'`) shares the group: then only the child.
        if os.getpgrp() == os.getpid():
            os.killpg(os.getpgrp(), sig)
        else:
            child[0].send_signal(sig)

    # Ctrl+C belongs to the CLI; the launcher stays to close the footer when the CLI exits.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, forward)
    env = dict(os.environ)
    # Only a footer this launch opened may hide the Claude status line's table; an inherited value would hide it
    # with no footer to show it.
    env.pop("TEAMCLAUDE_HUD", None)
    try:
        try:
            if not app:
                raise RuntimeError("herdr-app not installed")
            if not hc:
                raise RuntimeError("hc not installed")
            me = os.environ.get("HC_TERMINAL_ID")
            if not me:
                raise RuntimeError("not in a Herdr terminal")
            data = read_status(Path.home() / f".config/{MODES[mode][0]}.json")
            # Codex adds a cache-usage row under the accounts, read from the CLI under this launcher.
            rows = len(claude_rows()) if mode == "claude" else len(
                render(data, agy=mode == "agy", grok=mode == "grok", cursor=mode == "cursor")) + (mode == "codex")
            if shutil.get_terminal_size().lines < rows + 10:
                raise RuntimeError(f"under {rows + 10} rows")
            # HC_TERMINAL_ID can be inherited from another terminal (a multiplexer, a pty an agent opened): split only
            # when that terminal's program is on this launcher's own tty.
            program = str(call(hc, "get", me).get("pid") or 0)
            tty = subprocess.run(["ps", "-o", "tty=", "-p", program], stdin=subprocess.DEVNULL, capture_output=True,
                                 text=True).stdout.strip()
            if not tty or tty != os.ttyname(0).removeprefix("/dev/"):
                raise RuntimeError(f"{me} is not this terminal")
            pane = next((t["pane"] for space in call(app, "ls")["spaces"] for tab in space["tabs"]
                         for t in tab["terminals"] if t["terminal"] == me), None)
            if not pane:
                raise RuntimeError(f"{me} has no pane")
            statusline = str(Path(__file__).resolve().with_name("statusline.py"))
            footer = call(app, "do", "pane.split", json.dumps({
                "direction": "down", "pane": pane,
                "argv": [sys.executable, statusline, "--watch",
                         *(["--codex-pid", str(os.getpid())] if mode == "codex" else ["--" + mode])]}))
            call(app, "do", "pane.focus", json.dumps({"pane": pane}))
            # Herdr sizes panes in pixels; about 20 px a row plus the pane's own chrome, then corrected from
            # the rows the footer terminal really got. ponytail: three corrections, a rows API if Herdr adds one.
            px = 60 + 20 * rows
            for _ in range(4):
                call(app, "do", "layout.resize", json.dumps({"id": footer["pane"], "px": px}))
                got = call(hc, "get", footer["terminal"]).get("rows") or rows
                if got == rows:
                    break
                px = max(40, px + 20 * (rows - got))
            if mode == "claude":
                # The Claude Code status line drops the table the footer already shows.
                env["TEAMCLAUDE_HUD"] = "1"
        except Exception as error:
            close()
            footer = {}
            # Without herdr-app (a machine with Herdr core only) Claude loses nothing: with no TEAMCLAUDE_HUD its
            # status line draws the account table itself, so the note would be noise. The other pools have no such
            # fallback.
            if app or mode != "claude":
                print(f"{MODES[mode][0]}: starting without the account footer ({error})", file=sys.stderr)
        child.append(subprocess.Popen(cli, env=env,
                                      preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL)))
        return child[0].wait()
    finally:
        for sig in (signal.SIGHUP, signal.SIGTERM):
            signal.signal(sig, signal.SIG_IGN)
        close()


def hc_terminal(hc, cli, raw):
    """Outside Herdr core: start this launcher again, with the same arguments, in a new hc terminal (there it takes
    the Herdr path) and attach this terminal to it. Detaching (Ctrl+\\) leaves it running; its exit code comes back."""
    # hc terminals get the core's environment, not ours: PATH finds the same wrapper, FORWARD keeps the choices.
    env = ["env", f"{HC_STARTED}=1", *(f"{name}={os.environ[name]}" for name in ("PATH", *FORWARD) if name in os.environ)]
    started = subprocess.run([hc, "run", "--bg", "--json", "--no-parent", "--name", cli.lower() + "-" + uuid.uuid4().hex[:8],
                              "--cwd", os.getcwd(), "--", *env, sys.executable, str(Path(__file__).resolve()), *raw],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if started.returncode:
        sys.exit(f"Could not start {cli} in Herdr core: " + (started.stderr or started.stdout).strip())
    address = json.loads(started.stdout)["address"]
    subprocess.call([hc, "attach", address])
    got = subprocess.run([hc, "get", "--json", address], stdin=subprocess.DEVNULL, capture_output=True, text=True)
    state = json.loads(got.stdout) if got.returncode == 0 else {}
    if state.get("state") != "finished":
        print(f"{cli} is still running in Herdr core: hc attach {address}", file=sys.stderr)
        return 0
    code = state.get("exit_code")
    if code != 0:
        # It may have ended before the attach showed anything (a missing proxy): show its last lines.
        sys.stderr.write(subprocess.run([hc, "read", "--lines", "20", address], stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True).stdout)
    subprocess.run([hc, "rm", address], stdin=subprocess.DEVNULL, capture_output=True)
    return 1 if code is None else code


def launch(arguments):
    raw = list(arguments)
    mode = arguments[0][2:] if arguments and arguments[0] in ("--claude", "--agy", "--grok", "--cursor") else "codex"
    if mode != "codex":
        arguments = arguments[1:]
    command, cli, flags, yolo = MODES[mode]
    # --keep-alive (the old tmux footer's) is still taken and dropped: an hc terminal always outlives a detach.
    arguments = [yolo if a == "--yolo" else a for a in arguments if a != "--keep-alive"]
    if arguments and arguments[0] == "login" and mode == "codex":
        return login(arguments[1:])
    if arguments == ["--help"]:
        print(f"Usage: {command} [{cli} flags]\n"
              f"  {command}                  {cli} + live account footer\n"
              + ("  teamcodex login [--name NAME]  Add an account with browser callback paste\n"
                 "  teamcodex -- resume ID     Continue an existing conversation\n" if mode == "codex" else
                 f"  {command} -p PROMPT          Print mode, no footer (also without a terminal)\n"
                 f"  {command} -- SUBCOMMAND      {cli} subcommand, no footer\n")
              + (f"  {command}                  … (Claude: --effort xhigh by default)\n" if mode == "claude" else "")
              + f"  {command} --yolo               {cli} without approval prompts ({yolo})\n"
              + "  Outside Herdr core it runs in a new hc terminal: Ctrl+\\ detaches, hc attach ADDRESS reattaches.\n"
              "  Without hc (herdr-core) it runs without the footer.\n"
              f"Requires: Python 3, running {command} proxy; the footer needs hc (herdr-core)")
        return 0
    # `teamcodex -- resume ID`: the `--` only gets Codex subcommands past the teamcodex wrapper.
    subcommand = bool(arguments) and arguments[0] == "--"
    if subcommand:
        arguments = arguments[1:]
    proxy = shutil.which(command)
    if not proxy:
        sys.exit(f"Requires {command} on PATH")
    if (oneshot(arguments, flags) or (arguments[:1] and arguments[0] in ONESHOT_SUBCOMMANDS.get(mode, ()))
            or not (sys.stdin.isatty() and sys.stdout.isatty())):
        os.execv(proxy, [proxy, "run", "--", *arguments])
    if mode == "claude" and not subcommand:
        arguments = with_effort(arguments)
    hc = shutil.which("hc")
    if hc and not os.environ.get("HC_TERMINAL_ID") and not os.environ.get(HC_STARTED):
        return hc_terminal(hc, cli, raw)
    # Inside a Herdr terminal the CLI runs in it directly and the footer is a Herdr split below it, so Herdr sees
    # the CLI's working/question/done status. Without hc (or herdr-app) the CLI runs alone and says why.
    return herdr_footer(mode, [proxy, "run", "--", *arguments])


if __name__ == "__main__":
    sys.exit(launch(sys.argv[1:]))
