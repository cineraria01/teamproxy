"""The tmux footer keeps its height equal to its row count, also after a window resize (real tmux, no proxy)."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

STATUSLINE = Path(__file__).resolve().parents[2] / "src/hud/statusline.py"


def eventually(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("footer height condition timed out")


def check():
    tmux = shutil.which("tmux")
    assert tmux, "Install tmux to run this check"
    with tempfile.TemporaryDirectory(prefix="tcodex-footer-") as directory:
        home = Path(directory)
        count = home / "rows"
        count.write_text("3")
        renderer = home / ".claude/statusline-teamclaude.py"
        renderer.parent.mkdir()
        # Stands in for the Claude Code status line: one row per account, the count read from a file.
        renderer.write_text("from pathlib import Path\n"
                            f"n = int(Path({str(count)!r}).read_text())\n"
                            "print('\\n'.join(f'account {i}' for i in range(n)))\n")
        base = [tmux, "-L", home.name, "-f", "/dev/null"]
        try:
            subprocess.run(base + ["new-session", "-d", "-s", "t", "-x", "100", "-y", "30", "sleep 300"],
                           check=True, cwd=directory)
            footer = subprocess.run(base + ["split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-l", "1", "-t", "t",
                                            "-e", f"HOME={home}", sys.executable, str(STATUSLINE), "--watch", "--claude"],
                                    check=True, capture_output=True, text=True, cwd=directory).stdout.strip()

            def height():
                shown = subprocess.run(base + ["display-message", "-p", "-t", footer, "#{pane_height}"],
                                       capture_output=True, text=True).stdout.strip()
                return int(shown or 0)

            eventually(lambda: height() == 3)
            print("PASS: the footer takes its row count")
            count.write_text("5")
            eventually(lambda: height() == 5)
            count.write_text("2")
            eventually(lambda: height() == 2)
            print("PASS: adding or removing an account resizes the footer")
            for rows in (45, 20):
                subprocess.run(base + ["resize-window", "-t", "t", "-y", str(rows)], check=True)
                eventually(lambda: height() == 2)
            lines = subprocess.run(base + ["capture-pane", "-p", "-t", footer], capture_output=True, text=True).stdout
            assert lines.rstrip("\n").split("\n") == ["account 0", "account 1"], lines
            print("PASS: a window resize keeps the footer at its row count")
        finally:
            subprocess.run(base + ["kill-server"], capture_output=True)


if __name__ == "__main__":
    check()
