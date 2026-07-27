# Experiment Report: Enriched Features + Pace-Delta Target for Tyre Degradation

**Date:** 2026-07-18.
**Status of project files: unchanged.** The entire experiment ran from scratch scripts against
copies of the data; `data_pull.py`, `split.py`, `Tyre_degradation.ipynb`, and everything in
`data/` are exactly as they were. This report is the only new file.

## What was tested

The cleaned notebook's conclusion was that lap-time models were ~90% circuit-baseline lookup
and the tyre signal was tiny. This experiment tested the proposed remedies, using only data
already on disk (the FastF1 cache — no new API pulls):

1. **Weather, finally merged.** All 114 races' `weather_data` extracted from the local cache
   (18,432 readings, zero failures) and `merge_asof`-joined to each lap by session time:
   `TrackTemp`, `AirTemp`, `Humidity`, `Rainfall`, `WindSpeed`. 100% lap coverage.
2. **Traffic:** per-lap gap to the car that completed the same lap just ahead (from the `Time`
   column already in the data), plus a `clean_air` flag (gap > 2 s).
3. **Stint & fuel context:** stint number, lap-within-stint, tyre age at stint start,
   `FreshTyre`, and `laps_remaining` as a race-length-aware fuel proxy.
4. **`team_pace` replacing 35 Driver dummies:** each (year, team)'s average deficit of its
   best race lap vs the weekend's best, computed **from training races only** (no dev leakage).
5. **Pace-delta target:** `LapTime − driver's best green-flag lap that race`, so the circuit
   baseline is subtracted out of the target instead of being the main thing predicted.
6. **Models:** `HistGradientBoostingRegressor` (500 iters, `min_samples_leaf=50`), with and
   without a monotonic-increasing constraint on TyreLife; Ridge as linear reference.

Same train/dev races as the notebook (62,748 / 22,183 laps, keyed off the existing split
files), so every number is comparable.

## Results

### Absolute lap-time target (comparable to the notebook)

| Model | Dev R² | Dev MSE |
|---|---|---|
| Ridge + fuel proxy (notebook baseline) | 0.9103 | 12.29 |
| Random Forest (notebook) | 0.8612 | 19.03 |
| HGB, original features | 0.8606 | 19.23 |
| **HGB, enriched features** | **0.7748** | **31.06** |
| HGB delta model, reconstructed to absolute¹ | 0.9732 | 3.70 |

¹ delta prediction + the driver's actual best lap that race — see caveat below.

**Honest negative result:** on the *absolute* target, the enriched features made things
worse, and tree models in general lose to plain Ridge. Permutation importance shows why: the
enriched absolute model latched onto `race_total_laps` as a circuit-identity proxy
(importance 1.14, ~16× the next feature) — absolute lap time is so dominated by
circuit baseline that any feature correlated with "which track is this" gets abused for it,
and the tyre features stay noise (TyreLife importance ≈ 0, rank 44 of 47).

### Pace-delta target (the actual degradation question)

| Model | Dev R² (delta) | Dev MAE (s) |
|---|---|---|
| Ridge, enriched features | 0.293 | 1.19 |
| **HGB** | **0.380** | **0.99** |
| HGB + monotonic TyreLife | 0.334 | 1.02 |

R² ≈ 0.38 looks small next to 0.91, but it's explaining *within-race pace variation* — the
part of the problem that was previously contributing almost nothing. The same information
reconstructed to absolute lap time gives MSE 3.70 vs the baseline's 12.29 (**~3× lower**),
with the caveat that the reconstruction adds back the driver's actual best lap from the dev
race — legitimate for strategy analysis mid-race (where current pace is known), but not a
pre-race forecast.

### Did the tyre get the "higher preference" asked for?

| Signal | Absolute-target models | Delta-target models |
|---|---|---|
| TyreLife permutation importance | ≈ 0.000 (rank 44) | 0.015 (rank 12) |
| Ridge TyreLife coefficient | +0.0067 s/lap (notebook 4c) | **+0.0264 s/lap** |

Yes, decisively. The linear tyre-age slope quadrupled once the target stopped being dominated
by circuit identity, and the boosted model's implied degradation curves (predicting the delta
while sweeping TyreLife 1→30 on real dev laps, fuel held fixed) are physically sensible for
the first time in this project:

- **SOFT:** 1.39 s → 2.20 s over laps 5→30 (≈ 0.032 s/lap), with a visible warm-up dip
  (lap 1 slower than lap 5) — which is exactly why the monotonic constraint costs a little
  accuracy (R² 0.334 vs 0.380): real curves aren't monotone at stint start.
- **MEDIUM:** 1.58 → 2.54 (≈ 0.038 s/lap). **HARD:** 1.06 → 1.91, lowest overall level.
- The **empirical** binned curves flatten or dip at high tyre age while the model curves keep
  rising — the survivorship effect in the raw data (only healthy stints reach lap 25+; bad
  ones pit) that the model partly corrects for by conditioning on fuel and stint context.

## Conclusions

1. **The target change matters more than any feature or model change.** Every attempt to
   improve *absolute* lap-time prediction with better features backfired (circuit proxies get
   hijacked); the same features on the *delta* target produced the first credible degradation
   curves.
2. The remaining gap between the recovered slope (~0.03 s/lap) and textbook degradation is
   consistent with pit-stop survivorship — fixable with stint-level modeling, not more
   features.
3. The monotonic constraint is a trade: it guarantees physical shape but erases the real
   warm-up dip. A better encoding would constrain only beyond ~lap 3 of a stint.
4. Not tested (would need new API pulls): FP2 long runs and sprint races (the richest clean
   degradation data), 2018–2020 seasons, and qualifying-based team pace.

## Reproducibility

Scripts (scratchpad, session-temporary — copy into the repo if worth keeping):
`extract_weather.py` (cache → weather CSV), `enrich_data.py` (features + delta target),
`run_experiment.py` (models + importances + curves). Nothing in the project was modified;
the enriched dataset lives outside the repo and can be regenerated in ~2 minutes from the
cache and raw CSVs.
