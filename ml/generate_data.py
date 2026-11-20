"""Synthetic group purchase histories, in the shape of ItemHistory trip rows.

Real groups only have a handful of completed trips at first, which is not enough
to train on, so this generates believable households from the real catalog ids:

  - staples: 5 to 12 per group, each with its own repeat interval and a jittered
    schedule, so "bought regularly and overdue" is a real signal;
  - occasional items: a small chance of appearing on any trip;
  - one-off items: appear once, as noise;
  - trips every 3 to 10 days.

The seed is fixed, so every run produces the same data.

Writes:
  out/history.csv                 the training rows
  out/criterion3_fixture.json     one held-out group, its history and its next trip

The fixture group is not part of the training data: the criterion 3 test scores it
and measures how many suggestions the next trip really contained.
"""

import csv
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT.parent / "data" / "catalog.json"
OUT = ROOT / "out"

SEED = 20261120
TRAIN_GROUPS = 200
FIXTURE_SEED_OFFSET = 8
FIXTURE_TRIPS = 30
FIXTURE_MIN_ITEMS = 7
DAY_MS = 86_400_000
HOUR_MS = 3_600_000
MINUTE_MS = 60_000

# a realistic base date: 2025-01-01T00:00:00Z
BASE_MS = 1_735_689_600_000

STAPLE_INTERVALS = [3, 4, 5, 7, 7, 10, 14, 14, 21, 30]
UNITS = ["piece", "piece", "piece", "box", "kg"]


def load_catalog_ids():
    items = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return sorted({item["id"] for item in items if isinstance(item.get("id"), str)})


def sizing_for(rng):
    unit = rng.choice(UNITS)
    quantity = round(rng.uniform(0.5, 3.0), 1) if unit == "kg" else rng.randint(1, 3)
    return quantity, unit


def make_profile(rng, catalog_ids):
    staples = rng.sample(catalog_ids, rng.randint(5, 12))
    taken = set(staples)

    occasional = rng.sample([item for item in catalog_ids if item not in taken], 8)
    taken.update(occasional)

    one_offs = rng.sample([item for item in catalog_ids if item not in taken], 3)

    profile = {
        "staples": {
            item: {"interval": rng.choice(STAPLE_INTERVALS), "sizing": sizing_for(rng)}
            for item in staples
        },
        "occasional": {item: rng.uniform(0.04, 0.10) for item in occasional},
        "one_offs": {item: sizing_for(rng) for item in one_offs},
    }
    return profile
    return profile


def build_trips(rng, profile, trip_count):
    """One group's trips, oldest first: {day, items: [catalogItemId]}."""
    next_due = {item: None for item in profile["staples"]}
    one_off_trip = {item: rng.randint(1, trip_count - 1) for item in profile["one_offs"]}

    trips = []
    day = rng.uniform(0, 30)

    for index in range(trip_count):
        if index > 0:
            day += rng.randint(3, 10) + rng.uniform(-0.8, 0.8)

        items = []

        for item, staple in profile["staples"].items():
            due = next_due[item]

            if due is None or day >= due:
                # due now; a due staple is occasionally skipped, and stays due
                if due is not None and rng.random() < 0.06:
                    continue
                items.append(item)
                next_due[item] = day + staple["interval"] * min(1.3, max(0.75, rng.gauss(1.0, 0.12)))
            elif rng.random() < 0.03:
                # bought early, off schedule
                items.append(item)
                next_due[item] = day + staple["interval"] * min(1.3, max(0.75, rng.gauss(1.0, 0.12)))

        for item, chance in profile["occasional"].items():
            if rng.random() < chance:
                items.append(item)

        for item in profile["one_offs"]:
            if one_off_trip[item] == index:
                items.append(item)

        trips.append({"day": day, "items": items})

    return trips


def sizing_of(profile, item):
    if item in profile["staples"]:
        return profile["staples"][item]["sizing"]
    if item in profile["one_offs"]:
        return profile["one_offs"][item]
    return (1, "piece")


def rows_for_group(rng, group_key, trips, profile):
    rows = []

    for index, trip in enumerate(trips):
        trip_id = f"{group_key}-t{index:02d}"
        trip_start = BASE_MS + int(trip["day"] * DAY_MS) + rng.randint(8, 20) * HOUR_MS
        completed = trip_start + rng.randint(45, 90) * MINUTE_MS
        offset = 0

        for item in trip["items"]:
            offset += rng.randint(1, 6) * MINUTE_MS
            quantity, unit = sizing_of(profile, item)
            rows.append({
                "group": group_key,
                "tripId": trip_id,
                "catalogItemId": item,
                "quantity": quantity,
                "unit": unit,
                "addedAt": trip_start + offset,
                "createdAt": completed,
                "status": "notFound" if rng.random() < 0.08 else "found",
            })

    return rows


def iso(ms):
    from features import to_iso
    return to_iso(ms)


def main():
    catalog_ids = load_catalog_ids()
    OUT.mkdir(exist_ok=True)

    rng = random.Random(SEED)
    rows = []

    for index in range(TRAIN_GROUPS):
        group_key = f"g{index:03d}"
        profile = make_profile(rng, catalog_ids)
        trips = build_trips(rng, profile, rng.randint(20, 40))
        rows.extend(rows_for_group(rng, group_key, trips, profile))

    with open(OUT / "history.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=[
            "group", "tripId", "catalogItemId", "quantity", "unit", "addedAt", "createdAt", "status",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "addedAt": iso(row["addedAt"]), "createdAt": iso(row["createdAt"])})

    # The criterion 3 fixture: a household the model never trains on, its history, and the shop
    # that comes next. The next shop is the household's first big one (FIXTURE_MIN_ITEMS or more),
    # because with eight suggestions at most a small top-up trip cannot reach 80% precision: three
    # items on the trip against eight suggestions is 3/8 however good the ranking is.
    fixture_rng = random.Random(SEED + FIXTURE_SEED_OFFSET)
    fixture_profile = make_profile(fixture_rng, catalog_ids)
    fixture_trips = build_trips(fixture_rng, fixture_profile, FIXTURE_TRIPS)

    next_index = next(
        index for index, trip in enumerate(fixture_trips)
        if index >= 3 and len(trip["items"]) >= FIXTURE_MIN_ITEMS
    )

    history_trips = fixture_trips[:next_index]
    next_trip = fixture_trips[next_index]

    history_rows = rows_for_group(fixture_rng, "fixture-criterion3", history_trips, fixture_profile)

    next_start = BASE_MS + int(next_trip["day"] * DAY_MS) + 12 * HOUR_MS

    trips_out = []
    for index, trip in enumerate(history_trips):
        trip_rows = [row for row in history_rows if row["tripId"] == f"fixture-criterion3-t{index:02d}"]
        trip_time = min(row["createdAt"] for row in trip_rows)
        trips_out.append({
            "daysBeforeNow": round((next_start - trip_time) / DAY_MS, 6),
            "items": [
                {
                    "catalogItemId": row["catalogItemId"],
                    "quantity": row["quantity"],
                    "unit": row["unit"],
                    "status": row["status"],
                }
                for row in trip_rows
            ],
        })

    fixture = {
        "group": "fixture-criterion3",
        "note": (
            "A group the model never trains on. daysBeforeNow is how long before the moment the next "
            "list is started each trip was completed, so a test can place the history relative to now."
        ),
        "trips": trips_out,
        "nextTrip": next_trip["items"],
    }

    (OUT / "criterion3_fixture.json").write_text(json.dumps(fixture, indent=2), encoding="utf-8")

    print(f"{len(rows)} rows from {TRAIN_GROUPS} groups -> out/history.csv")
    print(f"criterion 3 fixture: {len(history_trips)} trips, next trip has {len(next_trip['items'])} items")


if __name__ == "__main__":
    main()
