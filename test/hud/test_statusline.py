"""Small offline check: python3 test/hud/test_statusline.py. No account login or inference."""

import copy
import base64
import json
import os
import re
from pathlib import Path
from datetime import datetime
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError

HUD = Path(__file__).resolve().parents[2] / "src/hud"
sys.path.insert(0, str(HUD))
from statusline import account_state, claude_rows, bar, cache_row, clean, last_usage, main, pool, read_status, render, session_log, subscription_bar
from unittest.mock import patch


def check():
    now = 1_800_000_000
    accounts = [
        {"name": "one", "accountUuid": "a", "enabled": True, "planType": "pro", "usable": True,
         "quota": {"unified7d": 0.8, "unified7dReset": (now + 3600) * 1000}},
        {"name": "two", "accountUuid": "b", "enabled": True, "planType": "plus", "usable": True,
         "quota": {"unified7d": 0, "unified7dReset": (now + 7200) * 1000}},
        {"name": "off", "enabled": False, "quota": {"unified7d": 1}},
    ]
    data = {"accounts": accounts, "currentAccountUuid": "a", "switchThreshold": 0.98}
    output = "\n".join(render(data, now=now))
    assert "40%" in output and "> 1.one" in output and "off" in output
    assert "-" in bar(None, None, now) and "0%" in bar(0, None, now)
    assert "nan" not in bar(float("nan"), None, now)
    assert pool([accounts[0], {"quota": {}}], "unified7d")[0] == 0.8
    changed = copy.deepcopy(data)
    changed["currentAccountUuid"] = "b"
    changed["accounts"][0]["enabled"] = False
    assert "> 2.two" in "\n".join(render(changed, now=now))
    assert account_state({"inflight": 1}, now) == "busy"
    assert account_state({"rateLimitedUntil": (now - 1) * 1000}, now) == "ready"
    assert account_state({"capacityCooling": {"gpt-6-astra": (now + 300) * 1000}}, now) == "cool"
    assert account_state({"capacityCooling": {"gpt-6-astra": (now - 1) * 1000}}, now) == "ready"
    assert account_state({"capacityRecovered": {"gpt-6-astra": (now - 60) * 1000}}, now) == "back"
    assert account_state({"capacityRecovered": {"gpt-6-astra": (now - 3600) * 1000}}, now) == "ready"
    assert account_state({"inflight": 1, "capacityCooling": {"m": (now + 300) * 1000}}, now) == "cool"
    cooling = copy.deepcopy(data)
    cooling["accounts"][1]["capacityCooling"] = {"gpt-6-astra": (now + 300) * 1000}
    assert "cool " in "\n".join(render(cooling, now=now))
    cooling["currentAccountUuid"] = "b"
    assert "> 2.two" not in "\n".join(render(cooling, now=now))
    assert "cool 5m" in "\n".join(render(cooling, now=now))
    assert "cool 3m" in "\n".join(render(cooling, now=now + 120))
    assert "> 2.two" in "\n".join(render(cooling, now=now + 301))
    assert "D-" in subscription_bar({"endsAt": (now + 3 * 86400) * 1000}, now)
    assert "past" in subscription_bar({"endsAt": (now - 1) * 1000}, now)
    assert "check date" in subscription_bar({"endsAt": (now - 1) * 1000, "source": "login"}, now)
    assert "D-" in subscription_bar({"endsAt": (now + 3 * 86400) * 1000, "source": "login"}, now)
    midnight = datetime(2026, 10, 15).timestamp()
    cancellation = {"state": "cancellation-scheduled", "endsAt": midnight * 1000}
    assert "10/14 D-DAY" in subscription_bar(cancellation, midnight - 3600)
    assert "10/14 past" in subscription_bar(cancellation, midnight)
    assert "10/15 D-1" in subscription_bar({**cancellation, "source": "login"}, midnight - 3600)
    assert "-" in subscription_bar({"endsAt": "broken"}, now)
    assert "-" in subscription_bar({"endsAt": float("inf")}, now)
    assert "\033" not in clean("evil\033[2J\nname", 30)
    assert all(len(line) <= 80 for line in render(data, now=now, width=80))
    dated = copy.deepcopy(cooling)
    dated["accounts"][1]["subscription"] = {"endsAt": (now + 86400) * 1000}
    assert all(len(line) <= 70 for line in render(dated, now=now, width=70))
    for width in (70, 80, 95, 160):
        colored = render(dated, now=now, width=width, color=True)
        assert all(len(re.sub(r"\033\[[0-9;]*m", "", line)) <= width for line in colored)
        assert any("48;5;239" in line for line in colored)

    # A new CLI may not have opened its rollout yet; this is normal startup.
    with patch("sys.argv", ["statusline.py", "--plain", "--codex-pane", "%0"]), \
            patch("statusline.read_status", return_value=data), \
            patch("statusline.session_log", return_value=None), \
            patch("builtins.print") as displayed:
        assert main() == 0
        assert displayed.call_args.args[0].endswith("Cache last: waiting for usage")
        with patch("statusline.session_log", side_effect=ValueError("ambiguous CLI log")):
            assert main() == 0
            assert displayed.call_args.args[0].endswith("Cache last: unavailable")

    class Handler(BaseHTTPRequestHandler):
        redirect = False
        def do_GET(self):
            assert self.headers.get("x-api-key") == "local-test-key"
            assert self.headers.get("x-teamcodex-status-identity") == "1"
            if self.redirect:
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:1/do-not-follow")
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())
        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory() as temporary:
        log = Path(temporary) / "rollout-test.jsonl"
        usage = {"input_tokens": 150566, "cached_input_tokens": 148864}
        record = json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": usage}}})
        log.write_text(json.dumps({"type": "session_meta", "payload": {"source": "cli"}}) + "\n" + record + "\n")
        assert last_usage(log) == usage
        assert cache_row(usage) == "Cache last: 98.9% | 148,864/150,566 in | new 1,702"
        with log.open("a") as stream:
            stream.write(json.dumps({"padding": "x" * 70000}) + '\n{"type":"event_msg","payload":{"type":"token_count"')
        assert last_usage(log) == usage
        assert "0.0%" in cache_row({"input_tokens": 100, "cached_input_tokens": 0})
        assert "unavailable" in cache_row({"input_tokens": 0, "cached_input_tokens": 0})
        assert "unavailable" in cache_row({"input_tokens": 10})
        child_log = Path(temporary) / "rollout-child.jsonl"
        child_log.write_text(json.dumps({"type": "session_meta", "payload": {"source": {"subagent": {}}}}) + "\n")
        with patch("statusline.subprocess.check_output", side_effect=["10", "10 1 sh\n11 10 node\n12 11 /bin/codex\n99 1 /bin/codex"]), patch("statusline.subprocess.run") as opened:
            opened.return_value.stdout = f"n{child_log}\nn{log}\n"
            assert session_log("%0") == log
            assert opened.call_args.args[0][4] == "12"
        # Login/exec children must not hide the outer CLI or select their usage.
        processes = "10 1 sh\n11 10 node\n12 11 /bin/codex\n13 12 sh\n14 13 /bin/codex\n99 1 /bin/codex"
        for pane_pid in ("10", "12"):
            with patch("statusline.subprocess.check_output", side_effect=[pane_pid, processes]), patch("statusline.subprocess.run") as opened:
                opened.return_value.stdout = f"n{log}\n"
                assert session_log("%0") == log
                assert opened.call_args.args[0][4] == "12"
        for processes, paths in (
                ("10 1 sh\n12 10 /bin/codex\n14 10 /bin/codex", f"n{log}\n"),
                ("10 1 sh\n12 10 /bin/codex", f"n{log}\nn{child_log}\n")):
            child_log.write_text(json.dumps({"type": "session_meta", "payload": {"source": "cli"}}) + "\n")
            with patch("statusline.subprocess.check_output", side_effect=["10", processes]), patch("statusline.subprocess.run") as opened:
                opened.return_value.stdout = paths
                try:
                    session_log("%0")
                except ValueError:
                    pass
                else:
                    raise AssertionError("Ambiguous sessions must not look like normal startup")
        config = Path(temporary) / "config.json"
        with HTTPServer(("127.0.0.1", 0), Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            config.write_text(json.dumps({"proxy": {"port": server.server_port, "apiKey": "local-test-key"}}))
            try:
                assert read_status(config) == data
                claims = {"https://api.openai.com/auth": {
                    "chatgpt_account_id": "a", "chatgpt_subscription_active_until": "2026-09-14T00:00:00Z"}}
                token = "header." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".sig"
                local = {"proxy": {"port": server.server_port, "apiKey": "local-test-key"},
                         "accounts": [{"accountUuid": "a", "idToken": token, "expiresAt": 123}]}
                config.write_text(json.dumps(local))
                assert read_status(config)["accounts"][0]["subscription"]["endsAt"] == "2026-09-14T00:00:00Z"
                claims["https://api.openai.com/auth"]["chatgpt_subscription_active_until"] = "2026-10-14T00:00:00Z"
                local["accounts"][0]["idToken"] = "header." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".sig"
                config.write_text(json.dumps(local))
                assert read_status(config)["accounts"][0]["subscription"]["endsAt"] == "2026-10-14T00:00:00Z"
                data["accounts"][0]["subscription"] = {"state": "cancellation-scheduled", "endsAt": "2026-10-15T00:00:00Z"}
                assert read_status(config)["accounts"][0]["subscription"] == data["accounts"][0]["subscription"]
                del data["accounts"][0]["subscription"]
                local["accounts"][0]["accountId"] = "wrong-account"
                config.write_text(json.dumps(local))
                assert "subscription" not in read_status(config)["accounts"][0]
                local["accounts"][0]["idToken"] = "malformed"
                config.write_text(json.dumps(local))
                assert read_status(config) == data
                Handler.redirect = True
                try:
                    read_status(config)
                except HTTPError as error:
                    assert error.code == 302
                else:
                    raise AssertionError("redirect must be rejected")
                config.write_text('{"proxy":{"port":"3457/unsafe"}}')
                try:
                    read_status(config)
                    raise AssertionError("port must be validated")
                except ValueError:
                    pass
            finally:
                server.shutdown()
                worker.join()
        result = subprocess.run([sys.executable, str(HUD / "statusline.py"),
                                 "--config", str(Path(temporary) / "missing"), "--plain"], capture_output=True, text=True)
        assert result.returncode == 1 and "config missing" in result.stdout
        result = subprocess.run([sys.executable, str(HUD / "statusline.py"), "--agy", "--plain"],
                                env={**os.environ, "HOME": temporary}, capture_output=True, text=True)
        assert result.returncode == 1 and "TeamAgy: config missing. Run: teamagy import" in result.stdout, result.stdout
    # agy: Gemini fills the 5h/7d bars, the Claude/GPT group's fuller window the 3p bar; no End column.
    groups = {"gemini": {"fiveHour": {"utilization": 0.2, "reset": (now + 600) * 1000}},
              "3p": {"fiveHour": {"utilization": 0.1, "reset": (now + 600) * 1000},
                     "weekly": {"utilization": 0.6, "reset": (now + 86400) * 1000}}}
    agy = {"switchThreshold": 0.98, "currentAccountUuid": "g", "accounts": [
        {"name": "pro-1", "accountUuid": "g", "provider": "agy", "usable": True,
         "quota": {"unified5h": 0.2, "unified5hReset": (now + 600) * 1000, "agyGroups": groups}},
        {"name": "pro-2", "accountUuid": "h", "provider": "agy", "usable": True, "quota": {}}]}
    lines = render(agy, now=now, agy=True)
    assert lines[0].startswith("TeamAgy | 2 accounts") and "3p Claude/GPT" in lines[0], lines[0]
    assert "> 1.pro-1" in lines[2] and "5h [   20% 10m   ] 7d [      -      ] 3p [   60% 1d0h  ]" in lines[2], lines[2]
    assert all("End" not in line for line in lines) and " 3p [" in lines[1], lines
    assert "[      -      ]" in lines[3].split(" 3p ")[1], lines[3]
    assert render({"accounts": []}, agy=True)[1] == "No accounts. Run: teamagy import --name pro-1"
    assert "3p" not in "\n".join(render(data, now=now))
    # grok: one RL bar (x-ratelimit meter, no reset), tier as the plan, no 7d or End column.
    grok = {"switchThreshold": 0.98, "currentAccountUuid": "u1", "accounts": [
        {"name": "grok-1", "accountUuid": "u1", "provider": "grok", "planType": "SuperGrokPro", "usable": True,
         "quota": {"unified5h": 0.25}}]}
    lines = render(grok, now=now, grok=True)
    assert lines[0].startswith("TeamGrok | 1 accounts") and "RL rate limit" in lines[0], lines[0]
    assert "> 1.grok-1" in lines[1] and " RL [" in lines[1] and "25%" in lines[1], lines[1]
    assert all(" 7d " not in line and "End" not in line for line in lines), lines
    assert render({"accounts": []}, grok=True)[1] == "No accounts. Run: teamgrok login --name grok-1"
    # cursor: one Use bar (included usage, reset = billing cycle end), plan name, no 7d or End column.
    cursor = {"switchThreshold": 0.98, "currentAccountUuid": "c1", "accounts": [
        {"name": "cursor-1", "accountUuid": "c1", "provider": "cursor", "planType": "Ultra", "usable": True,
         "quota": {"unified5h": 0.4, "unified5hReset": (now + 86400) * 1000}}]}
    lines = render(cursor, now=now, cursor=True)
    assert lines[0].startswith("TeamCursor | 1 accounts") and "Use included usage" in lines[0], lines[0]
    assert "> 1.cursor-1" in lines[1] and " Use [" in lines[1] and "40%" in lines[1], lines[1]
    assert all(" 7d " not in line and "End" not in line for line in lines), lines
    assert render({"accounts": []}, cursor=True)[1] == "No accounts. Run: teamcursor login --name cursor-1"
    # TeamClaude rows come from the installed Claude Code status line, told it is not under the footer.
    with tempfile.TemporaryDirectory() as home:
        renderer = Path(home) / ".claude/statusline-teamclaude.py"
        renderer.parent.mkdir()
        renderer.write_text("import os, sys\nsys.stdin.read()\n"
                            "print('FLEET', os.environ.get('TEAMCLAUDE_HUD'), os.environ['TC_SL_CACHE_TTL'])\nprint('row')\n")
        with patch.dict(os.environ, {"HOME": home, "TEAMCLAUDE_HUD": "1"}):
            assert claude_rows() == ["FLEET None 2", "row"], claude_rows()
    print("PASS: rendering, account switch, missing quota, auth headers, local-only HTTP, offline state")


if __name__ == "__main__":
    check()
