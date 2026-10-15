#!/usr/bin/env python3
"""Read-only TeamCodex/TeamAgy/TeamGrok quota HUD. Rendering adapted from the Claude status line (../../statusline)."""

import argparse
import base64
import json
import math
import os
import re
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def read_status(config_path):
    config = json.loads(config_path.read_text())
    proxy = config.get("proxy") or {}
    port = proxy.get("port", 3457)
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("invalid local proxy port")
    headers = {"x-teamcodex-status-identity": "1"}
    if proxy.get("apiKey"):
        headers["x-api-key"] = proxy["apiKey"]
    # Never send the local proxy key through an environment proxy or redirect.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(f"http://127.0.0.1:{port}/teamclaude/status", headers=headers)
    with opener.open(request, timeout=2) as response:
        raw = response.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("status response too large")
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
        raise ValueError("invalid status response")
    if any(not isinstance(account, dict) for account in data["accounts"]):
        raise ValueError("invalid account response")
    configured = {a.get("accountUuid"): a for a in config.get("accounts", []) if a.get("accountUuid")}
    for account in data["accounts"]:
        local = configured.get(account.get("accountUuid"))
        if not local or (account.get("subscription") or {}).get("endsAt"):
            continue
        try:
            payload = local.get("idToken", "").split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            auth = claims.get("https://api.openai.com/auth") or {}
            # Local token metadata is display-only; never use it to authorize or route.
            if auth.get("chatgpt_account_id") != (local.get("accountId") or local["accountUuid"]):
                continue
            if timestamp(auth.get("chatgpt_subscription_active_until")) is not None:
                account["subscription"] = {**(account.get("subscription") or {}),
                    "endsAt": auth["chatgpt_subscription_active_until"],
                    "startsAt": auth.get("chatgpt_subscription_active_start"),
                    "source": "login", "checkedAt": auth.get("chatgpt_subscription_last_checked")}
        except (ValueError, IndexError, TypeError, AttributeError):
            pass
    return data


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        return None
    return value


def timestamp(value):
    if number(value) is not None:
        return value / 1000
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (ValueError, OverflowError):
            pass
    return None


def remaining(value, now):
    reset = timestamp(value)
    if reset is None:
        return ""
    seconds = reset - now
    if seconds <= 0:
        return "now"
    minutes = int(seconds // 60)
    if not minutes:
        return "<1m"
    days, minutes = divmod(minutes, 1440)
    hours, minutes = divmod(minutes, 60)
    if days:
        return f"{days}d{hours}h"
    return f"{hours}h{minutes}m" if hours else f"{minutes}m"


def clean(value, width):
    # Fixed ASCII cells also prevent terminal-control injection in account names.
    return "".join(c if 32 <= ord(c) < 127 else "?" for c in str(value or "-"))[:width]


def paint(text, color, enabled):
    return f"\033[{color}m{text}\033[0m" if enabled else text


def bar(value, reset, now, color=False, width=13, track="100"):
    ratio = number(value)
    if ratio is None:
        text = "-".center(width)
        return paint(text, f"{track};37", color) if color else f"[{text}]"
    ratio = min(1, max(0, ratio))
    pct = f"{ratio * 100:.0f}%"
    label = f"{pct} {remaining(reset, now)}".strip()
    text = (label if len(label) <= width else pct).center(width)
    if not color:
        return f"[{text}]"
    filled = round(ratio * width)
    bg = 42 if ratio < 0.7 else 43 if ratio < 0.9 else 41
    return paint(text[:filled], f"{bg};97", True) + paint(text[filled:], f"{track};37", True)


def window(quota, key):
    """(utilization, reset) of a quota window; "3p" is agy's Claude/GPT group."""
    if key != "3p":
        return quota.get(key), quota.get(key + "Reset")
    # The fuller of the group's 5h and weekly buckets binds, as in the proxy TUI.
    group = (quota.get("agyGroups") or {}).get("3p") or {}
    windows = [w for w in (group.get("fiveHour"), group.get("weekly"))
               if isinstance(w, dict) and number(w.get("utilization")) is not None]
    binding = max(windows, key=lambda w: w["utilization"], default={})
    return binding.get("utilization"), binding.get("reset")


def pool(accounts, key):
    values, resets = [], []
    for account in accounts:
        value, reset = window(account.get("quota") or {}, key)
        value = number(value)
        if value is not None:
            values.append(min(1, max(0, value)))
            reset = timestamp(reset)
            if reset is not None:
                resets.append(reset * 1000)
    return (sum(values) / len(values) if values else None,
            min(resets) if resets else None)


def subscription_bar(subscription, now, color=False, width=14):
    """Recorded subscription period end, never the OAuth token expiry."""
    subscription = subscription or {}
    end = timestamp(subscription.get("endsAt"))
    try:
        # A recorded cancellation uses the midnight AFTER its last usable day.
        display_end = end
        if end is not None and subscription.get("source") != "login" and subscription.get("state") in (
                "cancellation-scheduled", "end-date-reached", "ended"):
            display_end -= 0.001
        end_date = datetime.fromtimestamp(display_end).date() if display_end is not None else None
    except (ValueError, OSError, OverflowError):
        end_date = None
    # Refreshed ID tokens can retain an old billing snapshot after renewal.
    if end_date is None or (end <= now and subscription.get("source") == "login"):
        text = ("check date" if end_date is not None else "-").center(width)
        return paint(text, "100;37", color) if color else f"[{text}]"
    days = (end_date - datetime.fromtimestamp(now).date()).days
    label = "past" if end <= now else "D-DAY" if days == 0 else f"D-{days}"
    text = f"{end_date:%m/%d} {label}".center(width)
    if not color:
        return f"[{text}]"
    start = timestamp(subscription.get("startsAt"))
    filled = round(width * min(1, max(0, (now - start) / (end - start)))) if start is not None and start < end else width
    bg = 41 if days <= 3 else 43 if days <= 7 else 42
    return paint(text[:filled], f"{bg};97", True) + paint(text[filled:], "100;37", True)


# A model-capacity rejection parks the account ("cool"); the proxy retries it after
# its cooldown and reports "back" for a while once it serves again.
RECOVERED_SHOW_SECONDS = 600


def account_state(account, now):
    if account.get("enabled") is False:
        return "off"
    if account.get("status") == "error":
        return "error"
    reset = timestamp(account.get("rateLimitedUntil"))
    if reset is not None and reset > now:
        return "wait"
    cooling = account.get("capacityCooling")
    if isinstance(cooling, dict) and any(
            (timestamp(until) or 0) > now for until in cooling.values()):
        return "cool"
    if number(account.get("inflight")) and account["inflight"] > 0:
        return "busy"
    if account.get("usable") is False:
        return "limit"
    recovered = account.get("capacityRecovered")
    if isinstance(recovered, dict) and any(
            now - RECOVERED_SHOW_SECONDS <= (timestamp(at) or 0) <= now for at in recovered.values()):
        return "back"
    return "ready"


def session_log(pane):
    """Find this pane's CLI log, excluding subagents and other terminal windows."""
    pid = int(subprocess.check_output(
        ["tmux", "-L", "teamcodex-hud", "display-message", "-p", "-t", pane, "#{pane_pid}"],
        text=True, timeout=2).strip())
    processes = subprocess.check_output(["ps", "-axo", "pid=,ppid=,comm="], text=True, timeout=2)
    entries = [line.split(None, 2) for line in processes.splitlines() if line.strip()]
    codex_pids = {int(p) for p, _, command in entries if Path(command).name == "codex"}
    descendants = {pid}
    while True:
        # Stop at the pane's CLI: nested exec/login processes are not its session.
        children = {int(p) for p, parent, _ in entries
                    if int(parent) in descendants and int(parent) not in codex_pids}
        if children <= descendants:
            break
        descendants |= children
    codex = [str(p) for p in descendants & codex_pids]
    if not codex:
        return None
    if len(codex) != 1:
        raise ValueError("ambiguous pane CLI")
    opened = subprocess.run(["lsof", "-n", "-P", "-p", codex[0], "-Fn"],
                            capture_output=True, text=True, timeout=2)
    candidates = set()
    for line in opened.stdout.splitlines():
        if line.startswith("n/") and Path(line[1:]).name.startswith("rollout-") and line.endswith(".jsonl"):
            path = Path(line[1:])
            with path.open() as log:
                meta = json.loads(log.readline())
            if meta.get("type") == "session_meta" and meta.get("payload", {}).get("source") == "cli":
                candidates.add(path)
    # Never guess by directory or modification time when multiple sessions are open.
    if len(candidates) > 1:
        raise ValueError("ambiguous CLI log")
    return candidates.pop() if candidates else None


def last_usage(path):
    """Read backwards in blocks; ignore an unfinished final JSONL record."""
    with path.open("rb") as log:
        position = log.seek(0, 2)
        pending = b""
        while position:
            size = min(position, 65536)
            position -= size
            log.seek(position)
            lines = (log.read(size) + pending).split(b"\n")
            pending = lines.pop(0) if position else b""
            for line in reversed(lines):
                if b'"token_count"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                payload = event.get("payload") or {}
                if event.get("type") == "event_msg" and payload.get("type") == "token_count" and payload.get("info"):
                    return payload["info"].get("last_token_usage")
    return None


def cache_row(usage):
    if not isinstance(usage, dict):
        return "Cache last: waiting for usage"
    total, cached = number(usage.get("input_tokens")), number(usage.get("cached_input_tokens"))
    if total is None or cached is None or total <= 0 or not 0 <= cached <= total:
        return "Cache last: unavailable"
    return (f"Cache last: {cached / total:.1%} | {cached:,.0f}/{total:,.0f} in"
            f" | new {total - cached:,.0f}")


# agy (Antigravity) pools Google accounts with two quota groups: Gemini (5h/7d bars) and Claude/GPT (3p).
# grok has one meter (x-ratelimit requests/tokens, no reset) shown as the RL bar.
NAMES = {"codex": ("TeamCodex", "teamcodex login --name codex-1"), "agy": ("TeamAgy", "teamagy import --name pro-1"),
         "grok": ("TeamGrok", "teamgrok login --name grok-1")}


def claude_rows(color=True):
    """TeamClaude rows: the Claude Code status line itself renders them, so the footer and the in-app table match.

    Installed by statusline/install.sh into ~/.claude; a checkout falls back to its own copy.
    """
    renderer = next((path for path in (Path.home() / ".claude/statusline-teamclaude.py",
                                       Path(__file__).resolve().parents[2] / "statusline/statusline-teamclaude.py")
                     if path.is_file()), None)
    if renderer is None:
        return ["TeamClaude: Claude status line missing. Run: statusline/install.sh"]
    env = {k: v for k, v in os.environ.items() if k != "TEAMCLAUDE_HUD"}
    env["TC_SL_CACHE_TTL"] = "2"
    if not color:
        env["NO_COLOR"] = "1"
    result = subprocess.run([sys.executable, str(renderer)], input=b"{}", env=env, capture_output=True, timeout=10)
    return result.stdout.decode(errors="replace").rstrip("\n").split("\n")


def render(data, now=None, color=False, width=100, agy=False, grok=False):
    now = time.time() if now is None else now
    accounts = data["accounts"]
    threshold = number(data.get("switchThreshold"))
    threshold_label = f"{threshold * 100:.0f}%" if threshold is not None else "-"
    title, add_account = NAMES["agy" if agy else "grok" if grok else "codex"]
    legend = " | 5h 7d Gemini, 3p Claude/GPT" if agy else " | RL rate limit" if grok else ""
    rows = [paint(f"{title} | {len(accounts)} accounts | switch {threshold_label}{legend} | > selected, * busy"[:width], "1;36", color)]
    if not accounts:
        return rows + ["No accounts. Run: " + add_account]
    eligible = [a for a in accounts if a.get("enabled") is not False and a.get("status") != "error"]
    name_width = 9 if width < 95 else 15
    plan_width = 4 if width < 95 else 7
    state_width = 9 if width < 95 else 10
    bar_width = 6 if width < 95 else 13
    end_width = 12 if width < 95 else 14

    def row(marker, label, plan, state, five, week, accent="36", subscription=None, third=None):
        prefix = f"{marker} {clean(label, name_width):<{name_width}} {clean(plan, plan_width):<{plan_width}} {state:<{state_width}}"
        bg = 235 if len(rows) % 2 else 239
        track = f"48;5;{bg + 3}"
        rendered = (paint(prefix, accent, color) + (" RL " if grok else " 5h ") + bar(*five, now, color, bar_width, track)
                + ("" if grok else " 7d " + bar(*week, now, color, bar_width, track))
                + (" 3p " + bar(*third, now, color, bar_width, track) if third is not None else "")
                + (" End " + subscription_bar(subscription, now, color, end_width) if subscription is not None else ""))
        if color:
            padding = " " * max(0, min(width, 91) - len(re.sub(r"\033\[[0-9;]*m", "", rendered)))
            background = f"\033[48;5;{bg}m"
            rendered = background + rendered.replace("\033[0m", "\033[0m" + background) + padding + "\033[0m"
        return rendered

    # Arithmetic mean of measured enabled accounts, not pooled token capacity.
    if len(accounts) > 1:
        rows.append(row(" ", "FLEET", f"x{len(eligible)}", "avg",
                        pool(eligible, "unified5h"), pool(eligible, "unified7d"), "1",
                        third=pool(eligible, "3p") if agy else None))
    indexed = list(enumerate(accounts, 1))
    indexed.sort(key=lambda item: timestamp((item[1].get("quota") or {}).get("unified7dReset")) or float("inf"))
    for index, account in indexed:
        quota = account.get("quota") or {}
        current_id = data.get("currentAccountUuid")
        selected = (account.get("accountUuid") == current_id if current_id
                    else bool(data.get("currentAccount")) and account.get("name") == data["currentAccount"])
        state = account_state(account, now)
        marker = "*" if number(account.get("inflight")) and account["inflight"] > 0 else ">" if selected and state in ("ready", "back") else " "
        label = state
        if state == "cool":
            until = max((timestamp(v) or 0) for v in account["capacityCooling"].values())
            label = "cool " + remaining(until * 1000, now)
        name = account.get("name") or f"account-{index}"
        rows.append(row(marker, f"{index}.{name}", account.get("planType"), label,
                        (quota.get("unified5h"), quota.get("unified5hReset")),
                        (quota.get("unified7d"), quota.get("unified7dReset")),
                        "31" if state == "error" else ("36", "32", "33", "35")[index % 4],
                        # agy and grok have no subscription end date; agy's third bar is the Claude/GPT group.
                        None if agy or grok else account.get("subscription") or {},
                        window(quota, "3p") if agy else None))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agy", action="store_true", help="TeamAgy (Antigravity) pool instead of TeamCodex")
    parser.add_argument("--grok", action="store_true", help="TeamGrok pool instead of TeamCodex")
    parser.add_argument("--claude", action="store_true", help="TeamClaude pool, rows from the Claude Code status line")
    parser.add_argument("--config", type=Path,
                        help="default: ~/.config/teamcodex.json, teamagy.json with --agy, teamgrok.json with --grok")
    parser.add_argument("--watch", action="store_true", help="refresh every two seconds")
    parser.add_argument("--plain", action="store_true", help="disable ANSI colors")
    parser.add_argument("--codex-pane", help="tmux pane whose latest request cache usage is shown")
    args = parser.parse_args()
    command = "teamclaude" if args.claude else "teamagy" if args.agy else "teamgrok" if args.grok else "teamcodex"
    config = args.config or Path.home() / f".config/{command}.json"
    title, add_account = (("TeamClaude", "teamclaude login") if args.claude
                          else NAMES["agy" if args.agy else "grok" if args.grok else "codex"])
    color = sys.stdout.isatty() and "NO_COLOR" not in os.environ and not args.plain
    watching = args.watch and sys.stdout.isatty()
    # In the tmux footer the pane height follows the row count, so adding or removing an account resizes it.
    # A resized pane (window resize, client attach) sends SIGWINCH, which wakes the loop at once.
    pane = watching and os.environ.get("TMUX_PANE")
    if watching:
        wake, notify = os.pipe()
        os.set_blocking(wake, False)
        os.set_blocking(notify, False)
        signal.set_wakeup_fd(notify)
        signal.signal(signal.SIGWINCH, lambda *_: None)
    try:
        while True:
            failed = False
            try:
                rows = (claude_rows(color) if args.claude else
                        render(read_status(config), color=color, width=shutil.get_terminal_size().columns,
                               agy=args.agy, grok=args.grok))
            except FileNotFoundError:
                rows = [f"{title}: config missing. Run: {add_account}"]
                failed = True
            except Exception:
                # Keep account credentials and HTTP exception details out of the display.
                rows = [f"{title}: proxy unavailable or invalid status. Run: {command} server"]
                failed = True
            if args.codex_pane:
                try:
                    path = session_log(args.codex_pane)
                    cache = cache_row(last_usage(path) if path else None)
                except (OSError, ValueError, subprocess.SubprocessError):
                    cache = "Cache last: unavailable"
                rows.append(cache[:shutil.get_terminal_size().columns])
            if watching:
                height = os.get_terminal_size(sys.stdout.fileno()).lines
                if pane and not failed and height != len(rows):
                    subprocess.run([shutil.which("tmux") or "tmux", "resize-pane", "-t", pane, "-y", str(len(rows))],
                                   capture_output=True)
                # Autowrap off: in a narrow pane a long row is clipped instead of pushing rows out of view.
                # Bottom-aligned until the resize lands, or when tmux cannot give the footer that many rows.
                pad = "\n" * max(0, height - len(rows))
                sys.stdout.write("\033[?7l\033[H\033[J" + pad + "\n".join(rows))
                sys.stdout.flush()
            else:
                print("\n".join(rows), flush=True)
            if not watching:
                return 1 if failed else 0
            select.select([wake], [], [], 2)
            try:
                os.read(wake, 512)
            except BlockingIOError:
                pass
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
