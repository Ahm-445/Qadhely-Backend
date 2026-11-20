# AI suggestions — the offline model

The suggestions tab answers one question: **will this item be on the group's next list?**

It is a binary classifier. One example is one (group, catalog item, target trip) triple, and the label is
1 when the item was on that trip. The model is a logistic regression trained here, in Python, and exported
as `out/model.json` — nine weights, a scaler and a threshold. The Node server reads that file and scores
with it, so **the server never runs Python**.

`../src/services/suggestions.js` is the other half of the same specification (plan section 5). Both sides
compute the nine features; `../tests/us23.suggestions.parity.test.js` checks that they agree to 1e-6.

## Setup (Windows)

`python` on PATH is the Microsoft Store stub on this machine, so use the launcher:

```powershell
cd Qadhely_Backend\ml
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Train

```powershell
py -3 generate_data.py     # synthetic households -> out/history.csv, out/criterion3_fixture.json
py -3 train.py             # -> out/model.json, out/parity_fixture.json, out/validation.json
py -3 evaluate.py          # -> out/metrics.json, out/figures/
```

`train.py` uses `out/real_history.csv` as well when it exists (see below).

Commit `out/model.json`, `out/parity_fixture.json`, `out/criterion3_fixture.json` and `out/metrics.json`:
the Node service and the tests read them. `out/figures/`, the CSVs and the virtualenv are ignored.

## Retraining on real trips

```powershell
py -3 export_history.py --uri <mongo uri> --db qadhely
py -3 train.py
```

Then raise `VERSION` in `train.py`, retrain, commit the new model files and restart the server. The API
returns the version as `modelVersion`, so a suggestion can be traced to the model that produced it.

## Files

| file | what it does |
| --- | --- |
| `features.py` | the nine features, the single definition both sides implement |
| `generate_data.py` | synthetic households from the real catalog ids, fixed seed |
| `export_history.py` | real `ItemHistory` trip rows from MongoDB, as a CSV |
| `train.py` | cross-validation, threshold choice, `model.json`, the parity fixture |
| `evaluate.py` | the comparison table and the report figures |

## Results (model version 1, synthetic data)

| method | precision@k | recall@k | coverage |
| --- | --- | --- | --- |
| logistic regression, threshold 0.83 | 0.850 | 0.521 | 0.929 |
| frequency only, `trip_freq >= 0.5` | 0.673 | 0.671 | 0.996 |
| hand-written rule, `due_ratio >= 0.8` | 0.314 | 0.453 | 0.998 |

ROC AUC 0.887 on 5,237 held-out requests (79,520 candidate rows), split by group with `GroupKFold(5)`.

The frequency baseline is deliberately generous: it suggests an item merely for having been bought before.
The model beats it by 17.7 points of precision at the same k.

### A note on the coefficients

`due_ratio` carries a small weight (+0.24), not the largest positive one, although the plan expected it to.
That is not a feature bug: `days_since_last` (+2.55), `median_interval` (+0.09) and `trips_since_last`
(-2.81) are collinear with it — they measure the same elapsed time — so the linear model splits one effect
across three weights with compensating signs. Read as a group they say what `due_ratio` says alone: an item
bought regularly and long overdue is likely. The per-feature AUCs in `diagnose.py` show the same thing:
`due_ratio` alone separates positives from negatives at 0.51 because items bought only once inherit the
fallback interval and look permanently overdue; `trip_freq` alone reaches 0.84. The model needs both.

If a future retrain should be easier to explain, the fix is a `staple_and_due` interaction feature, not a
change to how `due_ratio` is computed.
