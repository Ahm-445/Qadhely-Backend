"""The feature definitions of the AI suggestions model.

Section 5 of the plan is the specification. This module is the Python half;
src/services/suggestions.js is the Node half. They must compute the same
numbers, which out/parity_fixture.json and the parity test check.

A row is a dict shaped like an ItemHistory row:
    group, tripId, catalogItemId, quantity, unit, addedAt, createdAt, status

Timestamps may be milliseconds since the epoch or ISO 8601 strings.
"""

import math
import statistics
from datetime import datetime, timezone

DAY_MS = 86_400_000

FEATURE_NAMES = [
    "trip_freq",
    "recent_freq",
    "log_count",
    "days_since_last",
    "trips_since_last",
    "median_interval",
    "due_ratio",
    "interval_cv",
    "in_last_trip",
]

# used when an item has no intervals yet; train.py replaces it with the median
# interval across all training data
DEFAULT_MEDIAN_INTERVAL = 9.5


def to_ms(value):
    """A timestamp as milliseconds since the epoch."""
    if isinstance(value, bool):
        raise TypeError("a timestamp cannot be a bool")
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000.0


def to_iso(ms):
    """Milliseconds since the epoch as an ISO 8601 UTC string, to the millisecond.

    Milliseconds only: JavaScript's Date parses that everywhere, and the parity
    fixture must not depend on a lenient parser.
    """
    seconds, remainder = divmod(int(round(ms)), 1000)
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{stamp}.{remainder:03d}Z"

def trip_rows(rows):
    """One group's rows grouped into trips, oldest first.

    Trip time is the completion time of the trip: the earliest createdAt among
    its rows. Rows with no tripId (items added and never completed) and custom
    items (no catalogItemId) are left out.
    """
    by_trip = {}

    for row in rows:
        trip_id = row.get("tripId")
        item_id = row.get("catalogItemId")

        if trip_id is None or not item_id:
            continue

        key = str(trip_id)
        trip = by_trip.get(key)
        if trip is None:
            trip = by_trip[key] = {"tripId": key, "rows": [], "itemIds": set(), "time": None}

        trip["rows"].append(row)
        trip["itemIds"].add(item_id)

        created = to_ms(row["createdAt"])
        if trip["time"] is None or created < trip["time"]:
            trip["time"] = created

    return sorted(by_trip.values(), key=lambda trip: (trip["time"], trip["tripId"]))


def candidate_features(trips, now_ms, fallback_median_interval=DEFAULT_MEDIAN_INTERVAL):
    """One (catalogItemId, features) pair per item bought in `trips`.

    `trips` are the group's past trips, oldest first, all before `now_ms`.
    Every feature reads only those trips, so a target trip never leaks into
    its own features.
    """
    count_trips = len(trips)
    if count_trips == 0:
        return []

    purchases = {}
    for trip in trips:
        for item_id in trip["itemIds"]:
            purchases.setdefault(item_id, []).append(trip["time"])

    recent = trips[max(0, count_trips - 3):]
    recent_divisor = min(3, count_trips)
    last_trip = trips[-1]["itemIds"]
    result = []

    for item_id in sorted(purchases):
        times = purchases[item_id]
        bought = len(times)

        days_since_last = (now_ms - times[-1]) / DAY_MS
        intervals = [(later - earlier) / DAY_MS for earlier, later in zip(times, times[1:])]

        median_interval = statistics.median(intervals) if intervals else fallback_median_interval

        if len(intervals) >= 2:
            mean = sum(intervals) / len(intervals)
            variance = sum((interval - mean) ** 2 for interval in intervals) / len(intervals)
            interval_cv = math.sqrt(variance) / mean if mean > 0 else 1.0
        else:
            interval_cv = 1.0

        result.append((item_id, {
            "trip_freq": bought / count_trips,
            "recent_freq": sum(1 for trip in recent if item_id in trip["itemIds"]) / recent_divisor,
            "log_count": math.log1p(bought),
            "days_since_last": days_since_last,
            "trips_since_last": sum(1 for trip in trips if trip["time"] > times[-1]),
            "median_interval": median_interval,
            "due_ratio": min(5.0, days_since_last / max(1.0, median_interval)),
            "interval_cv": interval_cv,
            "in_last_trip": 1.0 if item_id in last_trip else 0.0,
        }))

    return result


def intervals_of(rows):
    """Every gap in days between two consecutive purchases of one item, all groups."""
    gaps = []
    for rows_of_group in rows:
        for _item_id, times in _purchase_times(rows_of_group).items():
            gaps.extend((later - earlier) / DAY_MS for earlier, later in zip(times, times[1:]))
    return gaps


def _purchase_times(rows):
    purchases = {}
    for trip in trip_rows(rows):
        for item_id in trip["itemIds"]:
            purchases.setdefault(item_id, []).append(trip["time"])
    return purchases


def fallback_median_interval(groups):
    """The median interval in days across all training data (plan section 8)."""
    gaps = []
    for rows in groups:
        gaps.extend(intervals_of([rows]))
    return statistics.median(gaps) if gaps else DEFAULT_MEDIAN_INTERVAL
