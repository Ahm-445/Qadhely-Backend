"""The report numbers and figures, from out/model.json and out/validation.json.

Writes out/metrics.json and out/figures/:
  precision_recall.png   mean per-request precision against recall, chosen threshold marked
  calibration.png        when the model says 70%, does the item appear about 70% of the time?
  coefficients.png       what the model learned, per standardized feature

Run train.py first.
"""

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import roc_auc_score

from features import FEATURE_NAMES

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
FIGURES = OUT / "figures"


def load():
    model = json.loads((OUT / "model.json").read_text(encoding="utf-8"))
    validation = json.loads((OUT / "validation.json").read_text(encoding="utf-8"))
    return model, validation["requests"]


def measure(requests, key, threshold, k):
    precisions, recalls, covered = [], [], 0

    for request in requests:
        scores = np.asarray(request[key], dtype=float)
        labels = np.asarray(request["labels"], dtype=int)

        above = np.nonzero(scores >= threshold)[0]
        if above.size == 0:
            continue

        picked = above[np.argsort(-scores[above], kind="stable")][:k]
        hits = int(labels[picked].sum())

        covered += 1
        precisions.append(hits / picked.size)
        recalls.append(hits / max(1, int(labels.sum())))

    return {
        "precisionAtK": round(float(np.mean(precisions)), 4) if precisions else 0.0,
        "recallAtK": round(float(np.mean(recalls)), 4) if recalls else 0.0,
        "coverage": round(covered / len(requests), 4) if requests else 0.0,
    }


def curve(requests, key, thresholds, k):
    points = []

    for threshold in thresholds:
        row = measure(requests, key, threshold, k)
        points.append((row["recallAtK"], row["precisionAtK"], threshold, row["coverage"]))

    return points


def calibration(requests, bins=10):
    probs = np.concatenate([np.asarray(request["probabilities"], dtype=float) for request in requests])
    labels = np.concatenate([np.asarray(request["labels"], dtype=int) for request in requests])

    edges = np.linspace(0.0, 1.0, bins + 1)
    centres, observed, counts = [], [], []

    for lower, upper in zip(edges, edges[1:]):
        mask = (probs >= lower) & (probs < upper if upper < 1.0 else probs <= upper)
        if mask.sum() == 0:
            continue
        centres.append((lower + upper) / 2)
        observed.append(float(labels[mask].mean()))
        counts.append(int(mask.sum()))

    return centres, observed, counts


def main():
    FIGURES.mkdir(parents=True, exist_ok=True)
    model, requests = load()

    k = model["maxSuggestions"]
    threshold = model["threshold"]

    probs = np.concatenate([np.asarray(request["probabilities"], dtype=float) for request in requests])
    labels = np.concatenate([np.asarray(request["labels"], dtype=int) for request in requests])

    thresholds = [round(0.05 + 0.02 * step, 2) for step in range(48)]

    table = {
        "logisticRegression": {**measure(requests, "probabilities", threshold, k), "threshold": threshold},
        "frequencyBaseline": {**measure(requests, "trip_freq", 0.5, k), "threshold": 0.5},
        "dueRatioBaseline": {**measure(requests, "due_ratio", 0.8, k), "threshold": 0.8},
    }

    metrics = {
        "modelVersion": model["version"],
        "trainedAt": model["trainedAt"],
        "requests": len(requests),
        "rows": int(len(labels)),
        "positiveRate": round(float(labels.mean()), 4),
        "rocAuc": round(float(roc_auc_score(labels, probs)), 4),
        "maxSuggestions": k,
        "comparison": table,
        "coefficients": dict(zip(FEATURE_NAMES, [round(value, 4) for value in model["coef"]])),
    }

    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # precision-recall curve, the three methods on one axes
    fig, axes = plt.subplots(figsize=(6.4, 4.8))
    for key, label, style in [
        ("probabilities", "logistic regression", "-o"),
        ("trip_freq", "frequency only (trip_freq)", "--"),
        ("due_ratio", "hand-written rule (due_ratio)", ":"),
    ]:
        points = curve(requests, key, thresholds, k)
        axes.plot([p[0] for p in points], [p[1] for p in points], style, markersize=2, label=label)

    chosen = measure(requests, "probabilities", threshold, k)
    axes.scatter([chosen["recallAtK"]], [chosen["precisionAtK"]], s=90, zorder=5,
                 color="black", label=f"chosen threshold {threshold:.2f}")
    axes.axhline(0.8, color="grey", linewidth=0.8, linestyle="--")
    axes.set_xlabel("recall@k (mean per request)")
    axes.set_ylabel("precision@k (mean per request)")
    axes.set_title("Suggestions: precision against recall")
    axes.set_xlim(0, 1)
    axes.set_ylim(0, 1.02)
    axes.legend(loc="lower left", fontsize=8)
    axes.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(FIGURES / "precision_recall.png", dpi=140)
    plt.close(fig)

    # calibration
    centres, observed, counts = calibration(requests)
    fig, axes = plt.subplots(figsize=(5.2, 4.8))
    axes.plot([0, 1], [0, 1], color="grey", linestyle="--", linewidth=0.8, label="perfectly calibrated")
    axes.plot(centres, observed, "-o", label="logistic regression")
    axes.set_xlabel("predicted probability")
    axes.set_ylabel("share of items actually on the trip")
    axes.set_title("Calibration (validation folds)")
    axes.set_xlim(0, 1)
    axes.set_ylim(0, 1)
    axes.legend(fontsize=8)
    axes.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(FIGURES / "calibration.png", dpi=140)
    plt.close(fig)

    # coefficients
    order = np.argsort(model["coef"])
    fig, axes = plt.subplots(figsize=(6.4, 4.4))
    axes.barh([FEATURE_NAMES[i] for i in order], [model["coef"][i] for i in order],
              color=["#b0413e" if model["coef"][i] < 0 else "#2f6f4e" for i in order])
    axes.axvline(0, color="black", linewidth=0.8)
    axes.set_xlabel("weight on the standardized feature")
    axes.set_title("What the model learned")
    axes.grid(alpha=0.3, axis="x")
    fig.tight_layout()
    fig.savefig(FIGURES / "coefficients.png", dpi=140)
    plt.close(fig)

    print(f"{metrics['requests']} requests, {metrics['rows']} rows, ROC AUC {metrics['rocAuc']}")
    for name, row in table.items():
        print(f"  {name:20s} precision@k {row['precisionAtK']:.3f}  recall@k {row['recallAtK']:.3f}  "
              f"coverage {row['coverage']:.3f}")
    print(f"figures -> {FIGURES}")


if __name__ == "__main__":
    main()
