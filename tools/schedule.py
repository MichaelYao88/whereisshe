#!/usr/bin/env python3
"""Edit and check the daily schedule.

  python3 tools/schedule.py validate
  python3 tools/schedule.py --build          # rebuild puzzles-data.js, then validate
  python3 tools/schedule.py puzzle-for 2026-10-29

An empty rotation is valid. puzzle_for() returns (None, "none") for a date that
is not pinned, and never raises or wraps around onto earlier puzzles.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "puzzles-data.js"
SCHEDULE = ROOT / "schedule.json"

# Kept verbatim. validate() rejects any edit to this he-001 note.
HE_001_EXCEPTION = (
    "single video: Michael's only usable clip is Mumbai (round 1); "
    "the other clip in that highlight is a street vendor in the same city, so no round-5 video"
)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def utc(key):
    year, month, day = map(int, key.split("-"))
    return datetime(year, month, day, tzinfo=timezone.utc)


def add_days(key, n):
    d = utc(key) + timedelta(days=n)
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


def load_schedule():
    if not SCHEDULE.is_file():
        raise SystemExit("schedule.json is missing")
    data = json.loads(SCHEDULE.read_text())
    if not isinstance(data, dict):
        raise SystemExit("schedule.json must be an object")
    return data


def load_rows():
    text = DATA.read_text()
    match = re.search(r"window\.WIS_PUZZLE_ROWS = (\[.*\]);", text, re.S)
    if not match:
        raise SystemExit("puzzles-data.js has no WIS_PUZZLE_ROWS")
    rows = json.loads(match.group(1))
    by = {}
    order = []
    for row in rows:
        pid = row.get("puzzle_id")
        if not pid:
            continue
        if pid not in by:
            order.append(pid)
            by[pid] = []
        by[pid].append(row)
    for pid in by:
        by[pid].sort(key=lambda row: int(row.get("round") or 0))
    return by, order


def load_embedded_schedule():
    text = DATA.read_text()
    match = re.search(r"window\.WIS_SCHEDULE = (\{.*\});", text, re.S)
    if not match:
        raise SystemExit("puzzles-data.js has no WIS_SCHEDULE")
    return json.loads(match.group(1))


def puzzle_for(key, schedule, ids):
    """Return (puzzle_id or None, "pinned"|"rotation"|"none").

    Empty rotation yields (None, "none"). It does not raise and it does not loop.
    """
    dates = schedule.get("dates") or {}
    pinned = dates.get(key)
    if pinned and pinned in ids:
        return pinned, "pinned"
    rotation = schedule.get("rotation") or []
    rot = [pid for pid in rotation if pid in ids]
    if not rot:
        return None, "none"
    keys = sorted(k for k in dates if DATE_RE.match(k or ""))
    last = keys[-1] if keys else None
    if last and utc(key) > utc(last):
        n = round((utc(key) - utc(last)).total_seconds() / 86400) - 1
    else:
        epoch = schedule.get("epoch") or key
        n = round((utc(key) - utc(epoch)).total_seconds() / 86400)
    return rot[((n % len(rot)) + len(rot)) % len(rot)], "rotation"


def video_positions(rows):
    return [i + 1 for i, row in enumerate(rows) if row.get("media_type") == "video"]


def video_problem(pid, rows, exceptions):
    positions = video_positions(rows)
    got = ",".join(str(n) for n in positions) or "none"
    if not positions or positions[0] != 1:
        return f"{pid}: round 1 must be a video (videos in {got})"
    if pid in exceptions:
        if got != "1":
            return f"{pid}: exception allows a video in round 1 only (videos in {got})"
        return None
    if got == "1,2,3,4,5":
        return None  # all-video day (Michael, 2026-10-24)
    if len(positions) >= 3:
        if not (positions[0] == 1 and positions[1] == 2 and positions[-1] == 5 and len(positions) == 3):
            return f"{pid}: a 3-video day must be rounds 1, 2 and 5 only (videos in {got})"
        return None
    if got != "1,5":
        return f"{pid}: videos must be rounds 1 and 5, or rounds 1, 2 and 5 (videos in {got})"
    return None


def self_check():
    """Empty rotation is valid and does not loop. Non-empty rotation still wraps."""
    ids = {"she-001", "she-002"}
    empty = {"epoch": "2026-10-21", "dates": {"2026-10-21": "she-001"}, "rotation": []}
    if puzzle_for("2026-10-22", empty, ids) != (None, "none"):
        raise SystemExit("self-check: empty rotation must return nothing")
    if puzzle_for("2026-10-21", empty, ids) != ("she-001", "pinned"):
        raise SystemExit("self-check: a pin must win over an empty rotation")
    missing = {"epoch": "2026-10-21", "dates": {"2026-10-21": "she-001"}}
    if puzzle_for("2026-10-23", missing, ids) != (None, "none"):
        raise SystemExit("self-check: a missing rotation must return nothing")
    looping = {"epoch": "2026-10-21", "dates": {"2026-10-21": "she-001"}, "rotation": ["she-001", "she-002"]}
    if puzzle_for("2026-10-22", looping, ids) != ("she-001", "rotation"):
        raise SystemExit("self-check: first day after the last pin is rotation[0]")
    if puzzle_for("2026-10-23", looping, ids) != ("she-002", "rotation"):
        raise SystemExit("self-check: rotation index advanced")


def check_file(path, errors, label):
    if not path:
        errors.append(f"{label}: missing media path")
        return
    if str(path).startswith("https://") or str(path).startswith("http://"):
        return
    rel = Path(str(path))
    if rel.is_absolute() or ".." in rel.parts:
        errors.append(f"{label}: unsafe path {path}")
        return
    if not (ROOT / rel).is_file():
        errors.append(f"{label}: file not found ({path})")


def validate():
    self_check()
    errors = []
    schedule = load_schedule()
    by, order = load_rows()
    ids = set(by)
    embedded = load_embedded_schedule()
    if embedded != schedule:
        errors.append("puzzles-data.js schedule does not match schedule.json (run python3 build.py)")

    epoch = schedule.get("epoch")
    if not isinstance(epoch, str) or not DATE_RE.match(epoch):
        errors.append("epoch must be YYYY-MM-DD")
    rotation = schedule.get("rotation", [])
    if not isinstance(rotation, list):
        errors.append("rotation must be a list (an empty list is valid)")
    else:
        for pid in rotation:
            if pid not in ids:
                errors.append(f"rotation lists unknown puzzle {pid}")
    exceptions = schedule.get("exceptions") or {}
    if not isinstance(exceptions, dict):
        errors.append("exceptions must be an object")
        exceptions = {}
    if exceptions.get("he-001") != HE_001_EXCEPTION:
        errors.append("he-001 exception text must stay as it is")
    for pid in exceptions:
        if pid not in ids:
            errors.append(f"exception for unknown puzzle {pid}")

    dates = schedule.get("dates") or {}
    if not isinstance(dates, dict) or not dates:
        errors.append("dates must map YYYY-MM-DD to a puzzle id")
        dates = {}
    for key, pid in dates.items():
        if not DATE_RE.match(str(key)):
            errors.append(f"bad date key {key}")
        if pid not in ids:
            errors.append(f"{key} pins unknown puzzle {pid}")

    for pid in order:
        rows = by[pid]
        rounds = [row.get("round") for row in rows]
        if rounds != [1, 2, 3, 4, 5]:
            errors.append(f"{pid}: expected rounds 1–5, got {rounds}")
        featured = next((row for row in rows if row.get("featured_handle")), None)
        placeholder = any(row.get("placeholder") for row in rows)
        if not placeholder and not (featured and featured.get("consent_on")):
            errors.append(f"{pid}: needs featured_handle and consent_on")
        problem = video_problem(pid, rows, exceptions)
        if problem:
            errors.append(problem)
        for row in rows:
            n = row.get("round")
            if row.get("media_type") == "video":
                check_file(row.get("video_url"), errors, f"{pid} round {n} video")
                check_file(row.get("poster_url"), errors, f"{pid} round {n} poster")
            else:
                check_file(row.get("image_url"), errors, f"{pid} round {n} image")
            avatar = row.get("featured_avatar")
            if avatar:
                check_file(avatar, errors, f"{pid} round {n} avatar")

    if isinstance(rotation, list) and dates:
        last = max(dates)
        nxt = add_days(last, 1)
        pid, how = puzzle_for(nxt, schedule, ids)
        if rotation:
            if how != "rotation" or not pid:
                errors.append(f"{nxt} should come from rotation, got {pid!r} ({how})")
        elif pid is not None or how != "none":
            errors.append(f"empty rotation must schedule nothing on {nxt}, got {pid!r} ({how})")
        # A second unpinned day must not wrap back to the first puzzle either.
        if not rotation:
            later, later_how = puzzle_for(add_days(last, 2), schedule, ids)
            if later is not None or later_how != "none":
                errors.append(f"empty rotation looped on {add_days(last, 2)}: {later!r}")

    return errors, schedule, by


def print_schedule(schedule, by):
    dates = schedule.get("dates") or {}
    ids = set(by)
    print(f"rotation: {schedule.get('rotation', [])!r}")
    print(f"exceptions: {', '.join(schedule.get('exceptions') or {}) or '(none)'}")
    for key in sorted(dates):
        pid = dates[key]
        rows = by.get(pid) or []
        videos = ",".join(str(n) for n in video_positions(rows)) or "-"
        who = next((row.get("featured_handle") for row in rows if row.get("featured_handle")), "")
        print(f"  {key}  {pid}  pinned  videos {videos}  @{who}")
    if dates:
        last = max(dates)
        for n in (1, 2, 3):
            key = add_days(last, n)
            pid, how = puzzle_for(key, schedule, ids)
            print(f"  {key}  {pid or 'nothing'}  {how}")


def main(argv):
    args = argv[1:]
    if "--build" in args or "build" in args:
        subprocess.check_call([sys.executable, str(ROOT / "build.py")], cwd=ROOT)
    if any(a in ("puzzle-for", "puzzle_for") for a in args):
        i = args.index("puzzle-for") if "puzzle-for" in args else args.index("puzzle_for")
        if i + 1 >= len(args):
            raise SystemExit("usage: tools/schedule.py puzzle-for YYYY-MM-DD")
        key = args[i + 1]
        schedule = load_schedule()
        by, _order = load_rows()
        pid, how = puzzle_for(key, schedule, set(by))
        print(f"{key}\t{pid or 'nothing'}\t{how}")
        return 0
    errors, schedule, by = validate()
    print_schedule(schedule, by)
    if errors:
        print(f"validate: {len(errors)} error(s)", file=sys.stderr)
        for err in errors:
            print(f"  {err}", file=sys.stderr)
        return 1
    print("validate: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
