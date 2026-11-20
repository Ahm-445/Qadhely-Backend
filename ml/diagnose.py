import statistics

import numpy as np
from sklearn.metrics import roc_auc_score

import train
from features import FEATURE_NAMES, fallback_median_interval

groups = train.load_groups(train.OUT / "history.csv")
fallback = fallback_median_interval(list(groups.values()))
requests = train.build_requests(groups, fallback)
X, y = train.stack(requests)

print("rows", len(y), "positives", int(y.sum()), "rate", round(float(y.mean()), 3))

for index, name in enumerate(FEATURE_NAMES):
    print(f"{name:20s} auc {roc_auc_score(y, X[:, index]):.3f}  mean {X[:, index].mean():8.2f}")

print("candidates/request", round(statistics.mean(len(r["y"]) for r in requests), 1))
print("positives/request", round(statistics.mean(float(r["y"].sum()) for r in requests), 1))
print("due_ratio  positives", round(float(X[y == 1][:, 6].mean()), 2), " negatives", round(float(X[y == 0][:, 6].mean()), 2))
print("trip_freq  positives", round(float(X[y == 1][:, 0].mean()), 2), " negatives", round(float(X[y == 0][:, 0].mean()), 2))
