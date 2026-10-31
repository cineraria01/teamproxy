#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import sys
import time
import tempfile
from unittest.mock import patch, MagicMock
from datetime import date
from pathlib import Path

sys.dont_write_bytecode = True
# Deterministic, width-stable output: no ANSI, and a fixed timezone so the
# renewal-anniversary math (which uses local dates) is reproducible.
os.environ["NO_COLOR"] = "1"
os.environ["TZ"] = "UTC"
# Row indices below assume packed rows; the spacer row is exercised at the end.
os.environ["TC_SL_ROW_GAP"] = "0"
time.tzset()

spec = importlib.util.spec_from_file_location(
    "statusline", Path(__file__).with_name("statusline-teamclaude.py")
)
statusline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(statusline)

now = 1_000_000
assert statusline.fmt_remaining((now + 3661) * 1000, now) == "1h1m"
assert statusline.fmt_remaining((now + 4 * 3600) * 1000, now) == "4h"
assert statusline.fmt_remaining((now + 90061) * 1000, now) == "1d1h"
assert statusline.fmt_remaining(now * 1000, now) == "now"
assert statusline.fmt_remaining(None, now) is None

# Account rows follow the proxy's use-or-lose order: soonest weekly reset first
# (a known Fable reset does not matter), then soonest 5h reset, then 5h use.
# Original numbers stay attached so `claude N` keeps selecting account N.
ordered = statusline.accounts_by_weekly_reset([
    {"quota": {"unified7dFableReset": (now + 100) * 1000, "unified7dReset": (now + 900) * 1000}},
    {"quota": {"unified7dReset": (now + 100) * 1000}},
    {"quota": {"unified7dFableReset": (now + 50) * 1000, "unified7dReset": (now + 500) * 1000}},
], now)
assert [number for number, _ in ordered] == [2, 3, 1]

# Equal weekly reset: soonest 5h reset, then lower 5h use, then number.
wk = (now + 500) * 1000
ordered = statusline.accounts_by_weekly_reset([
    {"quota": {"unified7dReset": wk, "unified5hReset": (now + 300) * 1000}},
    {"quota": {"unified7dReset": wk, "unified5hReset": (now + 100) * 1000, "unified5h": 0.9}},
    {"quota": {"unified7dReset": wk, "unified5hReset": (now + 100) * 1000, "unified5h": 0.2}},
    {"quota": {"unified7dReset": wk, "sessionWindowStated": False}},
    {"quota": {"unified7dReset": wk, "unified5hReset": (now - 1) * 1000}},
], now)
assert [number for number, _ in ordered] == [3, 2, 1, 4, 5]

# Past or missing weekly resets sort last, keeping number order.
ordered = statusline.accounts_by_weekly_reset([
    {"quota": {}},
    {"quota": {"unified7dReset": (now - 1) * 1000}},
    {"quota": {"unified7dReset": (now + 100) * 1000}},
], now)
assert [number for number, _ in ordered] == [3, 1, 2]

# _normalize maps 1.3.x proxy-endpoint field names onto the expected ones and
# leaves already-normalized data untouched.
normalized = statusline._normalize({
    "accounts": [
        {
            "name": "legacy@example.com",
            "enabled": False,
            "quota": {"modelWeekly": {"7d_oi": {"utilization": 0.27, "reset": 123}}},
        },
        {
            "name": "modern@example.com",
            "disabled": False,
            "quota": {"unified7dFable": 0.5, "unified7dFableReset": 456},
        },
    ]
})
legacy, modern = normalized["accounts"]
assert legacy["disabled"] is True
assert legacy["quota"]["unified7dFable"] == 0.27
assert legacy["quota"]["unified7dFableReset"] == 123
assert modern["disabled"] is False
assert modern["quota"]["unified7dFable"] == 0.5

# Billing-plan column mirrors the TUI's tierLabel.
assert statusline.plan_label(
    {"profile": {"rateLimitTier": "default_claude_max_20x"}}
) == "Max 20x"
assert statusline.plan_label({"profile": {"hasClaudePro": True}}) == "Pro"
assert statusline.plan_label({"profile": {"hasClaudeMax": True}}) == "Max"
assert statusline.plan_label({}) is None

# Renewal estimate: monthly anniversary of the subscription's creation,
# clamped to shorter months; today counts as D-DAY; hidden for broken
# subscriptions and unknown creation dates.
assert "~02/28 D-18" in statusline.fmt_renewal(
    {"profile": {"subscriptionCreatedAt": "2025-01-31T12:00:00Z"}},
    today=date(2026, 2, 10),
)
assert "~08/14 D-DAY" in statusline.fmt_renewal(
    {"profile": {"subscriptionCreatedAt": "2025-08-14T01:00:00Z"}},
    today=date(2026, 8, 14),
)
assert statusline.fmt_renewal(
    {"profile": {"subscriptionStatus": "canceled",
                 "subscriptionCreatedAt": "2025-01-01T00:00:00Z"}}
) is None
assert statusline.fmt_renewal({"profile": {}}) is None
assert "09/14 D-3" in statusline.fmt_renewal(
    {"subscription": {"endsAt": "2026-09-14T00:00:00Z"}}, today=date(2026, 9, 11))
assert "past" in statusline.fmt_renewal(
    {"subscription": {"endsAt": "2026-09-10T00:00:00Z"}}, today=date(2026, 9, 11))

# Missing proxy profiles are fetched by exact account identity, cached without
# tokens, and refreshed from the current config after the one-hour TTL.
with tempfile.TemporaryDirectory() as folder, patch.object(statusline, "CACHE", str(Path(folder) / "status")):
    config = {"accounts": [{"accountUuid": "a", "accessToken": "secret-fixture"}]}
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps({
        "account": {"uuid": "a"}, "organization": {
            "rate_limit_tier": "default_claude_max_20x", "subscription_status": "active",
            "subscription_created_at": "2026-07-24T04:07:57Z"}}).encode()
    with patch.object(statusline, "build_opener") as factory:
        factory.return_value.open.return_value = response
        data = statusline.load_profiles({"accounts": [{"accountUuid": "a"}]}, config)
        assert statusline.plan_label(data["accounts"][0]) == "Max 20x"
        request = factory.return_value.open.call_args.args[0]
        assert request.full_url == "https://api.anthropic.com/api/oauth/profile"
        assert request.get_header("Authorization") == "Bearer secret-fixture"
        assert isinstance(factory.call_args.args[1], statusline.NoRedirect)
        statusline.load_profiles({"accounts": [{"accountUuid": "a"}]}, config)
        assert factory.return_value.open.call_count == 1
        cache = Path(statusline.CACHE + ".profiles")
        assert "secret-fixture" not in cache.read_text()
        assert cache.stat().st_mode & 0o777 == 0o600
        saved = json.loads(cache.read_text()); saved["a"]["checkedAt"] -= 3601
        cache.write_text(json.dumps(saved))
        response.__enter__.return_value.read.return_value = b'{"account":{"uuid":"different"}}'
        assert "profile" not in statusline.load_profiles({"accounts": [{"accountUuid": "a"}]}, config)["accounts"][0]
        assert factory.return_value.open.call_count == 2

# Fleet pooling: disabled/errored accounts are excluded, unmeasured windows
# are skipped (not counted as zero), the reset is the soonest in the pool,
# and a pool of one is no pool at all.
accounts = [
    {"disabled": False, "quota": {
        "unified5h": 0.2, "unified5hReset": 2_000_000_000,
        "unified7d": 0.1, "unified7dFable": None,
    }},
    {"disabled": True, "quota": {"unified5h": 0.9}},
    {"disabled": False, "status": "error", "quota": {"unified5h": 0.9}},
    {"disabled": False, "quota": {
        "unified5h": 0.4, "unified5hReset": 1_999_999_000,
        "unified7d": None, "unified7dFable": 0.5,
    }},
]
pooled = statusline.pool_quota(accounts)
assert pooled["size"] == 2 and pooled["off"] == 2
assert round(pooled["five"][0], 6) == 0.3
assert pooled["five"][1] == 1_999_999_000
assert pooled["seven"] == (0.1, None)
assert pooled["fable"] == (0.5, None)
assert statusline.pool_quota(accounts[:2]) is None
assert pooled["noFive"] is False

# No 5-hour window (verified Ultra, quota.sessionWindowStated false): the
# account's Ses cell says "none" (same width as a bar, distinct from the
# unmeasured "-"), it is left out of the FLEET session average, and a fleet
# where no account has the window shows "none" too.
ultra = {"quota": {"sessionWindowStated": False, "unified5h": 0.99,
                   "unified5hReset": 2_000_000_000, "unified7d": 0.5}}
maxed = {"quota": {"sessionWindowStated": True, "unified5h": 0.2, "unified7d": 0.1}}
assert statusline.session_cell(ultra["quota"], now) == f"[{'none'.center(statusline.BAR_W)}]"
assert len(statusline.session_cell(ultra["quota"], now)) == len(statusline.bar(None, None, now))
assert statusline.session_cell({"sessionWindowStated": None}, now) == statusline.bar(None, None, now)
assert "none" in statusline.bars_cell(ultra["quota"], now)
assert "none" not in statusline.bars_cell(maxed["quota"], now)
mixed = statusline.pool_quota([ultra, maxed])
assert mixed["five"] == (0.2, None) and mixed["noFive"] is False
assert mixed["seven"][0] == 0.3
all_ultra = statusline.pool_quota([ultra, ultra])
assert all_ultra["noFive"] is True and all_ultra["five"] == (None, None)

# Bars degrade to a bracketed centered label without colors; the visible
# width is stable regardless of the data inside.
assert statusline.bar(None, None, now, width=8) == "[   -    ]"
assert statusline.bar(0.26, (now + 120) * 1000, now, width=10) == "[  26% 2m  ]"
assert statusline.bar(1.7, None, now, width=6) == "[ 100% ]"

assert statusline.status_cell({}).strip() == "active"
assert statusline.status_cell({"disabled": True}).strip() == "off"
assert statusline.status_cell({"rateLimitedUntil": now * 1000}).startswith("!")
assert statusline.status_cell(
    {"profile": {"subscriptionStatus": "canceled"}}
).strip() == "cancele"

statusline.load_status = lambda: {
    "currentAccount": "two@example.com",
    "accounts": [
        {"name": "one@example.com", "quota": {}},
        {"name": "two@example.com", "quota": {}},
    ],
}
statusline.time.time = lambda: now
os.environ["TEAMCLAUDE_STATUSLINE_INDEX"] = "1"
sys.stdin = io.StringIO('{"model":{"display_name":"Fable 5"}}')
output = io.StringIO()
sys.stdout = output
statusline.main()
sys.stdout = sys.__stdout__
lines = output.getvalue().splitlines()
assert lines[0] == "Fable 5"
assert lines[1].lstrip().startswith("FLEET")
assert lines[2].startswith("> 1. one@example.c")
assert lines[3].startswith("  2. two@example.c")
# Automatic Fable routing must not show an old `claude N` display-only pin.
original_load = statusline.load_status
statusline.load_status = lambda: {**original_load(), "routingPolicy": "fable-reset"}
sys.stdin = io.StringIO('{}')
output = io.StringIO()
sys.stdout = output
statusline.main()
sys.stdout = sys.__stdout__
assert any(line.startswith("> 2. two@example.c") for line in output.getvalue().splitlines())
statusline.load_status = original_load
# Column alignment: every dashboard row places its gauges at the same offset.
assert len({line.index("Ses") for line in lines[1:]}) == 1

# Regression: an off account widens the FLEET size label ("x2 +1 off") past
# the fixed plan column ("Max 20x"), and ljust never truncates — the plan
# column must stretch to fit or the FLEET row shifts out of column.
statusline.load_status = lambda: {
    "currentAccount": "one@example.com",
    "accounts": [
        {"name": "one@example.com", "quota": {}},
        {"name": "two@example.com", "quota": {}},
        {"name": "off@example.com", "disabled": True, "quota": {}},
    ],
}
sys.stdin = io.StringIO("{}")
output = io.StringIO()
sys.stdout = output
statusline.main()
sys.stdout = sys.__stdout__
lines = output.getvalue().splitlines()
assert "+1 off" in lines[0]
assert len({line.index("Ses") for line in lines}) == 1

# Row gap: with TC_SL_ROW_GAP=1 (off by default), a spacer row sits between
# every dashboard row. Claude Code discards empty/whitespace-only rows and
# trims leading spaces, so the spacer must be non-whitespace yet invisible —
# BRAILLE PATTERN BLANK — and must never shift the gauge columns.
os.environ["TC_SL_ROW_GAP"] = "1"
gapped = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gapped)
assert gapped.ROW_GAP is True
gapped.load_status = lambda: {
    "currentAccount": "one@example.com",
    "accounts": [
        {"name": "one@example.com", "quota": {}},
        {"name": "two@example.com", "quota": {}},
    ],
}
gapped.time.time = lambda: now
os.environ.pop("TEAMCLAUDE_STATUSLINE_INDEX", None)
sys.stdin = io.StringIO('{"model":{"display_name":"Fable 5"}}')
output = io.StringIO()
sys.stdout = output
gapped.main()
sys.stdout = sys.__stdout__
lines = output.getvalue().splitlines()
assert lines[0] == "Fable 5"
assert lines[1] == "\u2800" and lines[1].strip() != "" and "\u2800".strip() == "\u2800"
assert lines[2].lstrip().startswith("FLEET")
assert lines[3] == "\u2800"
assert lines[4].startswith("> 1. one@example.c")
assert lines[5] == "\u2800"
assert lines[6].startswith("  2. two@example.c")
assert len(lines) == 7
assert len({line.index("Ses") for line in lines[2::2]}) == 1
# Under the tmux account footer (TEAMCLAUDE_HUD) only the model line stays; the footer shows the table.
os.environ["TEAMCLAUDE_HUD"] = "1"
sys.stdin = io.StringIO('{"model":{"display_name":"Fable 5"}}')
output = io.StringIO()
sys.stdout = output
gapped.main()
sys.stdout = sys.__stdout__
os.environ.pop("TEAMCLAUDE_HUD")
assert output.getvalue() == "Fable 5\n", output.getvalue()
os.environ.pop("TC_SL_ROW_GAP")
packed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packed)
assert packed.ROW_GAP is False and packed.ROW_SEP == "\n"

print("ok")

# Row backgrounds: with colors on, every dashboard row (not the model header,
# not the spacers) is painted with a cycled background, every RESET inside
# the row re-arms it, and rows are padded to one visible width so the stripes
# form a clean rectangle. Header/spacer rows stay unpainted.
os.environ.pop("NO_COLOR")
os.environ["TC_SL_ROW_GAP"] = "1"
os.environ["TC_SL_ROW_BG"] = "48;5;236,-"
colored = importlib.util.module_from_spec(spec)
spec.loader.exec_module(colored)
assert colored.ROW_BGS == ["\033[48;5;236m", ""]
colored.load_status = lambda: {
    "currentAccount": "one@example.com",
    "accounts": [
        {"name": "one@example.com", "quota": {"unified5h": 0.5},
         "profile": {"subscriptionCreatedAt": "2025-01-01T00:00:00Z"}},
        {"name": "two@example.com", "quota": {}},
        {"name": "three@example.com", "quota": {}},
    ],
}
colored.time.time = lambda: now
sys.stdin = io.StringIO('{"model":{"display_name":"Fable 5"}}')
output = io.StringIO()
sys.stdout = output
colored.main()
sys.stdout = sys.__stdout__
lines = output.getvalue().splitlines()
BG = "\033[48;5;236m"
assert not lines[0].startswith(BG) and lines[1] == f"\033[2m\u2800\033[0m"
fleet, one, two, three = lines[2], lines[4], lines[6], lines[8]
assert fleet.startswith(BG) and fleet.endswith("\033[0m")
assert not one.startswith(BG)            # "-" slot: unpainted
assert two.startswith(BG) and not three.startswith(BG)
# every reset inside a painted row is immediately followed by the row bg
inner = fleet[len(BG):-len("\033[0m")]
assert "\033[0m" not in inner.replace("\033[0m" + BG, "")
assert len({colored.visible_len(r) for r in (fleet, one, two, three)}) == 1
# The gauge track follows the row: a 256-color gray stripe gets a track three
# steps lighter; an unpainted row keeps the default gray track.
assert colored.track_code("\033[48;5;236m") == "48;5;239"
assert colored.track_code("\033[48;5;254m") == "48;5;255"
assert colored.track_code("") == "100" and colored.track_code("\033[44m") == "100"
assert "\033[48;5;239;37m" in fleet and "\033[100;37m" not in fleet
assert "\033[100;37m" in one and "\033[48;5;239;37m" not in one
os.environ["NO_COLOR"] = "1"
print("bg ok")

