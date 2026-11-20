"""Train the suggestions model and write out/model.json.

  out/history.csv                -> feature table (one request per target trip)
  GroupKFold(5) over groups      -> out-of-fold probabilities
  threshold and k on those folds -> the operating point
  fit on everything              -> out/model.json, out/parity_fixture.json,
                                    out/validation.json (for evaluate.py)

The model is a logistic regression on standardized features, so the Node scorer
needs only mean, scale, coef and intercept. Two non-ML baselines are measured on
the same folds: trip_freq >= 0.5 and due_ratio >= 0.8.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from features import (
    DAY_MS,
    FEATURE_NAMES,
    candidate_features,
    fallback_median_interval,
    to_iso,
    to_ms,
    trip_rows,
)

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
SERVER_MODEL = ROOT.parent / "src" / "services" / "suggestions.model.json"

VERSION = 1
MAX_SUGGESTIONS = 8
# completed lists a group needs before it gets suggestions; the same as MIN_PAST_TRIPS, so the server
# only scores groups with as much history as the training examples had (the app tells the user this)
MIN_TRIPS = 3
MIN_PAST_TRIPS = 3
TARGET_PRECISION = 0.85
THRESHOLDS = [round(0.30 + 0.01 * step, 2) for step in range(66)]


def load_groups(path):
    frame = pd.read_csv(path)
    groups = {}

    for record in frame.to_dict("records"):
        groups.setdefault(record["group"], []).append({
            "group": record["group"],
            "tripId": record["tripId"],
            "catalogItemId": record["catalogItemId"],
            "quantity": float(record["quantity"]),
            "unit": record["unit"],
            "addedAt": to_ms(record["addedAt"]),
            "createdAt": to_ms(record["createdAt"]),
            "status": record["status"],
        })

    return groups


def build_requests(groups, fallback):
    """One request per target trip that has at least three past trips."""
    requests = []

    for group, rows in groups.items():
        trips = trip_rows(rows)

        for index in range(MIN_PAST_TRIPS, len(trips)):
            target = trips[index]
            now = min(to_ms(row["addedAt"]) for row in target["rows"])
            candidates = candidate_features(trips[:index], now, fallback)

            if not candidates:
                continue

            ids = [item for item, _ in candidates]
            matrix = np.array([[f[name] for name in FEATURE_NAMES] for _, f in candidates], dtype=float)

            requests.append({
                "group": group,
                "tripId": target["tripId"],
                "ids": ids,
                "X": matrix,
                "y": np.array([1 if item in target["itemIds"] else 0 for item in ids], dtype=int),
            })

    return requests


def stack(requests):
    return np.vstack([request["X"] for request in requests]), np.concatenate([request["y"] for request in requests])


def make_model():
    return Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(class_weight="balanced", max_iter=1000)),
    ])


def pick(probs, threshold, k):
    """The indexes of the suggestions for one request: above the threshold, best k."""
    above = np.nonzero(probs >= threshold)[0]
    if above.size == 0:
        return above
    order = np.argsort(-probs[above], kind="stable")
    return above[order][:k]


def measure(requests, prob_lists, threshold, k=MAX_SUGGESTIONS):
    precisions, recalls, covered = [], [], 0

    for request, probs in zip(requests, prob_lists):
        picked = pick(np.asarray(probs), threshold, k)
        if picked.size == 0:
            continue

        covered += 1
        truth = request["y"]
        hits = int(truth[picked].sum())
        precisions.append(hits / picked.size)
        recalls.append(hits / max(1, int(truth.sum())))

    return {
        "threshold": float(threshold),
        "precisionAtK": float(np.mean(precisions)) if precisions else 0.0,
        "recallAtK": float(np.mean(recalls)) if recalls else 0.0,
        "coverage": covered / len(requests) if requests else 0.0,
        "suggestionsPerRequest": float(np.mean([len(pick(np.asarray(p), threshold, k)) for p in prob_lists])),
    }


def cross_validate(requests):
    matrix, labels = stack(requests)
    groups = np.array([request["group"] for request in requests])
    owner = np.concatenate([np.full(len(request["y"]), position) for position, request in enumerate(requests)])
    row_groups = groups[owner]

    out_of_fold = np.zeros(len(labels))
    aucs = []

    for train_index, valid_index in GroupKFold(n_splits=5).split(matrix, labels, row_groups):
        model = make_model()
        model.fit(matrix[train_index], labels[train_index])

        probs = model.predict_proba(matrix[valid_index])[:, 1]
        out_of_fold[valid_index] = probs
        aucs.append(roc_auc_score(labels[valid_index], probs))

    prob_lists = [np.array([out_of_fold[row] for row in np.nonzero(owner == position)[0]])
                  for position in range(len(requests))]

    return prob_lists, float(np.mean(aucs))


def choose_threshold(requests, prob_lists):
    """The lowest threshold whose mean per-request precision reaches the target."""
    table = [measure(requests, prob_lists, threshold) for threshold in THRESHOLDS]

    for row in table:
        if row["precisionAtK"] >= TARGET_PRECISION and row["coverage"] >= 0.5:
            return row, table

    best = max(table, key=lambda row: (row["precisionAtK"], -row["threshold"]))
    return best, table


def parity_fixture(groups, model, fallback, version):
    """A small history, a fixed now, and what Python computes for it."""
    rows = groups["g000"]
    trips = trip_rows(rows)
    target = trips[3]
    now = min(to_ms(row["addedAt"]) for row in target["rows"])

    history = [row for trip in trips[:3] for row in trip["rows"]]
    # an addition whose trip never completed: it must not become a candidate
    history.append({
        "group": "g000",
        "tripId": None,
        "catalogItemId": "tamimi-000000",
        "quantity": 1.0,
        "unit": "piece",
        "addedAt": now - 2 * DAY_MS,
        "createdAt": now - 2 * DAY_MS,
        "status": "pending",
    })

    candidates = candidate_features(trips[:3], now, fallback)
    matrix = np.array([[f[name] for name in FEATURE_NAMES] for _, f in candidates], dtype=float)
    probabilities = model.predict_proba(matrix)[:, 1]

    return {
        "modelVersion": version,
        "now": to_iso(now),
        "fallbackMedianInterval": fallback,
        "features": FEATURE_NAMES,
        "history": [
            {
                "group": row["group"],
                "tripId": row["tripId"],
                "catalogItemId": row["catalogItemId"],
                "quantity": row["quantity"],
                "unit": row["unit"],
                "addedAt": to_iso(row["addedAt"]),
                "createdAt": to_iso(row["createdAt"]),
                "status": row["status"],
            }
            for row in history
        ],
        "candidates": [
            {
                "catalogItemId": item,
                "features": {name: f[name] for name in FEATURE_NAMES},
                "probability": float(probability),
            }
            for (item, f), probability in zip(candidates, probabilities)
        ],
    }


def check_criterion3(model, fallback):
    """How well the trained model does on each held-out criterion 3 household."""
    path = OUT / "criterion3_households.json"
    if not path.exists():
        return None

    households = json.loads(path.read_text(encoding="utf-8"))["households"]
    return [score_household(model, fallback, fixture) for fixture in households]


def score_household(model, fallback, fixture):
    rows = []

    for index, trip in enumerate(fixture["trips"]):
        trip_time = -float(trip["daysBeforeNow"]) * DAY_MS
        completed = trip_time
        for offset, item in enumerate(trip["items"]):
            rows.append({
                "group": fixture["group"],
                "tripId": f"fixture-criterion3-t{index:02d}",
                "catalogItemId": item["catalogItemId"],
                "quantity": item["quantity"],
                "unit": item["unit"],
                "addedAt": completed - (len(trip["items"]) - offset) * 60_000,
                "createdAt": completed,
                "status": item["status"],
            })

    candidates = candidate_features(trip_rows(rows), 0.0, fallback)
    matrix = np.array([[f[name] for name in FEATURE_NAMES] for _, f in candidates], dtype=float)
    probs = model.predict_proba(matrix)[:, 1]
    ids = [item for item, _ in candidates]

    return {"ids": ids, "probs": probs, "truth": set(fixture["nextTrip"])}


def criterion3_measure(checked, threshold):
    """Precision pooled over the households: suggested items that were bought ÷ suggested items."""
    if checked is None:
        return None

    suggested = hits = 0

    for household in checked:
        order = np.argsort(-household["probs"], kind="stable")
        picked = [household["ids"][i] for i in order if household["probs"][i] >= threshold][:MAX_SUGGESTIONS]
        suggested += len(picked)
        hits += sum(1 for item in picked if item in household["truth"])

    return {
        "households": len(checked),
        "suggested": suggested,
        "hits": hits,
        "precision": hits / suggested if suggested else 0.0,
    }


def main():
    groups = load_groups(OUT / "history.csv")

    # real trips, once export_history.py has been run: trained together with the synthetic ones
    real = OUT / "real_history.csv"
    if real.exists():
        real_groups = load_groups(real)
        groups.update(real_groups)
        print(f"+ {len(real_groups)} real groups from {real.name}")

    fallback = fallback_median_interval(list(groups.values()))
    requests = build_requests(groups, fallback)

    print(f"{len(groups)} groups, {len(requests)} requests, fallback median interval {fallback:.2f} days")

    prob_lists, mean_auc = cross_validate(requests)
    chosen, table = choose_threshold(requests, prob_lists)

    frequency = measure(requests, [request["X"][:, 0] for request in requests], 0.5)
    due_ratio = measure(requests, [request["X"][:, 6] for request in requests], 0.8)

    matrix, labels = stack(requests)
    final = make_model()
    final.fit(matrix, labels)

    scaler = final.named_steps["scaler"]
    classifier = final.named_steps["clf"]

    model = {
        # JSON has no comments, so the warning is a field; the scorer reads only the fields it needs
        "_note": (
            "Generated by ml/train.py. Do not edit by hand. To change the model, change and re-run "
            "ml/train.py: it writes ml/out/model.json and src/services/suggestions.model.json together, "
            "and the parity test fails if the two copies differ."
        ),
        "version": VERSION,
        "trainedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "features": FEATURE_NAMES,
        "mean": [float(value) for value in scaler.mean_],
        "scale": [float(value) for value in scaler.scale_],
        "coef": [float(value) for value in classifier.coef_[0]],
        "intercept": float(classifier.intercept_[0]),
        "threshold": chosen["threshold"],
        "maxSuggestions": MAX_SUGGESTIONS,
        "fallbackMedianInterval": float(fallback),
        "minTrips": MIN_TRIPS,
        "metrics": {
            "precisionAtK": round(chosen["precisionAtK"], 4),
            "recallAtK": round(chosen["recallAtK"], 4),
            "rocAuc": round(mean_auc, 4),
            "coverage": round(chosen["coverage"], 4),
        },
    }

    model_text = json.dumps(model, indent=2)
    (OUT / "model.json").write_text(model_text, encoding="utf-8")
    # the copy the server loads: inside src/, so the server still starts when src/ is deployed alone
    SERVER_MODEL.write_text(model_text, encoding="utf-8")

    fixture = parity_fixture(groups, final, fallback, VERSION)
    (OUT / "parity_fixture.json").write_text(json.dumps(fixture, indent=2), encoding="utf-8")

    (OUT / "validation.json").write_text(json.dumps({
        "threshold": chosen["threshold"],
        "requests": [
            {
                "group": request["group"],
                "tripId": request["tripId"],
                "labels": request["y"].tolist(),
                "probabilities": [round(float(p), 6) for p in probs],
                "trip_freq": request["X"][:, 0].tolist(),
                "due_ratio": request["X"][:, 6].tolist(),
            }
            for request, probs in zip(requests, prob_lists)
        ],
    }), encoding="utf-8")

    print(f"\nlogistic regression, threshold {chosen['threshold']:.2f}, k {MAX_SUGGESTIONS}")
    print(f"  precision@k {chosen['precisionAtK']:.3f}  recall@k {chosen['recallAtK']:.3f}  "
          f"roc auc {mean_auc:.3f}  coverage {chosen['coverage']:.3f}")
    print(f"  frequency baseline  precision {frequency['precisionAtK']:.3f}  "
          f"coverage {frequency['coverage']:.3f}")
    print(f"  due_ratio baseline  precision {due_ratio['precisionAtK']:.3f}  "
          f"coverage {due_ratio['coverage']:.3f}")

    checked = check_criterion3(final, fallback)
    result = criterion3_measure(checked, chosen["threshold"])
    if result:
        print(f"  criterion 3, {result['households']} held-out households: {result['hits']}/{result['suggested']} "
              f"suggested items were on the next trip (precision {result['precision']:.3f})")

    top = sorted(zip(FEATURE_NAMES, model["coef"]), key=lambda pair: -abs(pair[1]))
    print("  coefficients: " + ", ".join(f"{name} {value:+.2f}" for name, value in top))


if __name__ == "__main__":
    main()
