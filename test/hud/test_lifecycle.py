"""Offline lifecycle check with PTYs and fake Herdr programs; no login or inference (tmux footer removed 2026-11-13)."""

import fcntl
import json
import os
from pathlib import Path
import pty
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
    """Inside a Herdr terminal the CLI runs in it directly (so Herdr sees its status) and the footer is a Herdr
    split under it, closed when the CLI exits. Fake herdr-app and hc record what the launcher asked."""
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        folder = Path(directory)
        calls = folder / "calls.jsonl"
        log = f"open({str(calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + chr(10))\n"
        # herdr-app and hc sit in folders of their own so a run can leave either off PATH (a machine with Herdr core
        # only, or an HC_TERMINAL_ID inherited onto a PATH without hc).
        (folder / "app").mkdir()
        (folder / "core").mkdir()
        (folder / "app/herdr-app").write_text(
            f"#!{sys.executable}\nimport json, os, sys\n{log}"
            "a = sys.argv[1:]\n"
            "print(json.dumps({'spaces': [{'tabs': [{'terminals': [{'terminal': 't-me', 'pane': 'p-me'}]}]}]}"
            " if a == ['ls'] else {'pane': 'p-foot', 'terminal': 't-foot'} if a[1:2] == ['pane.split']"
            " else {'ok': True}))\n"
            # The footer's size, like Herdr: a split starts at half the pane (FOOT_FIRST: placeholder rows shown
            # once before that), and a resize lands only after hc has answered once more with the old rows, or
            # FOOT_LAG seconds later (load), or never (FOOT_DROP).
            # 20 px a row plus FOOT_CHROME px (60, as measured; more makes the first resize fall a row short).
            f"state = {str(folder / 'foot.json')!r}\n"
            "if a[1:2] == ['pane.split']:\n"
            "    first = os.environ.get('FOOT_FIRST')\n"
            "    json.dump({'rows': int(first) if first else 15, 'steps': [15] if first else [], 'late': []},"
            " open(state, 'w'))\n"
            "if a[1:2] == ['layout.resize'] and not os.environ.get('FOOT_DROP'):\n"
            "    import time\n"
            "    foot = json.load(open(state))\n"
            "    target = max(0, (json.loads(a[2])['px'] - int(os.environ.get('FOOT_CHROME', '60'))) // 20)\n"
            "    lag = float(os.environ.get('FOOT_LAG', '0'))\n"
            "    foot['late'].append([time.time() + lag, target]) if lag else foot['steps'].append(target)\n"
            "    json.dump(foot, open(state, 'w'))\n")
        (folder / "core/hc").write_text(
            f"#!{sys.executable}\nimport json, os, sys\n{log}"
            # t-me's program is on the launcher's tty; t-other's (this check) is not.
            "a = sys.argv[2]\n"
            "if a == 't-foot':\n"
            "    if os.environ.get('FOOT_FAIL'): sys.exit('core down')\n"
            "    import time\n"
            f"    foot = json.load(open({str(folder / 'foot.json')!r}))\n"
            "    while foot['late'] and foot['late'][0][0] <= time.time(): foot['rows'] = foot['late'].pop(0)[1]\n"
            "    print(json.dumps({} if os.environ.get('FOOT_NOROWS') else {'rows': foot['rows']}))\n"
            "    if foot['steps']: foot['rows'] = foot['steps'].pop(0)\n"
            f"    json.dump(foot, open({str(folder / 'foot.json')!r}, 'w'))\n"
            "else: print(json.dumps({'pid': os.getppid()} if a == 't-me' else {'pid': int(os.environ['TEST_PID'])}))\n")
        for name in ("teamcodex", "teamclaude", "teamgrok"):
            (folder / name).write_text(
                f"#!{sys.executable}\nimport json, os, sys, time\n"
                f"open({str(folder / 'cli.json')!r}, 'w').write(json.dumps([sys.argv[1:], os.environ.get('TEAMCLAUDE_HUD')]))\n"
                # Like `teamcodex run`, the real CLI is a child of the launcher's child.
                "import subprocess\n"
                "slow = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']) if os.environ.get('SLOW') else None\n"
                f"open({str(folder / 'cli.pid')!r}, 'w').write(str(slow.pid if slow else 0))\n"
                "slow and slow.wait()\n")
        for name in ("app/herdr-app", "core/hc", "teamcodex", "teamclaude", "teamgrok"):
            (folder / name).chmod(0o755)

        def run(arguments, terminal="t-me", stop=False, jobs=True, app=True, core=True, lines=50, **inherited):
            calls.unlink(missing_ok=True)
            (folder / "cli.json").unlink(missing_ok=True)
            (folder / "cli.pid").unlink(missing_ok=True)
            runner = (f"import launcher, os, sys\nopen({str(folder / 'launcher.pid')!r}, 'w').write(str(os.getpid()))\n"
                      "launcher.read_status = lambda path: {}\n"
                      "launcher.render = lambda data, **kw: ['footer']\nlauncher.claude_rows = lambda: ['footer']\n"
                      f"raise SystemExit(launcher.launch({arguments!r}))\n")
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", lines, 120, 0, 0))
            env = {k: v for k, v in os.environ.items() if k not in ("LINES", "COLUMNS", "TEAMCLAUDE_HUD")}
            # Without app (core), no herdr-app (hc) anywhere on PATH, whatever this machine has installed. Whole
            # folders go; what the run needs besides the fakes is the shell's sleep, and Python by its absolute path.
            gone = [name for name, keep in (("herdr-app", app), ("hc", core)) if not keep]
            path = [d for d in env["PATH"].split(os.pathsep) if not any((Path(d) / name).exists() for name in gone)]
            fakes = [directory, *([str(folder / "app")] if app else []), *([str(folder / "core")] if core else [])]
            env.update(PATH=os.pathsep.join([*fakes, *path]),
                       HC_TERMINAL_ID=terminal, SLOW="1" if stop else "", TEST_PID=str(os.getpid()), **inherited)
            env.update(PY=sys.executable, RUNNER=runner, HOLD="3" if stop else "0")

            # A shell owns the pty as its controlling terminal and outlives the launcher, as in a real terminal
            # (the launcher checks that tty; its exit must not hang the terminal up and kill the CLI for it).
            def own_terminal():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            # `set -m`: a job of its own, as an interactive shell (or the wrappers' exec) gives the launcher.
            # Without it the launcher shares the shell's group, as under `sh -c 'teamcodex; next'`.
            launched = subprocess.Popen(["/bin/sh", "-c", ("set -m; " if jobs else "")
                                         + '"$PY" -c "$RUNNER"; code=$?; sleep "$HOLD"; exit $code'],
                                        cwd=HUD, preexec_fn=own_terminal, stdin=slave, stdout=slave, stderr=slave,
                                        env=env)
            os.close(slave)
            # Read the terminal like a real one: an exiting shell otherwise waits for unread output to drain.
            output = []
            reader = threading.Thread(target=lambda: drain(master, output), daemon=True)
            reader.start()
            if stop:
                eventually(lambda: (folder / "cli.pid").exists())
                os.kill(int((folder / "launcher.pid").read_text()), signal.SIGTERM)
                eventually(lambda: calls.exists() and '"pane.close"' in calls.read_text())
                time.sleep(0.3)
                # Only the launcher was signalled; the CLI under `teamcodex run` must not outlive it. Sharing the
                # shell's group, only the direct child gets the signal (the shell must live on).
                grandchild = int((folder / "cli.pid").read_text())
                assert not jobs or not alive(grandchild), "the CLI was left running"
                if alive(grandchild):
                    os.kill(grandchild, signal.SIGKILL)
            code = launched.wait(timeout=10)
            reader.join(timeout=2)
            os.close(master)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return code, json.loads((folder / "cli.json").read_text()), recorded, b"".join(output).decode()

        note = "starting without the account footer"
        # Codex: the account rows plus its cache-usage row.
        code, cli, recorded, output = run(["--yolo"])
        assert code == 0 and cli == [["run", "--", "--dangerously-bypass-approvals-and-sandbox"], None], cli
        # The footer gets its two rows even though hc reports the old rows once after each resize: corrected from
        # that stale answer, it used to end at 40 px, one row or none (seen on Cursor 2026-11-13).
        assert [c[:2] for c in recorded] == [["get", "t-me"], ["ls"], ["do", "pane.split"], ["do", "pane.focus"],
                                             ["get", "t-foot"], ["get", "t-foot"], ["do", "layout.resize"],
                                             ["get", "t-foot"], ["get", "t-foot"], ["do", "pane.close"]], recorded
        def foot():
            return json.loads((folder / "foot.json").read_text())

        def final():
            """The rows the footer ends with, once every resize Herdr still holds has landed."""
            held = [rows for _, rows in foot()["late"]] or foot()["steps"]
            return held[-1] if held else foot()["rows"]

        assert final() == 2, foot()
        assert json.loads(recorded[2][2])["pane"] == "p-me" and json.loads(recorded[2][2])["direction"] == "down"
        # Codex's footer reads the cache usage of the CLI under this launcher.
        assert json.loads(recorded[2][2])["argv"][-2:] == ["--codex-pid", (folder / "launcher.pid").read_text()]
        assert json.loads(recorded[-1][2]) == {"pane": "p-foot"}
        assert note not in output, output
        resizes = lambda recorded: [json.loads(c[2])["px"] for c in recorded if c[:2] == ["do", "layout.resize"]]
        # A new split that first reports placeholder rows: the first read after the resize differs from it but is
        # still the split's own size, so it must not be taken as the resize's result (that path ended at 40 px).
        code, cli, recorded, output = run(["--yolo"], FOOT_FIRST="120")
        assert code == 0 and resizes(recorded) == [100] and final() == 2, (recorded, foot())
        # A size formula that is off moves the footer to another row count than before: corrected from there.
        code, cli, recorded, output = run(["--yolo"], FOOT_CHROME="80")
        assert code == 0 and resizes(recorded) == [100, 120] and final() == 2, (recorded, foot())
        # A resize that lands later than a second (load) is not corrected from the rows it had not changed yet:
        # the same px goes again, never 40 px (that ended as one row once the queued resize landed).
        for lag in ("1.2", "2.5"):
            code, cli, recorded, output = run(["--yolo"], FOOT_LAG=lag)
            px = resizes(recorded)
            assert code == 0 and set(px) == {100} and len(px) > 1 and final() == 2, (lag, recorded, foot())
            assert note not in output, output
        # A resize Herdr drops: the same px four times, the footer stays too tall, and the CLI starts as usual.
        code, cli, recorded, output = run(["--yolo"], FOOT_DROP="1")
        assert code == 0 and resizes(recorded) == [100] * 4 and final() == 15 and note not in output, (recorded, output)
        assert cli == [["run", "--", "--dangerously-bypass-approvals-and-sandbox"], None], cli
        # hc without rows for the footer is a failure, not the target: the footer is closed, the CLI starts alone.
        code, cli, recorded, output = run(["--yolo"], FOOT_NOROWS="1")
        assert code == 0 and cli[0] == ["run", "--", "--dangerously-bypass-approvals-and-sandbox"], cli
        assert recorded[-1][:2] == ["do", "pane.close"] and output.count(note) == 1, (recorded, output)
        # hc failing while the footer is sized: the footer is closed and the CLI starts alone, saying why.
        code, cli, recorded, output = run(["--yolo"], FOOT_FAIL="1")
        assert code == 0 and cli == [["run", "--", "--dangerously-bypass-approvals-and-sandbox"], None], cli
        assert recorded[-1][:2] == ["do", "pane.close"] and "pane.split" in str(recorded), recorded
        assert output.count(note) == 1, output
        # Claude's own status line drops the account table only when the footer shows it.
        assert run(["--claude"])[1] == [["run", "--", "--effort", "xhigh"], "1"]
        assert json.loads(run(["--grok"])[2][2][2])["argv"][-1] == "--grok"
        # A terminal too short for the footer starts the CLI alone instead of refusing, and says why.
        code, cli, recorded, output = run(["--grok"], lines=8)
        assert code == 0 and cli == [["run", "--"], None] and "pane.split" not in str(recorded), (code, cli, recorded)
        assert f"teamgrok: {note} (under 11 rows)" in output, output
        # A terminal id that is not this terminal's (inherited) splits nothing; the CLI runs alone, says why, and an
        # inherited TEAMCLAUDE_HUD does not hide the status line's table with no footer to show it.
        code, cli, recorded, output = run(["--claude"], terminal="t-other", TEAMCLAUDE_HUD="1")
        assert code == 0 and cli == [["run", "--", "--effort", "xhigh"], None], (code, cli)
        assert [c[:2] for c in recorded] == [["get", "t-other"]], recorded
        assert f"teamclaude: {note} (t-other is not this terminal)" in output, output
        # Herdr core without herdr-app: Claude starts quietly, its status line draws the account table instead.
        code, cli, recorded, output = run(["--claude"], app=False, TEAMCLAUDE_HUD="1")
        assert code == 0 and not recorded and note not in output, (code, recorded, output)
        assert cli == [["run", "--", "--effort", "xhigh"], None], cli
        # The other pools have no such fallback: they still say why there is no footer, in one line.
        for pool, command in ((None, "teamcodex"), ("--grok", "teamgrok")):
            code, cli, recorded, output = run([pool] if pool else [], app=False)
            assert code == 0 and not recorded and cli[0] == ["run", "--"], (pool, code, cli, recorded)
            assert output.count(note) == 1 and f"{command}: {note} (herdr-app not installed)" in output, (pool, output)
        # Without hc as well it is still a machine without herdr-app: Claude stays quiet.
        code, cli, recorded, output = run(["--claude"], app=False, core=False)
        assert code == 0 and not recorded and note not in output, (code, recorded, output)
        assert cli == [["run", "--", "--effort", "xhigh"], None], cli
        # Codex on a machine with neither (no Herdr at all): the note names hc, the first thing missing.
        code, cli, recorded, output = run([], app=False, core=False)
        assert code == 0 and not recorded and cli[0] == ["run", "--"], (code, cli, recorded)
        assert output.count(note) == 1 and f"teamcodex: {note} (hc not installed)" in output, output
        # herdr-app but no hc on PATH (an inherited HC_TERMINAL_ID): the note names the program that is missing, and
        # Claude says it too.
        for pool, command, argv in (("--claude", "teamclaude", ["--effort", "xhigh"]), (None, "teamcodex", [])):
            code, cli, recorded, output = run([pool] if pool else [], core=False, TEAMCLAUDE_HUD="1")
            assert code == 0 and not recorded and cli == [["run", "--", *argv], None], (pool, code, cli, recorded)
            assert output.count(note) == 1 and f"{command}: {note} (hc not installed)" in output, (pool, output)
        # Killing the launcher reaches the CLI and still closes the footer.
        code, cli, recorded, _ = run([], stop=True)
        # The shell that started the launcher is not signalled with it (it exits normally, not by SIGTERM).
        assert code >= 0 and recorded[-1][:2] == ["do", "pane.close"], (code, recorded)
        code, cli, recorded, _ = run([], stop=True, jobs=False)
        assert code >= 0 and recorded[-1][:2] == ["do", "pane.close"], (code, recorded)


def hc_terminal():
    """Outside Herdr core an interactive launch starts the launcher again, same arguments, in a new hc terminal and
    attaches to it: the exit code and a failed run's last lines come back. A fake hc records the calls."""
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        folder = Path(directory)
        calls = folder / "calls.jsonl"
        (folder / "hc").write_text(
            f"#!{sys.executable}\nimport json, os, sys\n"
            f"open({str(calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + chr(10))\n"
            "a, state = sys.argv[1:], os.environ.get('STATE', 'finished')\n"
            "if a[0] == 'run' and os.environ.get('FAIL'): sys.exit('core down')\n"
            "print(json.dumps({'address': 'lucy/t5'}) if a[0] == 'run' else 'boom' if a[0] == 'read' else"
            " json.dumps({'state': state, 'exit_code': int(os.environ.get('CODE', '0')) if state == 'finished' else None})"
            " if a[0] == 'get' else '')\n")
        for name in ("hc", "teamclaude"):
            if name == "teamclaude":
                (folder / name).write_text(f"#!{sys.executable}\nraise SystemExit('the CLI must not run here')\n")
            (folder / name).chmod(0o755)

        def run(arguments, **extra):
            calls.unlink(missing_ok=True)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 120, 0, 0))
            # Only the fakes on PATH: no real hc, no herdr-app.
            env = {"PATH": directory, "HOME": directory, "TC_ACCT": "2", **extra}
            child = subprocess.Popen([sys.executable, str(HUD / "launcher.py"), *arguments], cwd=directory,
                                     stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            output = []
            reader = threading.Thread(target=lambda: drain(master, output), daemon=True)
            reader.start()
            code = child.wait(timeout=10)
            reader.join(timeout=2)
            os.close(master)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return code, b"".join(output).decode(), recorded

        arguments = ["--claude", "--yolo", "--model", "m", "--keep-alive"]
        code, output, recorded = run(arguments, CODE="3")
        assert code == 3 and "boom" in output, (code, output)
        assert [c[0] for c in recorded] == ["run", "attach", "get", "read", "rm"], recorded
        launched = recorded[0]
        assert launched[launched.index("--name") + 1].startswith("claude-") and "--no-parent" in launched
        assert Path(launched[launched.index("--cwd") + 1]).resolve() == Path(directory).resolve(), launched
        # Same raw arguments to the same launcher, marked so it never starts another terminal; caller's choices kept.
        tail = launched[launched.index("--") + 1:]
        assert tail[:2] == ["env", "TEAMPROXY_HUD_HC_STARTED=1"] and f"PATH={directory}" in tail and "TC_ACCT=2" in tail
        assert tail[-len(arguments) - 2:] == [sys.executable, str(HUD / "launcher.py"), *arguments], tail
        assert recorded[1] == ["attach", "lucy/t5"] and recorded[-1] == ["rm", "lucy/t5"]
        # A clean exit is removed quietly with its code.
        code, output, recorded = run(["--claude"])
        assert code == 0 and [c[0] for c in recorded] == ["run", "attach", "get", "rm"], recorded
        # Detached: it keeps running, nothing removed, the address to reattach is shown.
        code, output, recorded = run(["--claude"], STATE="live")
        assert code == 0 and "hc attach lucy/t5" in output and [c[0] for c in recorded] == ["run", "attach", "get"]
        # hc cannot start it: the error comes back, nonzero.
        code, output, recorded = run(["--claude"], FAIL="1")
        assert code != 0 and "core down" in output and [c[0] for c in recorded] == ["run"], output
        # The launch inside that terminal never starts another one: there, outside a Herdr pane, the CLI runs alone.
        (folder / "teamclaude").write_text(f"#!{sys.executable}\nprint('direct', *__import__('sys').argv[1:])\n")
        code, output, recorded = run(["--claude"], TEAMPROXY_HUD_HC_STARTED="1")
        assert code == 0 and "direct run -- --effort xhigh" in output and not recorded, output
        # Print mode still runs directly, never through hc.
        code, output, recorded = run(["--claude", "-p", "hi"])
        assert code == 0 and "direct run -- -p hi" in output and not recorded, output


def check():
    # The footer cases must not see the Herdr terminal this check may run in.
    os.environ.pop("HC_TERMINAL_ID", None)
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
    assert modes["grok"][1] == "Grok" and modes["grok"][3] == "--always-approve"
    for flags in (["-p", "hi"], ["--print"], ["--list-models"], ["-v"], ["--version"]):
        assert oneshot(flags, modes["cursor"][2]), flags
    assert not oneshot(["--model", "gpt-5"], modes["cursor"][2]) and not oneshot(["--resume", "x"], modes["cursor"][2])
    assert modes["cursor"][1] == "Cursor" and modes["cursor"][3] == "--yolo"
    # Claude conversations default to --effort xhigh; an explicit effort (max included) is kept.
    assert launcher.with_effort([]) == ["--effort", "xhigh"]
    assert launcher.with_effort(["--effort", "high"]) == ["--effort", "high"]
    assert launcher.with_effort(["--effort", "max"]) == ["--effort", "max"]
    assert launcher.with_effort(["--effort=low", "-c"]) == ["--effort=low", "-c"]
    assert launcher.with_effort(["--dangerously-skip-permissions"]) == ["--dangerously-skip-permissions", "--effort", "xhigh"]
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        fake = Path(directory) / "teamagy"
        fake.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o755)
        env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
        for arguments in (["-p", "hi"], ["--model", "m"]):  # print mode, or no terminal: run directly
            result = subprocess.run([sys.executable, str(HUD / "launcher.py"), "--agy", *arguments], env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert json.loads(result.stdout) == ["run", "--", *arguments], (arguments, result.stdout, result.stderr)
        # --yolo becomes each CLI's own skip-all-approvals flag; --keep-alive (old, ours) is dropped wherever it sits.
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
    hc_terminal()
    print("PASS: outside Herdr core an interactive launch runs in a new hc terminal")
    herdr_footer()
    print("PASS: a Herdr terminal runs the CLI in it, the footer as a Herdr split")

if __name__ == "__main__":
    check()
