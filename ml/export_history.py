"""Real ItemHistory trip rows from MongoDB, as a CSV train.py can read.

Only rows with a tripId are exported: an addition whose trip never completed was
added to a list and never bought, so it is not a shopping event.

    py -3 export_history.py                     # uses MONGODB_URI or mongodb://127.0.0.1:27017
    py -3 export_history.py --uri <uri> --db qadhely --out out/real_history.csv

train.py picks up out/real_history.csv automatically when it exists.
"""

import argparse
import csv
import os
from pathlib import Path

from pymongo import MongoClient

from features import to_iso

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"

FIELDS = ["group", "tripId", "catalogItemId", "quantity", "unit", "addedAt", "createdAt", "status"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uri", default=os.environ.get("MONGODB_URI", "mongodb://127.0.0.1:27017"))
    parser.add_argument("--db", default=os.environ.get("MONGODB_DB", "qadhely"))
    parser.add_argument("--out", default=str(OUT / "real_history.csv"))
    args = parser.parse_args()

    client = MongoClient(args.uri)
    collection = client[args.db]["itemhistories"]

    query = {"tripId": {"$ne": None}, "catalogItemId": {"$ne": None}}
    projection = {"_id": 0, **{field: 1 for field in FIELDS}}

    rows = []
    for record in collection.find(query, projection):
        rows.append({
            "group": str(record["group"]),
            "tripId": str(record["tripId"]),
            "catalogItemId": record["catalogItemId"],
            "quantity": record.get("quantity", 1),
            "unit": record.get("unit", "piece"),
            "addedAt": to_iso(record["addedAt"].timestamp() * 1000),
            "createdAt": to_iso(record["createdAt"].timestamp() * 1000),
            "status": record.get("status", "found"),
        })

    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)

    with open(target, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    trips = len({row["tripId"] for row in rows})
    print(f"{len(rows)} trip rows in {trips} trips -> {target}")


if __name__ == "__main__":
    main()
