# Report: Data Cleaning + Per-Compound Tyre Degradation Models

**Date:** 2026-09-03.
**Request:** "clean the data, improvise it and structure it well, next set up tyre degradation
seperately for soft hards and mediums and all others."

This covers two sequential pieces of work: a new explicit data-cleaning stage
(`scripts/clean_data.py`), and per-compound degradation models built on top of it
(`scripts/model_per_compound_degradation.py`), replacing the single shared model in
`notes/enriched_degradation_report.md` with one model per tyre compound.

## Part 1: Cleaning the data

New pipeline stage, inserted between the split and the feature enrichment: `data_pull.py` →
`split.py` → **`clean_data.py`** → `enrich_data.py` → `model_*.py`. Kept as its own script
rather than folded into `enrich_data.py` so what got removed, and why, is auditable on its own.

Four fixes, all verified against the actual data before trusting them:

1. **Dropped 4 dead columns** (`PitOutTime`, `PitInTime`, `IsAccurate`, `FastF1Generated`) —
   confirmed 100%-null or 100%-constant across every row, a consequence of `data_pull.py`'s
   existing in/out-lap filter rather than a new finding, but carried no information and were
   removed.
2. **Removed laps FastF1 marks `Deleted`** (track-limits violations): 736 train laps (1.17%),
   303 dev laps (1.37%). A deleted lap's `LapTime` is frequently unrealistically fast —
   that's exactly why it got deleted — so left in, these laps contaminate degradation curves
   with speed that has nothing to do with tyre wear. Confirmed `IsAccurate` does **not** already
   exclude these (the two flags measure different things).
3. **Dropped rows missing `Compound` or `TyreLife`**: 191 train rows, 675 dev rows. Every model
   in this project needs both, per-compound modeling especially. Flagged rather than silently
   absorbed: dev's Compound-missing rate (2.7%) is much higher than train's (0.1%) — a real,
   pre-existing gap between the splits, not introduced by this cleaning.
4. **Fixed `Sector1Time`/`Sector2Time`/`Sector3Time`**, previously stored as timedelta strings
   while `LapTime` was already numeric seconds — converted to `float64` seconds for consistency.

**Result:** train 62,748 → 61,821 rows (35 → 29 columns), dev 22,183 → 21,205 rows (35 → 29
columns). Written to `data/train_clean.csv` / `data/dev_clean.csv`. `enrich_data.py` was
updated to read these instead of the raw `train.csv`/`dev.csv`, and re-run end-to-end
successfully: 100% weather coverage on both train and dev, 0 NaN `team_pace` after the
train-only-fit/dev-lookup fallback, `data/train_enriched.csv` (61,819 rows after dropping rows
with no delta target) / `data/dev_enriched.csv` (21,205 rows) rebuilt from the cleaned base.

## Part 2: Per-compound degradation models

### Why split by compound

`notes/enriched_degradation_report.md`'s single shared model (all compounds pooled,
`Compound` as a dummy variable) already showed real, differently-shaped degradation curves per
compound — SOFT and MEDIUM degrading faster than HARD, INTERMEDIATE far slower and non-monotone.
A shared model has to compromise across those shapes with one set of tree splits; fitting a
separate model per compound lets each one fit its own shape without that compromise, and
removes `Compound` itself from the feature list (fixed within each subset, so it carries no
information there).

### First attempt: same hyperparameters as the shared model — overfit badly

Reusing the shared model's HGB settings (`max_iter=500, min_samples_leaf=50`, no depth cap) on
each compound's much smaller subset produced **negative dev R² for SOFT (-0.20) and
INTERMEDIATE (-1.01)** — worse than just predicting the training-set mean for every dev row.
This is overfitting, not a real degradation signal: splitting by compound cuts each model's
training set to a fraction of the shared one (SOFT: 8,563 rows vs. the shared model's full
61,819; INTERMEDIATE: 4,356), with far fewer distinct races and locations to average noise
over, so the shared model's hyperparameters — tuned implicitly for the full dataset's size —
let each tree memorize per-compound quirks that don't generalize.

**Fix:** regularized much harder — `max_iter=100, min_samples_leaf=200, max_depth=3,
l2_regularization=5.0` (vs. `max_iter=500, min_samples_leaf=50`, unbounded depth, no L2 in the
shared model). Verified with a small sweep before picking these values (see the model script's
comments) — this took SOFT from R²=-0.34 (worst setting tried) to +0.09, and confirmed
INTERMEDIATE's negative R² is **not** overfitting-fixable (every regularization strength tried,
including dropping `location` dummies entirely, kept INTERMEDIATE's dev R² negative — see
below).

### Results

| Compound | Train laps | Dev laps | Dev R² | Dev MAE (s) | Ridge TyreLife coef (s/lap) |
|---|---|---|---|---|---|
| HARD | 26,788 | 10,393 | **0.2394** | 0.830 | +0.0234 |
| MEDIUM | 21,840 | 8,143 | 0.1407 | 0.981 | +0.0022 |
| SOFT | 8,563 | 1,756 | 0.0901 | 0.863 | -0.0129 |
| INTERMEDIATE | 4,356 | 913 | **-0.6365** | 4.007 | -0.0394 |
| WET | 272 | **0** | n/a (see below) | n/a | n/a |

For reference, the shared model (one HGB, all compounds pooled) scored dev R²=0.3531,
MAE=1.036s — **better than every per-compound split**, dry compounds included. See "Honest
comparison to the shared model" below.

### Degradation curves (median predicted delta, holding every other feature at each dev lap's own value)

| Compound | Lap 1 | Lap 5 | Lap 10 | Lap 15 | Lap 20 | Lap 30 |
|---|---|---|---|---|---|---|
| SOFT | 1.93s | 1.93s | 1.97s | 1.97s | 1.97s | 1.97s |
| MEDIUM | 1.97s | 2.10s | 2.26s | 2.28s | 2.28s | 2.28s |
| HARD | 1.04s | 1.20s | 1.45s | 1.60s | 1.65s | 1.72s |
| INTERMEDIATE | 10.31s | 10.44s | 10.44s | 10.44s | 10.44s | 10.44s |
| WET (train-only) | 19.46s | 19.46s | 19.60s | 19.77s | 19.77s | 19.77s |

The three dry compounds are still directionally sensible — monotone rising (the constraint
enforces this) and flattening as they approach the shared model's curve shapes — but flatten
out earlier and more sharply than the shared model's curves did, a direct consequence of the
heavier regularization needed to keep these models from overfitting (max_depth=3 limits how much
curve shape the model can express at all).

### WET: no dev support, reported as a train-only diagnostic, not a validated model

Only 272 WET laps exist in train and **zero in dev** — confirmed, not assumed (`dev_df[dev_df
["Compound"]=="WET"]` is empty). No held-out metric can exist for a compound with zero held-out
rows, so `model_per_compound_degradation.py` explicitly branches on this: it fits a model and
reports its **training-set** R²/MAE (0.8184 / 1.567s) labeled as an unvalidated diagnostic, and
prints the degradation curve for inspection, but does not report a dev R² for WET at all — a
blank cell in the results table, not a fabricated number. Whether this is usable for anything
beyond "WET is roughly 5-10x slower than dry tyres" is a judgment call for whoever consumes
this; it is not something a dev-set split can settle when one doesn't exist.

### Why INTERMEDIATE stays broken even after fixing overfitting

Diagnosed directly rather than assumed: INTERMEDIATE's train set spans 10 locations, but dev
has only **2** (Marina Bay, Melbourne) — both wet races, but not necessarily comparable ones
(dev's `LapTimeDelta` std is 3.80s vs. train's 6.05s — meaningfully different variance, i.e. a
different mix of wet-race severity). Predicting the flat **train mean** for every dev row
already scores R²=-0.077 on this compound, before any model is even fit — so a negative model
R² here reflects a real train/dev distribution mismatch specific to how rarely intermediates
are used (only in the handful of actual wet races in the whole dataset), not a fixable modeling
bug. This confirms and sharpens `enriched_degradation_report.md`'s existing caveat that
INTERMEDIATE's curve reflects "which specific wet races happen to look a certain way" rather
than a controlled degradation signal — isolating INTERMEDIATE into its own model made this
worse, not better, because it removed the dry-compound majority that was previously stabilizing
the shared model's fit.

### Honest comparison to the shared model — per-compound splitting is a net accuracy cost here

Every per-compound dev R² (0.24, 0.14, 0.09, -0.64) is worse than the shared model's pooled
0.3531, dry compounds included. The reason: the shared model gets to borrow statistical
strength across compounds — a HARD lap's `team_pace`, weather, and traffic patterns carry
information useful for predicting a MEDIUM lap's delta too, since those features aren't
compound-specific. Splitting by compound throws that shared signal away in exchange for
letting each compound's `TyreLife` relationship take its own shape unconstrained by the other
compounds. That trade only pays off if the per-compound curve shapes are what's actually
wanted (e.g. for strategy decisions: "how much does *this* compound degrade") rather than
"predict this lap's delta as accurately as possible" — worth keeping in mind before treating
this as a strict upgrade over the shared model rather than a different tool for a different
question.

## Problems encountered, and fixes

1. **First-pass overfitting** (SOFT/INTERMEDIATE dev R² deeply negative) from reusing the
   shared model's hyperparameters unchanged on much smaller per-compound subsets — fixed with a
   small hyperparameter sweep (`max_depth`, `min_samples_leaf`, `l2_regularization`) run before
   committing to final numbers, not guessed at.
2. **WET has zero dev rows** — handled by an explicit code branch that reports a labeled
   train-only diagnostic instead of a fabricated or omitted dev metric.
3. **INTERMEDIATE's negative dev R² survives every regularization strength tried** — diagnosed
   down to a real train/dev distribution mismatch (different wet-race locations and severity),
   confirmed via a naive train-mean baseline also scoring negative on this compound, rather than
   left as an unexplained bad number.

## What's still open

- Per-compound splitting costs accuracy relative to the shared model on every compound here;
  a hybrid (one model, but with compound-specific `TyreLife` interaction terms or per-compound
  monotonic slopes) might recover the shared model's cross-compound signal-sharing while still
  giving compound-specific curve shapes — not attempted here.
- INTERMEDIATE and WET both remain fundamentally support-starved (4,356 and 272 train laps
  respectively, out of ~62k) — no amount of modeling technique fixes too few wet races in the
  underlying data.
- Stint-level/pit-survivorship modeling, flagged as open in both prior reports, is still open.
