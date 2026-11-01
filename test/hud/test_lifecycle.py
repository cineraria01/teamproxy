"""Offline lifecycle check with real tmux and PTYs; no login or inference."""

import fcntl
import json
import os
from pathlib import Path
import pty
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

HUD = Path(__file__).resolve().parents[2] / "src/hud"
sys.path.insert(0, str(HUD))
import launcher  # noqa: E402


def eventually(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("lifecycle condition timed out")


def alive(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith("Z")


def drain(fd, into):
    try:
        while chunk := os.read(fd, 4096):
            into.append(chunk)
    except OSError:
        pass


def herdr_footer():
    """Inside a Herdr terminal the CLI runs without tmux (so Herdr sees its status) and the footer is a Herdr
    split under it, closed when the CLI exits. Fake herdr-app and hc record what the launcher asked."""
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        folder = Path(directory)
        calls = folder / "calls.jsonl"
        log = f"open({str(calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + chr(10))\n"
        (folder / "herdr-app").write_text(
            f"#!{sys.executable}\nimport json, sys\n{log}"
            "a = sys.argv[1:]\n"
            "print(json.dumps({'spaces': [{'tabs': [{'terminals': [{'terminal': 't-me', 'pane': 'p-me'}]}]}]}"
            " if a == ['ls'] else {'pane': 'p-foot', 'terminal': 't-foot'} if a[1:2] == ['pane.split']"
            " else {'ok': True}))\n")
        (folder / "hc").write_text(
            f"#!{sys.executable}\nimport json, os, sys\n{log}"
            # t-me's program is on the launcher's tty; t-other's (this check) is not.
            "a = sys.argv[2]\n"
            "print(json.dumps({'pid': os.getppid()} if a == 't-me' else {'pid': int(os.environ['TEST_PID'])}"
            " if a == 't-other' else {'rows': 1}))\n")
        for name in ("teamcodex", "teamclaude"):
            (folder / name).write_text(
                f"#!{sys.executable}\nimport json, os, sys, time\n"
                f"open({str(folder / 'cli.json')!r}, 'w').write(json.dumps([sys.argv[1:], os.environ.get('TEAMCLAUDE_HUD')]))\n"
                # Like `teamcodex run`, the real CLI is a child of the launcher's child.
                "import subprocess\n"
                "slow = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']) if os.environ.get('SLOW') else None\n"
                f"open({str(folder / 'cli.pid')!r}, 'w').write(str(slow.pid if slow else 0))\n"
                "slow and slow.wait()\n")
        for name in ("herdr-app", "hc", "teamcodex", "teamclaude"):
            (folder / name).chmod(0o755)

        def run(arguments, terminal="t-me", stop=False):
            calls.unlink(missing_ok=True)
            (folder / "cli.json").unlink(missing_ok=True)
            (folder / "cli.pid").unlink(missing_ok=True)
            runner = (f"import launcher, os, sys\nopen({str(folder / 'launcher.pid')!r}, 'w').write(str(os.getpid()))\n"
                      "launcher.read_status = lambda path: {}\n"
                      "launcher.render = lambda data, **kw: ['footer']\nlauncher.claude_rows = lambda: ['footer']\n"
                      f"raise SystemExit(launcher.launch({arguments!r}))\n")
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 120, 0, 0))
            env = {k: v for k, v in os.environ.items() if k not in ("LINES", "COLUMNS", "TMUX", "TEAMCLAUDE_HUD")}
            env.update(PATH=directory + os.pathsep + env["PATH"], HC_TERMINAL_ID=terminal, SLOW="1" if stop else "",
                       TEST_PID=str(os.getpid()))
            env.update(PY=sys.executable, RUNNER=runner, HOLD="3" if stop else "0")

            # A shell owns the pty as its controlling terminal and outlives the launcher, as in a real terminal
            # (the launcher checks that tty; its exit must not hang the terminal up and kill the CLI for it).
            def own_terminal():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            launched = subprocess.Popen(["/bin/sh", "-c", '"$PY" -c "$RUNNER"; code=$?; sleep "$HOLD"; exit $code'],
                                        cwd=HUD, preexec_fn=own_terminal, stdin=slave, stdout=slave, stderr=slave,
                                        env=env)
            os.close(slave)
            # Read the terminal like a real one: an exiting shell otherwise waits for unread output to drain.
            output = []
            threading.Thread(target=lambda: drain(master, output), daemon=True).start()
            if stop:
                eventually(lambda: (folder / "cli.pid").exists())
                os.kill(int((folder / "launcher.pid").read_text()), signal.SIGTERM)
                eventually(lambda: calls.exists() and '"pane.close"' in calls.read_text())
                time.sleep(0.3)
                # Only the launcher was signalled; the CLI under `teamcodex run` must not outlive it.
                assert not alive(int((folder / "cli.pid").read_text())), "the CLI was left running"
            code = launched.wait(timeout=10)
            os.close(master)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return code, json.loads((folder / "cli.json").read_text()), recorded

        code, cli, recorded = run(["--yolo"])
        assert code == 0 and cli == [["run", "--", "--dangerously-bypass-approvals-and-sandbox"], None], cli
        assert [c[:2] for c in recorded] == [["get", "t-me"], ["ls"], ["do", "pane.split"], ["do", "pane.focus"],
                                             ["do", "layout.resize"], ["get", "t-foot"], ["do", "pane.close"]], recorded
        assert json.loads(recorded[2][2])["pane"] == "p-me" and json.loads(recorded[2][2])["direction"] == "down"
        assert json.loads(recorded[-1][2]) == {"pane": "p-foot"}
        # Claude's own status line drops the account table only when the footer shows it.
        assert run(["--claude"])[1] == [["run", "--"], "1"]
        # A terminal id that is not this terminal's (inherited) splits nothing; the CLI runs alone.
        code, cli, recorded = run(["--claude"], terminal="t-other")
        assert code == 0 and cli == [["run", "--"], None] and [c[:2] for c in recorded] == [["get", "t-other"]], recorded
        # Killing the launcher reaches the CLI and still closes the footer.
        code, cli, recorded = run([], stop=True)
        assert recorded[-1][:2] == ["do", "pane.close"], (code, recorded)


def check():
    # The footer cases must not see the Herdr terminal this check may run in.
    os.environ.pop("HC_TERMINAL_ID", None)
    tmux = shutil.which("tmux")
    assert tmux, "Install tmux to run this check"
    root = HUD
    # Print/version runs answer once and exit, so they never get a footer. Codex -p is --profile, not print.
    oneshot, modes = launcher.oneshot, launcher.MODES
    assert oneshot(["-p", "hi"], modes["agy"][2]) and oneshot(["--print=x"], modes["claude"][2])
    assert oneshot(["--model", "m", "--prompt", "x"], modes["agy"][2]) and oneshot(["--version"], modes["codex"][2])
    assert not oneshot(["--prompt-interactive", "x"], modes["agy"][2]) and not oneshot(["hi -p"], modes["claude"][2])
    assert not oneshot(["-p", "work"], modes["codex"][2]) and not oneshot([], modes["claude"][2])
    for flags in (["-p", "hi"], ["--single", "x"], ["--prompt-file=f"], ["--prompt-json", "{}"], ["-v"], ["--version"]):
        assert oneshot(flags, modes["grok"][2]), flags
    assert not oneshot(["--model", "grok-4.7"], modes["grok"][2])
    assert modes["grok"][1] == "Grok" and modes["grok"][3] == "M-Enter" and modes["grok"][4] == "--always-approve"
    for flags in (["-p", "hi"], ["--print"], ["--list-models"], ["-v"], ["--version"]):
        assert oneshot(flags, modes["cursor"][2]), flags
    assert not oneshot(["--model", "gpt-5"], modes["cursor"][2]) and not oneshot(["--resume", "x"], modes["cursor"][2])
    assert modes["cursor"][1] == "Cursor" and modes["cursor"][3] == "C-j" and modes["cursor"][4] == "--yolo"
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        fake = Path(directory) / "teamagy"
        fake.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o755)
        env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
        for arguments in (["-p", "hi"], ["--model", "m"]):  # print mode, or no terminal: run directly
            result = subprocess.run([sys.executable, str(HUD / "launcher.py"), "--agy", *arguments], env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert json.loads(result.stdout) == ["run", "--", *arguments], (arguments, result.stdout, result.stderr)
        # --yolo becomes each CLI's own skip-all-approvals flag; --keep-alive is ours wherever it sits.
        for name in ("teamclaude", "teamcodex", "teamgrok", "teamcursor"):
            (Path(directory) / name).write_text(fake.read_text())
            (Path(directory) / name).chmod(0o755)
        for pool, arguments, expected in (
                ("--agy", ["--yolo", "-p", "hi"], ["--dangerously-skip-permissions", "-p", "hi"]),
                ("--claude", ["-p", "hi", "--yolo"], ["-p", "hi", "--dangerously-skip-permissions"]),
                ("--grok", ["--yolo", "-p", "hi"], ["--always-approve", "-p", "hi"]),
                ("--grok", ["--", "models"], ["models"]),
                ("--cursor", ["--yolo", "-p", "hi"], ["--yolo", "-p", "hi"]),
                ("--cursor", ["--list-models"], ["--list-models"]),
                ("--cursor", ["--", "status"], ["status"]),
                (None, ["--yolo", "--keep-alive", "--version"], ["--dangerously-bypass-approvals-and-sandbox", "--version"])):
            result = subprocess.run([sys.executable, str(HUD / "launcher.py"), *([pool] if pool else []), *arguments],
                                    env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert json.loads(result.stdout) == ["run", "--", *expected], (arguments, result.stdout, result.stderr)
    print("PASS: agy print mode and no terminal skip the footer")
    # A terminal too short for the footer starts the CLI alone instead of refusing.
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        record = Path(directory) / "argv.json"
        fake = Path(directory) / "teamcodex"
        fake.write_text(f"#!{sys.executable}\nimport json, sys\nopen({str(record)!r}, 'w').write(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o755)
        runner = ("import launcher\nlauncher.read_status = lambda path: {}\n"
                  "launcher.render = lambda data, **kw: ['footer']\n"
                  "raise SystemExit(launcher.launch(['--model', 'm']))\n")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 8, 50, 0, 0))
        env = {k: v for k, v in os.environ.items() if k not in ("LINES", "COLUMNS")}
        env["PATH"] = directory + os.pathsep + env["PATH"]
        child = subprocess.Popen([sys.executable, "-c", runner], cwd=HUD, stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        assert child.wait(timeout=10) == 0
        os.close(master)
        assert json.loads(record.read_text()) == ["run", "--", "--model", "m"], record.read_text()
    print("PASS: a short terminal runs the CLI without the footer")
    herdr_footer()
    print("PASS: a Herdr terminal runs the CLI without tmux, the footer as a Herdr split")
    for mode in ("close", "detach", "keep-alive", "two-clients", "attach-failure", "keep-attach-failure",
                 "stale-server-cwd", "agy", "claude"):
        with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
            path = Path(directory)
            socket = path.name
            base = [tmux, "-L", socket, "-f", "/dev/null"]
            wrapper = path / "tmux"
            wrapper.write_text(f"#!{sys.executable}\n" +
                               "import os, sys\na = sys.argv[1:]\n" +
                               f"a[a.index('-L') + 1] = {socket!r}\n" +
                               # respawn-pane closes and reopens a PTY at once; macOS then
                               # intermittently fails with "fork failed: Device not configured".
                               "if 'respawn-pane' in a: sys.exit('respawn-pane races macOS PTY allocation')\n" +
                               ("if 'attach-session' in a: sys.exit(1)\n" if mode.endswith("attach-failure") else "") +
                               f"os.execv({tmux!r}, [{tmux!r}] + a)\n")
            wrapper.chmod(0o755)
            proxy = path / {"agy": "teamagy", "claude": "teamclaude"}.get(mode, "teamcodex")
            record = path / "processes.json"
            proxy.write_text(f"#!{sys.executable}\n" +
                             "import json, os, subprocess, sys, time\nfrom pathlib import Path\n" +
                             "child = subprocess.Popen(['sleep', '300'])\n" +
                             f"Path({str(record)!r}).write_text(json.dumps([os.getpid(), child.pid, sys.argv[1:], os.getcwd(), os.environ.get('TEAMCLAUDE_HUD')]))\n" +
                             "time.sleep(300)\n")
            proxy.chmod(0o755)
            arguments = (["--keep-alive"] if mode.startswith("keep") else []) + ["resume", "test-id"]
            if mode in ("agy", "claude"):
                arguments = ["--" + mode, "--model", "m"]
            runner = ("import launcher, shutil\noriginal = shutil.which\n" +
                      f"launcher.shutil.which = lambda name: {str(wrapper)!r} if name == 'tmux' else " +
                      f"{str(proxy)!r} if name == {proxy.name!r} else original(name)\n" +
                      "launcher.read_status = lambda path: {}\nlauncher.render = lambda data, **kw: ['footer']\n" +
                      "launcher.claude_rows = lambda: ['footer']\n" +
                      f"raise SystemExit(launcher.launch({arguments!r}))\n")
            masters, clients, pids = [], [], []

            def connect(command):
                master, slave = pty.openpty()
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                client = subprocess.Popen(command, cwd=root, stdin=slave, stdout=slave, stderr=slave,
                                          env={**os.environ, "TERM": "xterm-256color"}, start_new_session=True)
                os.close(slave)
                masters.append(master)
                clients.append(client)
                return master

            def sessions():
                result = subprocess.run(base + ["list-sessions", "-F", "#{session_name} #{session_attached}"],
                                        capture_output=True, text=True)
                return result.stdout.strip()

            try:
                if mode == "stale-server-cwd":
                    # tmux 3.7 keeps the server's start directory; once it is gone, new
                    # panes ignore `-c` and Codex would exit with ENOENT. Seed the server
                    # from a directory that is deleted before teamcodex launches.
                    stale = tempfile.mkdtemp(prefix="tcodex-stale-")
                    subprocess.run(base + ["new-session", "-d", "-s", "seed", "sleep 300"], check=True, cwd=stale)
                    os.rmdir(stale)
                master = connect([sys.executable, "-c", runner])
                if mode.endswith("attach-failure"):
                    eventually(lambda: clients[0].poll() is not None)
                    eventually(lambda: not sessions())
                    assert clients[0].returncode != 0
                else:
                    if mode == "stale-server-cwd":
                        eventually(record.exists)
                        subprocess.run(base + ["kill-session", "-t", "seed"], check=True)
                    eventually(lambda: sessions().endswith(" 1") and record.exists())
                    parent, child, forwarded, launched_in, hud = json.loads(record.read_text())
                    # Only Claude Code is told that the footer shows the account table.
                    assert hud == ("1" if mode == "claude" else None), (mode, hud)
                    pids = [parent, child]
                    # The launcher adds no --effort: Claude Code takes it from its own settings.
                    expected = ["--model", "m"] if mode in ("agy", "claude") else ["resume", "test-id"]
                    assert forwarded == ["run", "--", *expected], forwarded
                    assert launched_in == str(root), launched_in
                    session = sessions().split()[0]
                    panes = subprocess.check_output(base + ["list-panes", "-t", session, "-F", "#{pane_pid}"], text=True)
                    pids += [int(pid) for pid in panes.splitlines()]
                    # Neither pane sets a title, so the terminal tab gets the window name, not the host name.
                    titles = subprocess.check_output(base + ["list-panes", "-t", session, "-F", "#{T:set-titles-string}"],
                                                     text=True).split()
                    assert set(titles) == {{"agy": "agy", "claude": "Claude"}.get(mode, "Codex")}, titles
                    if mode == "two-clients":
                        second = connect(base + ["attach-session", "-t", session])
                        eventually(lambda: sessions().endswith(" 2"))
                    if mode == "detach":
                        subprocess.run(base + ["detach-client", "-s", session], check=True)
                    else:
                        os.close(master)
                        masters.remove(master)
                    eventually(lambda: clients[0].poll() is not None)
                    if mode in ("keep-alive", "two-clients"):
                        expected = " 0" if mode == "keep-alive" else " 1"
                        eventually(lambda: sessions().endswith(expected))
                        assert all(alive(pid) for pid in pids)
                        if mode == "two-clients":
                            os.close(second)
                            masters.remove(second)
                        else:
                            # Normal Codex exit still closes its session in keep-alive mode.
                            os.kill(parent, signal.SIGTERM)
                    eventually(lambda: not sessions())
                    eventually(lambda: not any(alive(pid) for pid in pids))
                print(f"PASS: {mode}")
            finally:
                subprocess.run(base + ["kill-server"], capture_output=True)
                for master in masters:
                    os.close(master)
                for client in clients:
                    if client.poll() is None:
                        client.terminate()
                    client.wait(timeout=5)
                if record.exists():
                    for pid in json.loads(record.read_text())[:2]:
                        if alive(pid):
                            os.kill(pid, signal.SIGTERM)


if __name__ == "__main__":
    check()
