#!/usr/bin/env python3
"""Claude Code status line for teamclaude multi-account proxy.

Reads the Claude Code session JSON from stdin, queries `teamclaude status
--json` (cached briefly to keep rendering fast), and renders a compact
TUI-style dashboard mirroring the teamclaude TUI: a pooled FLEET row on top,
then one aligned row per account with plan / status columns, background-bar
gauges for the 5h session, 7d overall and 7d model windows (usage% and reset
countdown inside the bar), and the ESTIMATED next-billing countdown (D-8,
D-DAY) on the right:

    Fable 5
       FLEET         x4      pooled Ses ██ 7% 6m ██ Wk ...
    > 1. cindyholic10  Max 20x active Ses ██ 26% 6m ██ ...  D-25

Every cell sticks to ASCII (marker '>', 'x4', '!HH:MM' for rate limits)
because ambiguous-width glyphs (▶ × ⛔) render 2 cells wide in CJK
terminals and would break the column alignment. When the installed
teamclaude build lacks `status --json`, the running proxy's
`/teamclaude/status` endpoint is read directly instead.

The billing estimate is the monthly anniversary of the subscription's
creation (clamped to shorter months), exactly as the teamclaude TUI computes
it; it is hidden when the subscription is not healthy — the red status
column already says billing is broken. The FLEET row pools enabled accounts
the way the TUI does: average utilization per window, soonest reset.

Configuration (environment variables):
    TC_SL_CACHE_TTL   seconds to cache `teamclaude status` output (default 15)
    TC_SL_CACHE_FILE  cache file path (default: $TMPDIR/tc-statusline-cache-$UID.json)
    TC_SL_BAR_WIDTH   width of each quota bar in characters (default 12)
    TC_SL_ROW_COLORS  per-account-row accent colors as comma-separated ANSI
                      SGR codes, cycled (default "36,32,33,35,34,91"; empty
                      restores single-tone rows)
    TC_SL_ROW_GAP     "1" inserts a blank spacer row between the dashboard
                      rows; "0" (default) packs the rows tightly — the row
                      backgrounds already separate them
    TC_SL_ROW_BG      background colors painted across the dashboard rows
                      (FLEET first, then accounts in display order), as
                      comma-separated ANSI SGR codes cycled per row; "-"
                      leaves that row unpainted (default "48;5;235,48;5;239"
                      = alternating dark-gray stripes; empty disables). The
                      unfilled part of each gauge follows its row: a 256-color
                      gray stripe gets a track three steps lighter
    NO_COLOR          disable ANSI colors when set (https://no-color.org)
"""

import calendar
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

CACHE = os.environ.get("TC_SL_CACHE_FILE") or os.path.join(
    tempfile.gettempdir(), f"tc-statusline-cache-{os.getuid()}.json"
)
try:
    CACHE_TTL = float(os.environ.get("TC_SL_CACHE_TTL", "15"))
except ValueError:
    CACHE_TTL = 15.0
try:
    BAR_W = max(6, int(os.environ.get("TC_SL_BAR_WIDTH", "12")))
except ValueError:
    BAR_W = 12

COLOR = not os.environ.get("NO_COLOR")
if COLOR:
    DIM = "\033[2m"
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    CYAN = "\033[36m"
    MAGENTA = "\033[35m"
else:
    DIM = RESET = BOLD = GREEN = YELLOW = RED = CYAN = MAGENTA = ""

NAME_W = 13
PLAN_W = 7   # "Max 20x"
STATUS_W = 7

# Per-row accent colors: account rows cycle through this palette so each
# line reads in a distinct color. Override with TC_SL_ROW_COLORS
# (comma-separated ANSI SGR codes, e.g. "36,32,33,35,34,31"); set it empty
# to fall back to the old single-tone (DIM) rows. Semantic colors (gauge
# green/yellow/red, status, D-day) are untouched.
if COLOR:
    _row_codes = os.environ.get("TC_SL_ROW_COLORS", "36,32,33,35,34,91")
    ROW_COLORS = [
        f"\033[{c.strip()}m" for c in _row_codes.split(",") if c.strip()
    ]
else:
    ROW_COLORS = []


# Spacer row between dashboard rows (TC_SL_ROW_GAP=1 enables; off by default
# since the row backgrounds already separate the rows). Claude Code
# drops empty and whitespace-only status-line rows and trims leading spaces,
# so a genuinely blank line never shows up — the spacer is a single BRAILLE
# PATTERN BLANK (U+2800): not JavaScript whitespace, one cell wide in every
# terminal (East Asian Width: Neutral), and rendered as nothing.
ROW_GAP = os.environ.get("TC_SL_ROW_GAP", "0").strip().lower() not in (
    "0", "", "no", "off", "false"
)
SPACER = "\u2800"
ROW_SEP = f"\n{DIM}{SPACER}{RESET}\n" if ROW_GAP else "\n"

# Row backgrounds: each dashboard row is painted edge to edge in a color
# cycled from TC_SL_ROW_BG so adjacent rows read as separate stripes even
# when the accent colors are similar. Every RESET inside the row re-arms the
# row background, and the row is padded to the widest row so the stripe is a
# clean rectangle. "-" skips painting for that palette slot.
if COLOR:
    _bg_codes = os.environ.get("TC_SL_ROW_BG", "48;5;235,48;5;239")
    ROW_BGS = [
        "" if c.strip() == "-" else f"\033[{c.strip()}m"
        for c in _bg_codes.split(",") if c.strip()
    ]
else:
    ROW_BGS = []

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def visible_len(text):
    return len(_ANSI_RE.sub("", text))


_GRAY_BG_RE = re.compile(r"\033\[48;5;(\d+)m")
DEFAULT_TRACK = "100"


def row_bg(position):
    """Background for the dashboard row at display `position` (FLEET = 0)."""
    if not ROW_BGS:
        return ""
    return ROW_BGS[position % len(ROW_BGS)]


def track_code(bg):
    """SGR background for the unfilled part of a gauge on a row painted `bg`.
    The gauges cover most of the row, so a fixed gray track would hide the
    stripes; a 256-color gray stripe gets a track three steps lighter, which
    stays visible against its own row yet differs from the next row's."""
    m = _GRAY_BG_RE.fullmatch(bg or "")
    if m and 232 <= int(m.group(1)) <= 255:
        return f"48;5;{min(int(m.group(1)) + 3, 255)}"
    return DEFAULT_TRACK


def paint_rows(rows):
    """`rows` is a list of (rendered_row, bg). Pads every row to one visible
    width and paints the background across the painted ones."""
    if not rows:
        return []
    width = max(visible_len(r) for r, _ in rows)
    painted = []
    for row, bg in rows:
        pad = " " * (width - visible_len(row))
        if not bg:
            painted.append(row + pad)
            continue
        painted.append(f"{bg}{row.replace(RESET, RESET + bg)}{pad}{RESET}")
    return painted


def row_color(account_number):
    if not ROW_COLORS:
        return DIM
    return ROW_COLORS[(account_number - 1) % len(ROW_COLORS)]


def _normalize(data):
    """Map fields from teamclaude builds whose status JSON predates the
    unified7dFable/disabled naming (e.g. the 1.3.x proxy endpoint)."""
    for acct in data.get("accounts", []):
        if "disabled" not in acct and "enabled" in acct:
            acct["disabled"] = not acct["enabled"]
        q = acct.get("quota") or {}
        if "unified7dFable" not in q:
            model_weekly = (q.get("modelWeekly") or {}).get("7d_oi") or {}
            if "utilization" in model_weekly:
                q["unified7dFable"] = model_weekly.get("utilization")
                q["unified7dFableReset"] = model_weekly.get("reset")
                acct["quota"] = q
    return data


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def load_profiles(data, config):
    """Restore billing metadata omitted by newer proxies; cache no credentials."""
    path = CACHE + ".profiles"
    try:
        with open(path) as f:
            cached = json.load(f)
        if not isinstance(cached, dict):
            cached = {}
    except (OSError, ValueError):
        cached = {}
    configured = {a.get("accountUuid"): a for a in config.get("accounts", []) if a.get("accountUuid")}
    now = time.time()

    def refresh(acct):
        uuid = acct.get("accountUuid")
        local = configured.get(uuid)
        if acct.get("profile") or not local or not local.get("accessToken"):
            return
        entry = cached.get(uuid) or {}
        ttl = 3600 if entry.get("profile") else 60
        if not 0 <= now - entry.get("checkedAt", 0) < ttl:
            entry = {"checkedAt": now}
            try:
                request = Request("https://api.anthropic.com/api/oauth/profile",
                                  headers={"Authorization": "Bearer " + local["accessToken"]})
                opener = build_opener(ProxyHandler({}), NoRedirect())
                with opener.open(request, timeout=1.5) as response:
                    profile = json.loads(response.read(262145))
                if profile.get("account", {}).get("uuid") == uuid:
                    org = profile.get("organization") or {}
                    entry["profile"] = {
                        "orgType": org.get("organization_type"),
                        "rateLimitTier": org.get("rate_limit_tier"),
                        "subscriptionStatus": org.get("subscription_status"),
                        "subscriptionCreatedAt": org.get("subscription_created_at"),
                    }
            except (OSError, ValueError, TypeError, AttributeError):
                pass
        cached[uuid] = entry
        if entry.get("profile"):
            acct["profile"] = entry["profile"]

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(refresh, data.get("accounts", [])))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=os.path.dirname(path), delete=False) as f:
            temporary = f.name
            json.dump({key: value for key, value in cached.items() if key in configured}, f)
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return data


def _http_status():
    """Fallback for teamclaude builds without `status --json`: read the
    running proxy's /teamclaude/status endpoint directly."""
    port = 3456
    api_key = None
    config = {}
    try:
        with open(os.path.expanduser(os.environ.get("TEAMCLAUDE_CONFIG", "~/.config/teamclaude.json"))) as f:
            config = json.load(f)
            proxy = config.get("proxy") or {}
            port = proxy.get("port") or 3456
            api_key = proxy.get("apiKey")
    except (OSError, ValueError):
        pass
    # sangrokjung/teamclaude (2026-09-10 단일 설치본) hides account names from
    # /teamclaude/status unless the caller proves it is local AND holds the
    # proxy key: send x-api-key + x-teamcodex-status-identity, same as the CLI.
    headers = {"x-teamcodex-status-identity": "1"}
    if api_key:
        headers["x-api-key"] = api_key
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("invalid local proxy port")
    req = Request(
        f"http://127.0.0.1:{port}/teamclaude/status", headers=headers
    )
    with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=3) as res:
        data = json.load(res)
    return load_profiles(data, config)


def load_status():
    try:
        st = os.stat(CACHE)
        if time.time() - st.st_mtime < CACHE_TTL:
            with open(CACHE) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    # The running proxy's HTTP status is the primary source: local, ~10 ms,
    # and (with the identity headers) complete. `teamclaude status --json`
    # only exists on some builds (not on the sangrokjung/teamclaude install
    # used since 2026-09-10) and spawning node costs ~0.5 s per render, so it
    # is the fallback now — reached only when the proxy is not answering.
    data = None
    try:
        data = _http_status()
    except Exception:
        data = None
    if data is None:
        try:
            out = subprocess.run(
                ["teamclaude", "status", "--json"],
                capture_output=True, text=True, timeout=5,
            )
            if out.returncode == 0:
                data = json.loads(out.stdout)
        except FileNotFoundError:
            return "missing"
        except Exception:
            data = None
    if data is None:
        return None
    try:
        data = _normalize(data)
        tmp = CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, CACHE)
    except Exception:
        pass
    return data


def plan_label(acct):
    """Billing-plan column ('Max 20x', 'Max 5x', 'Pro'), mirroring the TUI's
    tierLabel: the rate_limit_tier multiplier first, then the plan flags."""
    profile = acct.get("profile") or {}
    tier = profile.get("rateLimitTier") or ""
    multiplier = tier.rsplit("_", 1)[-1]
    if multiplier.endswith("x") and multiplier[:-1].isdigit():
        return f"Max {multiplier}"
    if profile.get("hasClaudeMax") or profile.get("orgType") == "claude_max":
        return "Max"
    if profile.get("hasClaudePro") or profile.get("orgType") == "claude_pro":
        return "Pro"
    return tier.removeprefix("default_") or None


def fmt_renewal(acct, today=None):
    """End-date gauge; ~ marks a monthly-anniversary estimate, not cancellation."""
    profile = acct.get("profile") or {}
    if today is None:
        today = date.today()
    end = (acct.get("subscription") or {}).get("endsAt")
    estimated = not end
    try:
        if end:
            candidate = datetime.fromtimestamp(_reset_ts(end) / 1000).date()
        else:
            if profile.get("subscriptionStatus") not in (None, "active", "trialing"):
                return None
            created = datetime.fromisoformat(str(profile.get("subscriptionCreatedAt")).replace("Z", "+00:00"))
            day = created.astimezone().day
            year, month = today.year, today.month
            clamp = lambda y, m: min(day, calendar.monthrange(y, m)[1])
            candidate = date(year, month, clamp(year, month))
            if candidate < today:
                month += 1
                if month > 12:
                    month, year = 1, year + 1
                candidate = date(year, month, clamp(year, month))
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    days = (candidate - today).days
    label = "past" if days < 0 else "D-DAY" if days == 0 else f"D-{days}"
    text = f"{'~' if estimated else ''}{candidate:%m/%d} {label}".center(14)
    if not COLOR:
        return f"[{text}]"
    bg = 41 if days <= 3 else 43 if days <= 7 else 42
    return f"\033[{bg};97m{text}{RESET}"


def _reset_ts(value):
    """Reset value (epoch millis or ISO string) → epoch millis, else None."""
    try:
        if isinstance(value, (int, float)):
            return value
        return datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        ).timestamp() * 1000
    except (TypeError, ValueError):
        return None


def accounts_by_weekly_reset(accounts, now):
    """Keep account numbers stable, but order rows like the proxy's own
    use-or-lose pick (`autoCompare`): soonest weekly (7d) reset, then soonest
    5h reset, then lowest 5h utilization, then account number. Past or missing
    resets sort last; an account with no 5h window (sessionWindowStated false)
    has an unknown 5h reset."""
    def future(value):
        reset = _reset_ts(value)
        return reset if reset is not None and reset > now * 1000 else float("inf")

    def key(item):
        q = item[1].get("quota") or {}
        five = float("inf") if q.get("sessionWindowStated") is False else future(q.get("unified5hReset"))
        util = q.get("unified5h")
        return (future(q.get("unified7dReset")), five,
                util if isinstance(util, (int, float)) else 0, item[0])

    return sorted(enumerate(accounts, 1), key=key)


def pool_quota(accounts):
    """Pool the fleet's quota the way the teamclaude TUI does: average
    utilization over enabled, non-errored accounts (unmeasured windows are
    skipped, not counted as zero), soonest reset per window. None for fewer
    than two poolable accounts — the single row already is the total."""
    pool = [
        a for a in accounts
        if not a.get("disabled") and a.get("status") != "error"
    ]
    if len(pool) < 2:
        return None

    def agg(value_key, reset_key, accounts=pool):
        vals, resets = [], []
        for acct in accounts:
            q = acct.get("quota") or {}
            v = q.get(value_key)
            if v is None:
                continue
            vals.append(v)
            ts = _reset_ts(q.get(reset_key))
            if ts:
                resets.append(ts)
        if not vals:
            return None, None
        return sum(vals) / len(vals), (min(resets) if resets else None)

    # Accounts with no 5-hour window at all (verified Ultra) are left out of
    # the session average; when none has one, the FLEET cell says so.
    with_session = [a for a in pool if not no_session_window(a.get("quota") or {})]
    return {
        "size": len(pool),
        "off": len(accounts) - len(pool),
        "five": agg("unified5h", "unified5hReset", with_session),
        "noFive": not with_session,
        "seven": agg("unified7d", "unified7dReset"),
        "fable": agg("unified7dFable", "unified7dFableReset"),
    }


def fmt_reset(value):
    """Accepts epoch millis (int) or an ISO-8601 string; returns local HH:MM."""
    if not value:
        return None
    try:
        if isinstance(value, (int, float)):
            dt = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        else:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M")
    except (ValueError, OSError):
        return None


def fmt_remaining(value, now=None):
    """Return a compact reset countdown such as 1d16h or 2h3m."""
    if not value:
        return None
    try:
        if isinstance(value, (int, float)):
            reset_at = value / 1000
        else:
            reset_at = datetime.fromisoformat(
                str(value).replace("Z", "+00:00")
            ).timestamp()
        seconds = reset_at - (time.time() if now is None else now)
        if seconds <= 0:
            return "now"
        minutes = int(seconds // 60)
        if minutes == 0:
            return "<1m"
        days, minutes = divmod(minutes, 24 * 60)
        hours, minutes = divmod(minutes, 60)
        if days:
            return f"{days}d{hours}h" if hours else f"{days}d"
        if hours:
            return f"{hours}h{minutes}m" if minutes else f"{hours}h"
        return f"{minutes}m"
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def bar(ratio, reset, now, width=None, track=DEFAULT_TRACK):
    """TUI-style quota gauge: `width` background-colored cells, filled
    proportionally to usage (green <70%, yellow <90%, red beyond) over a gray
    remainder (`track`, an SGR background code), with 'usage% countdown'
    centered inside. No-data windows render an all-track bar. Without colors,
    degrades to the bracketed label."""
    if width is None:
        width = BAR_W
    remaining = fmt_remaining(reset, now)

    if ratio is None:
        text = (remaining or "-")[:width].center(width)
        return f"\033[{track};37m{text}{RESET}" if COLOR else f"[{text}]"

    ratio = max(0.0, min(1.0, ratio))
    pct = f"{round(ratio * 100)}%"
    label = (
        f"{pct} {remaining}"
        if remaining and len(pct) + 1 + len(remaining) <= width
        else pct
    )
    text = label[:width].center(width)
    if not COLOR:
        return f"[{text}]"
    filled = round(ratio * width)
    bg = 42 if ratio < 0.7 else 43 if ratio < 0.9 else 41
    out = ""
    if filled:
        out += f"\033[{bg};97m{text[:filled]}"
    if filled < width:
        out += f"\033[{track};37m{text[filled:]}"
    return out + RESET


def no_session_window(q):
    """The proxy stated this account has no 5-hour window (verified Ultra,
    2026-10-30): quota.sessionWindowStated is JSON false. Missing / null /
    true keep the usual gauge."""
    return q.get("sessionWindowStated") is False


def none_cell(width=None, track=DEFAULT_TRACK):
    """Same-width 'none' cell for a window the account does not have, so it
    reads differently from an unmeasured '-' and stays aligned."""
    if width is None:
        width = BAR_W
    text = "none"[:width].center(width)
    return f"\033[{track};97m{text}{RESET}" if COLOR else f"[{text}]"


def session_cell(q, now, track=DEFAULT_TRACK):
    if no_session_window(q):
        return none_cell(track=track)
    return bar(q.get("unified5h"), q.get("unified5hReset"), now, track=track)


def bars_cell(q, now, label_color=None, track=DEFAULT_TRACK):
    """The three aligned gauges of a row: 5h session, 7d overall, 7d model
    (Fable, falling back to the Sonnet window when that is all there is)."""
    lc = DIM if label_color is None else label_color
    model_seven = q.get("unified7dFable")
    model_seven_reset = q.get("unified7dFableReset")
    if model_seven is None and q.get("unified7dSonnet") is not None:
        model_seven = q.get("unified7dSonnet")
        model_seven_reset = q.get("unified7dSonnetReset")
    return (
        f"{lc}Ses{RESET} {session_cell(q, now, track=track)} "
        f"{lc}Wk{RESET} {bar(q.get('unified7d'), q.get('unified7dReset'), now, track=track)} "
        f"{lc}Fbl{RESET} {bar(model_seven, model_seven_reset, now, track=track)}"
    )


def status_cell(acct):
    """Fixed-width status column: rate-limited stop marker first, then
    disabled, then a non-active account state, then the subscription status
    (red when billing is broken, green when active)."""
    if acct.get("rateLimitedUntil"):
        until = fmt_reset(acct["rateLimitedUntil"]) or ""
        return f"{RED}{f'!{until}'[:STATUS_W].ljust(STATUS_W)}{RESET}"
    if acct.get("disabled"):
        return f"{DIM}{'off'.ljust(STATUS_W)}{RESET}"
    if acct.get("status") not in (None, "active"):
        return f"{YELLOW}{str(acct['status'])[:STATUS_W].ljust(STATUS_W)}{RESET}"
    sub = (acct.get("profile") or {}).get("subscriptionStatus")
    if sub and sub not in ("active", "trialing"):
        return f"{RED}{sub[:STATUS_W].ljust(STATUS_W)}{RESET}"
    return f"{GREEN}{'active'.ljust(STATUS_W)}{RESET}"


def main():
    try:
        session = json.load(sys.stdin)
    except Exception:
        session = {}
    model = (session.get("model") or {}).get("display_name") or ""

    parts = []
    if model:
        parts.append(f"{MAGENTA}{model}{RESET}")
    # Under the tmux account footer (teamclaude/claude) the footer already shows the table.
    if os.environ.get("TEAMCLAUDE_HUD"):
        print(" │ ".join(parts))
        return

    data = load_status()
    if data == "missing":
        parts.append(f"{DIM}teamclaude not installed{RESET}")
        print(" │ ".join(parts))
        return
    if not data:
        parts.append(f"{RED}TC down{RESET}")
        print(" │ ".join(parts))
        return

    current = data.get("currentAccount")
    try:
        pinned_number = int(os.environ.get("TEAMCLAUDE_STATUSLINE_INDEX", ""))
        if pinned_number < 1:
            pinned_number = None
    except ValueError:
        pinned_number = None
    if data.get("routingPolicy") == "fable-reset":
        pinned_number = None
    now = time.time()
    accounts = data.get("accounts", [])

    pooled = pool_quota(accounts)
    rows = []
    # The plan column must fit the FLEET size label ("x3 +1 off" is wider
    # than "Max 20x") — ljust never truncates, so a fixed width would shift
    # the FLEET row out of column whenever an account is off.
    plan_w = PLAN_W
    if pooled:
        size = f"x{pooled['size']}" + (
            f" +{pooled['off']} off" if pooled["off"] else ""
        )
        plan_w = max(plan_w, len(size))
        # The gutter is wrapped in ANSI codes so the raw line does not begin
        # with whitespace — Claude Code trims leading spaces off status-line
        # rows, which would shift the FLEET row out of column.
        bg = row_bg(len(rows))
        track = track_code(bg)
        rows.append((
            f"{DIM}     {RESET}{BOLD}{'FLEET'.ljust(NAME_W)}{RESET} "
            f"{DIM}{size.ljust(plan_w)}{RESET} "
            f"{DIM}{'pooled'.ljust(STATUS_W)}{RESET} "
            f"{DIM}Ses{RESET} "
            f"{none_cell(track=track) if pooled['noFive'] else bar(*pooled['five'], now, track=track)} "
            f"{DIM}Wk{RESET} {bar(*pooled['seven'], now, track=track)} "
            f"{DIM}Fbl{RESET} {bar(*pooled['fable'], now, track=track)}",
            bg,
        ))

    for account_number, acct in accounts_by_weekly_reset(accounts, now):
        name = (acct.get("name") or "?")[:NAME_W]
        is_current = (
            account_number == pinned_number
            if pinned_number is not None
            else acct.get("name") == current
        )
        accent = row_color(account_number)
        bg = row_bg(len(rows))
        # Same trim guard as the FLEET gutter for the blank marker cell.
        marker = f"{accent}>{RESET}" if is_current else f"{DIM} {RESET}"
        name_cell = (
            f"{BOLD}{accent}{name.ljust(NAME_W)}{RESET}"
            if is_current
            else f"{accent}{name.ljust(NAME_W)}{RESET}"
        )
        plan = (plan_label(acct) or "")[:plan_w]
        row = (
            f"{marker}{accent}{account_number:>2}.{RESET} {name_cell} "
            f"{accent}{plan.ljust(plan_w)}{RESET} {status_cell(acct)} "
            f"{bars_cell(acct.get('quota') or {}, now, accent, track_code(bg))}"
        )
        renewal = fmt_renewal(acct)
        unknown = f"\033[100;37m{'-'.center(14)}{RESET}" if COLOR else f"[{'-'.center(14)}]"
        row += f" {accent}End{RESET} {renewal or unknown}"
        rows.append((row, bg))

    print(ROW_SEP.join(parts + paint_rows(rows)))


if __name__ == "__main__":
    main()
