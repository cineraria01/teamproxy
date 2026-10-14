#!/usr/bin/env python3
"""Launch Claude Code (teamclaude --claude), Codex (teamcodex), agy (teamagy --agy) or grok (teamgrok --grok)
with a read-only account footer in an isolated tmux session."""

import os
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from statusline import claude_rows, read_status, render
from codex_login import login

# Each wrapper names its pool with the first argument (teamcodex passes none). `oneshot` flags print once and
# exit, so a footer would vanish with them; those runs, and runs without a terminal, skip the footer.
# `newline` is the key the CLI reads as a newline in its prompt: tmux cannot pass the CLI's own Shift+Enter
# protocol through, so the footer's tmux server maps Shift+Enter to it. `yolo` is the CLI's own flag that skips
# every approval; `--yolo` stands for it in every pool.
MODES = {
    "claude": ("teamclaude", "Claude", ("p", "print", "v", "version"), "M-Enter", "--dangerously-skip-permissions"),
    "agy": ("teamagy", "agy", ("p", "print", "prompt", "version"), "M-Enter", "--dangerously-skip-permissions"),
    "codex": ("teamcodex", "Codex", ("V", "version"), "C-j", "--dangerously-bypass-approvals-and-sandbox"),
    "grok": ("teamgrok", "Grok", ("p", "single", "prompt-file", "prompt-json", "v", "version"), "M-Enter",
             "--always-approve"),
}
# grok subcommands that print and exit, so they skip the footer like the oneshot flags.
GROK_ONESHOT_SUBCOMMANDS = ("agent", "models", "version")
# The caller's choices that must reach the CLI even when the HUD tmux server was started by an earlier launch
# (its panes get that server's environment): Codex home, and `claude N`'s pinned account.
FORWARD = ("CODEX_HOME", "TC_ACCT", "TEAMCLAUDE_STATUSLINE_INDEX")


def oneshot(arguments, flags):
    return any(a.startswith("-") and a.lstrip("-").split("=")[0] in flags for a in arguments)


def with_effort(arguments):
    # Claude Code's settings.json cannot store max and CLAUDE_CODE_EFFORT_LEVEL would override subagent effort, so
    # the conversation session gets max from the launcher unless the caller chose an effort.
    if any(a == "--effort" or a.startswith("--effort=") for a in arguments):
        return arguments
    return [*arguments, "--effort", "max"]


def launch(arguments):
    mode = arguments[0][2:] if arguments and arguments[0] in ("--claude", "--agy", "--grok") else "codex"
    if mode != "codex":
        arguments = arguments[1:]
    command, cli, flags, newline, yolo = MODES[mode]
    keep_alive = "--keep-alive" in arguments
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
              + (f"  {command}                  … (Claude: --effort max by default)\n" if mode == "claude" else "")
              + f"  {command} --yolo               {cli} without approval prompts ({yolo})\n"
              + f"  {command} --keep-alive [{cli} arguments]  Keep running after detach\n"
              "  Closing the terminal or Ctrl-b d stops the session by default.\n"
              f"  tmux -L {command}-hud attach   Reattach\n"
              f"Requires: tmux, Python 3, running {command} proxy")
        return 0
    # `teamcodex -- resume ID`: the `--` only gets Codex subcommands past the teamcodex wrapper.
    subcommand = bool(arguments) and arguments[0] == "--"
    if subcommand:
        arguments = arguments[1:]
    tmux, proxy = shutil.which("tmux"), shutil.which(command)
    if not proxy:
        sys.exit(f"Requires {command} on PATH")
    if (oneshot(arguments, flags) or (mode == "grok" and arguments[:1] and arguments[0] in GROK_ONESHOT_SUBCOMMANDS)
            or not (sys.stdin.isatty() and sys.stdout.isatty())):
        os.execv(proxy, [proxy, "run", "--", *arguments])
    if mode == "claude" and not subcommand:
        arguments = with_effort(arguments)
    if not tmux:
        sys.exit("Requires tmux. macOS: brew install tmux")
    try:
        data = read_status(Path.home() / f".config/{command}.json")
    except Exception:
        sys.exit(f"{command} proxy unavailable. Start it with: {command} server")
    size = shutil.get_terminal_size()
    # Claude rows come from the Claude Code status line; Codex adds a cache-usage row under the accounts.
    rows = (len(claude_rows()) if mode == "claude"
            else len(render(data, agy=mode == "agy", grok=mode == "grok")) + (mode == "codex"))
    # Width is free: the footer clips long rows. Too short for a footer, run the CLI alone instead of refusing.
    if size.lines < rows + 10:
        print(f"{command}: under {rows + 10} rows, starting without the account footer", file=sys.stderr)
        os.execv(proxy, [proxy, "run", "--", *arguments])
    session = cli.lower() + "-" + uuid.uuid4().hex[:8]
    # Own socket and config (src/hud/tmux.conf): the user's normal tmux server and settings stay untouched.
    base = [tmux, "-L", command + "-hud", "-f", str(Path(__file__).resolve().with_name("tmux.conf"))]
    env = dict(os.environ)
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    statusline = Path(__file__).resolve().with_name("statusline.py")
    cwd = os.getcwd()
    # Every tmux client runs from the home directory so a freshly spawned HUD
    # server never inherits a project directory. tmux 3.7 keeps the server's
    # start directory forever; once that directory is deleted, new panes ignore
    # `-c` and start in the dead directory, and Codex exits with ENOENT.
    home = str(Path.home())
    def run(*args):
        return subprocess.run([*base, *args], check=True, env=env, cwd=home,
                              capture_output=True, text=True).stdout.strip()

    # Codex starts in its own pane process once the layout is ready. Replacing a
    # placeholder with `respawn-pane -k` closes one PTY and opens another at once,
    # which macOS intermittently rejects with "fork failed: Device not configured"
    # (ENXIO from a /dev/ptmx slot race near a 16-PTY boundary).
    gate = "hud-" + session
    # Exiting the CLI also closes the footer, including in keep-alive mode.
    # The explicit cd keeps the caller's directory even on a HUD server whose
    # own start directory no longer exists (see the note above).
    script = (shlex.join([*base, "wait-for", gate]) + " && cd " + shlex.quote(cwd) + " && "
               # TEAMCLAUDE_HUD tells the Claude Code status line that the footer already shows the table.
               + shlex.join([*(["env", "TEAMCLAUDE_HUD=1"] if mode == "claude" else []), proxy, "run", "--", *arguments]) + "; "
               + shlex.join([*base, "kill-session", "-t", session]))
    created = False
    try:
        if mode == "codex":
            env.setdefault("CODEX_HOME", str(Path.home() / ".codex"))
        forward = [arg for name in FORWARD if name in env for arg in ("-e", f"{name}={env[name]}")]
        top = run("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session,
                  "-n", cli, "-c", cwd, "-x", str(size.columns), "-y", str(size.lines),
                  *forward, "/bin/sh", "-c", script)
        created = True
        run("set-option", "-t", session, "status", "off")
        run("set-option", "-t", session, "mouse", "on")
        run("bind-key", "-n", "S-Enter", "send-keys", newline)
        run("set-window-option", "-t", session, "pane-border-style", "fg=colour238")
        # The terminal tab shows the CLI's own title instead of the launcher process (Python). A pane without a
        # title of its own (the footer, or the CLI before it sets one) shows the window name: Claude, Codex, agy, Grok.
        run("set-option", "-t", session, "set-titles", "on")
        run("set-option", "-t", session, "set-titles-string",
            "#{?#{==:#{pane_title},#{host}},#{window_name},#{pane_title}}")
        footer = run("split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-l", str(rows), "-t", top,
                     sys.executable, str(statusline), "--watch", *(["--codex-pane", top] if mode == "codex" else ["--" + mode]))
        for event in ("client-attached", "client-resized"):
            run("set-hook", "-t", session, event, f"resize-pane -t {footer} -y {rows}")
        if not keep_alive:
            # Setting this before the first attachment destroys the new session immediately.
            run("set-hook", "-a", "-t", session, "client-attached",
                f"set-option -t {session} destroy-unattached on")
        run("select-pane", "-t", top)
        run("wait-for", "-S", gate)
    except subprocess.CalledProcessError as error:
        if created:
            subprocess.run([*base, "kill-session", "-t", session], env=env, cwd=home, capture_output=True)
        sys.exit(f"Could not start the {cli} footer: " + (error.stderr or str(error)).strip())
    try:
        return subprocess.call([*base, "attach-session", "-t", session], env=env, cwd=home)
    finally:
        # Failed attachment must not orphan a new session or stop another attached client.
        state = subprocess.run([*base, "display-message", "-p", "-t", session,
                                "#{session_attached} #{session_last_attached}"],
                               env=env, cwd=home, capture_output=True, text=True).stdout.split()
        if state and state[0] == "0" and (not keep_alive or len(state) == 1):
            subprocess.run([*base, "kill-session", "-t", session], env=env, cwd=home, capture_output=True)


if __name__ == "__main__":
    sys.exit(launch(sys.argv[1:]))
