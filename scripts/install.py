#!/usr/bin/env python3
"""Install the TeamCodex proxy, with its footer launcher, without changing Codex settings."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from install_teamcodex import install_proxy, install_service

LAUNCHER = "src/hud/launcher.py"
# Before the footer moved into the proxy package it was a separate copy with its own commands.
LEGACY = ("share/teamcodex-statusline", ("tcodex", "teamcodex-statusline"))


def install():
    arguments = sys.argv[1:]
    if arguments == ["--help"]:
        print("Usage: python3 scripts/install.py [--service]\n"
              "Default: install TeamCodex (proxy + Codex footer) if missing.\n"
              "--service: also enable the persistent Linux user service.")
        return
    if any(arg != "--service" for arg in arguments):
        raise SystemExit("Usage: python3 scripts/install.py [--service]")
    prefix = Path(os.environ.get("TEAMCODEX_HUD_PREFIX", Path.home() / ".local")).expanduser().resolve()
    command = install_proxy(prefix)
    routed = LAUNCHER in command.read_text(errors="ignore")
    if routed:
        print(f"Installed: {command} (Codex + footer)")
        old, links = prefix / LEGACY[0], LEGACY[1]
        for name in links:
            link = prefix / "bin" / name
            if link.is_symlink() and link.resolve().is_relative_to(old):
                link.unlink()
        shutil.rmtree(old, ignore_errors=True)
    else:
        print(f"Existing teamcodex has no launcher route: add it as in docs/install/HUD.md ({LAUNCHER})")
    if "--service" in arguments:
        install_service(command)
    print("Add an account: teamcodex login --name codex-1")
    if not shutil.which("codex"):
        print("Install codex before launching teamcodex.")
    if not shutil.which("hc"):
        print("Without hc (herdr-core) teamcodex runs without the account footer.")


if __name__ == "__main__":
    try:
        install()
    except (OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Installation failed: {error}")
