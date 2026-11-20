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
py -3 generate_data.py     # synthetic households -> out/history.csv, out/criterion3_fixture.json,
                           #                         out/criterion3_households.json
py -3 train.py             # -> out/model.json, ../src/services/suggestions.model.json,
                           #    out/parity_fixture.json, out/validation.json
py -3 evaluate.py          # -> out/metrics.json, out/figures/
```

`train.py` uses `out/real_history.csv` as well when it exists (see below).

`train.py` writes the model twice. `out/model.json` is the original; `../src/services/suggestions.model.json`
is the identical copy the server loads, kept inside `src/` so the server still starts when `src/` is
deployed on its own. The parity test fails if the two copies differ.

Commit `out/model.json`, `../src/services/suggestions.model.json`, `out/parity_fixture.json`,
`out/criterion3_fixture.json`, `out/criterion3_households.json` and `out/metrics.json`: the Node service
and the tests read them. `out/figures/`, the CSVs, `out/validation.json` and the virtualenv are ignored.

## Retraining on real trips

```powershell
py -3 export_history.py --uri <mongo uri> --db qadhely
py -3 train.py
```

Then raise `VERSION` in `train.py`, retrain, re-run `evaluate.py`, commit the new model files and restart
the server. The API
returns the version as `modelVersion`, so a suggestion can be traced to the model that produced it.

## Files

| file | what it does |
| --- | --- |
| `features.py` | the nine features, the single definition both sides implement |
| `generate_data.py` | synthetic households from the real catalog ids, fixed seed |
| `export_history.py` | real `ItemHistory` trip rows from MongoDB, as a CSV |
| `train.py` | cross-validation, threshold choice, `model.json`, the parity fixture |
| `evaluate.py` | the comparison table and the report figures |
| `diagnose.py` | how well each feature separates bought from not bought on its own (per-feature ROC AUC); a check, not part of the pipeline |

## Results (model version 1, synthetic data)

| method | precision@k | recall@k | coverage |
| --- | --- | --- | --- |
| logistic regression, threshold 0.83 | 0.850 | 0.521 | 0.929 |
| frequency only, `trip_freq >= 0.5` | 0.673 | 0.671 | 0.996 |
| hand-written rule, `due_ratio >= 0.8` | 0.314 | 0.453 | 0.998 |

ROC AUC 0.887 on 5,237 held-out requests (79,520 candidate rows), split by group with `GroupKFold(5)`.

The frequency baseline is deliberately generous: it suggests an item merely for having been bought before.
The model beats it by 17.7 points of precision at the same k.

Criterion 3 on the ten held-out households (`out/criterion3_households.json`): 39 of the 45 suggested
items were on the next trip, a pooled precision of 0.867. The test pools the households because a single
household with eight suggestions drops below 80% on its second miss.

### A note on the coefficients

Three things in the weights look odd at first and are explained below.

**`due_ratio` carries a small weight (+0.24)**, not the largest positive one, although the plan expected
it to. `days_since_last` (+2.55), `median_interval` (+0.09) and `trips_since_last` (-2.81) measure much of
the same elapsed time, so the linear model splits that effect across several weights with compensating
signs. The per-feature AUCs in `diagnose.py` add to this: `due_ratio` alone separates positives from
negatives at only 0.51, because items bought only once inherit the fallback interval and look permanently
overdue; `trip_freq` alone reaches 0.84. The model needs both.

**`in_last_trip` (-1.12) and `recent_freq` (-0.54) are negative.** This is a real effect, not an artefact:
once `trip_freq` says how often an item is bought, having just bought it means the household has just
restocked it and is less likely to need it on the very next list.

**Dropping the overlapping features does not help.** Measured on the same `GroupKFold` folds, choosing the
threshold the same way:

| features | ROC AUC | precision@k | recall@k | coverage |
| --- | --- | --- | --- | --- |
| all nine (shipped) | 0.887 | 0.850 | 0.521 | 0.929 |
| without `days_since_last`, `trips_since_last` | 0.882 | 0.851 | 0.481 | 0.898 |
| also without `median_interval` | 0.882 | 0.851 | 0.479 | 0.895 |
| also without `recent_freq`, `in_last_trip` | 0.847 | 0.851 | 0.295 | 0.662 |

Every variant reaches the same precision, but each one finds fewer of the items the household buys and
gives fewer households any suggestion, and the negative weights of `in_last_trip` and `recent_freq` stay
negative when they are kept. So the model keeps all nine features.
