# Experiment Report: Enriched Features for Tyre Degradation (Permanent Version)

**Date:** 2026-09-03.
**Prerequisite:** this depends on the `round_number` fix in
`notes/round_number_bugfix_report.md` — weather can't be pulled per race from the FastF1
cache without a trustworthy session identifier. Also depends on the discussion in
`notes/normalization_experiment_report.md`, which ruled out feature scaling as the reason the
tyre signal was hard to see and pointed back at features/target instead.

## What this is

`notes/degradation_experiment_report.md` (July 2026) first tried enriched features against the
pace-delta target and found real, physically sensible degradation curves — but that work ran
from scratch scripts that were never saved into the repo ("session-temporary" per that
report's own reproducibility section), so it couldn't be rerun, checked, or built on. This
makes that approach permanent: `scripts/enrich_data.py` builds the enriched dataset from
scratch, reproducibly, from what's already on disk (the FastF1 cache — no new API pulls), and
`scripts/model_enriched_degradation.py` runs the same model battery against it.

## Feature engineering: fuel load, degradation, and time-based effects, separated out

The core problem this targets: **fuel burn and tyre degradation both change lap time over the
course of a stint, in opposite directions, at the same time** — a car gets faster as fuel
burns and slower as tyres wear, so naively regressing `LapTime` on `TyreLife` mixes both
effects into one confounded number (this is exactly the tiny/backwards TyreLife coefficient
the notebook found in section 4). The features below exist specifically to pull those apart:

- **Fuel load, three ways**: `LapNumber` (crude, race-wide), `laps_remaining` (race-length-aware
  — a lap 40 of 70 and a lap 40 of 50 mean different remaining fuel loads; `LapNumber` alone
  can't tell them apart, `laps_remaining` can), and `stint_start_tyre_age` + `lap_in_stint`
  together (separates "how worn was this tyre when the stint began" from "how long has it been
  on since" — a driver can start a stint on a used set).
- **Tyre degradation itself**: `TyreLife` (laps on the current set) is now sitting alongside
  the fuel features above instead of only a race-quarter bucket, so a model has what it needs
  to attribute lap-time change to wear specifically rather than absorbing it all into one
  number.
- **Conditions, for real**: `TrackTemp`, `AirTemp`, `Humidity`, `Rainfall`, `WindSpeed`, merged
  by session time from the FastF1 cache — genuine measurements, not the `WeatherBucket`
  race-quarter proxy the notebook uses today (which is a progress-through-the-race signal
  wearing a weather-shaped name).
- **Traffic**: `gap_ahead` (seconds to whoever crossed the line just ahead on the same lap
  number) and `clean_air` (that gap > 2s) — a car stuck behind another loses time for reasons
  that have nothing to do with its own tyres.
- **`team_pace` replacing 35 `Driver` dummies**: each `(year, Team)`'s average deficit to the
  fastest team that weekend, computed from **train races only**. This absorbs car+driver
  competitiveness in one continuous number instead of 35 sparse identity columns, which
  matters because those 35 columns were exactly what buried the tyre signal in the original
  Ridge baseline.
- **The pace-delta target**, unchanged from the notebook's section 6: `LapTime` minus that
  driver's own best green-flag lap that race, so the circuit/car baseline is subtracted out of
  the *target* rather than left for the model to spend its capacity re-deriving from features.

## Results

| Model | Dev R² | Dev MAE (s) |
|---|---|---|
| Ridge, enriched features | 0.2921 | 1.194 |
| HistGradientBoosting, enriched features | 0.3279 | 1.055 |
| HGB + monotonic TyreLife constraint | **0.3531** | **1.036** |

For reference: the notebook's absolute-`LapTime` Ridge baseline reaches R²=0.9103, but — as
established repeatedly in this project now — that number is mostly a circuit-identity lookup.
These R² values are on a genuinely different, harder target (within-race pace variation), so
they aren't comparable to that 0.91 in absolute terms; they're the actual signal this project
has been trying to isolate since the notebook's section 6.

**How this compares to the July scratch-script version:** Ridge landed at 0.2921 here vs. 0.293
there — close enough to call reproduced. HGB landed lower here (0.3279 vs. 0.380 there), and
the monotonic constraint *helped* here (0.3531 vs. unconstrained 0.3279) where it *cost*
accuracy in July (0.334 vs. 0.380 unconstrained). Both differences are plausible, honest
consequences of not having the original code to check against — this reproduction followed the
July report's written description faithfully, but small pipeline choices it doesn't document
in that level of detail (the exact `gap_ahead` NaN handling, exact weather-merge join
direction, whether `location` was included alongside `team_pace`) could easily account for a
gap this size on a model this sensitive to feature detail. **This version is the one to trust
going forward, precisely because it's reproducible and this report shows its exact numbers**;
treat the July figures as a directionally-confirming prior result, not a target this had to
match exactly.

### TyreLife signal

- Ridge coefficient: **+0.0071 s/lap** — same sign and same order of magnitude as the
  notebook's fuel-proxied Ridge (+0.0067), not dramatically larger. The linear model still
  isn't where the enriched features pay off.
- HGB permutation importance (on held-out dev data, not training-set gain): TyreLife ranks
  **11th of 48** features (importance 0.035) — a real improvement over the notebook's
  absolute-target forest, where it barely registered, though not as dramatic a jump as July's
  reported rank 12-of-47 at similar importance. `Compound` (wet vs. dry, by a wide margin),
  race-progress features (`LapNumber`, `laps_remaining`), and two individual circuits
  (`location_Monaco`, `location_Silverstone` — likely picked up as high-variance,
  hard-to-model tracks) dominate instead.

### Degradation curves per compound (HGB, unconstrained; median predicted delta at each TyreLife, other features held at each real lap's own value)

| Compound | Lap 1 | Lap 10 | Lap 20 | Lap 30 | Support (dev laps) |
|---|---|---|---|---|---|
| SOFT | 1.40s | 2.02s | 2.24s | 2.28s | 1,781 |
| MEDIUM | 1.67s | 2.29s | 2.50s | 2.59s | 8,329 |
| HARD | 1.12s | 1.44s | 1.69s | 1.75s | 10,551 |
| INTERMEDIATE | 9.46s | 9.94s | 8.83s | 8.94s (lap 25+) | 917 |

The three dry compounds are physically sensible and consistent with the July findings: monotone
increasing, flattening out by ~lap 20 (real degradation curves plateau rather than climbing
forever), SOFT and MEDIUM degrading faster and to a higher absolute penalty than HARD, which is
exactly the tyre-compound ordering a strategist would expect.

**INTERMEDIATE does not fit that pattern** — it climbs to lap 10, then *drops* sharply between
lap 10 and lap 15 (9.94s → 8.83s) rather than flattening. This isn't a small-sample artifact
(917 dev laps is reasonable support, more than SOFT), but it likely still isn't a real
degradation signal: wet-tyre stints only happen in the handful of actual wet races in the
dataset, and this curve sweeps `TyreLife` while holding every *other* feature (including
`Rainfall`, `AirTemp`) at each real lap's own value — so it's partly reflecting which specific
wet races happen to have high-TyreLife intermediate stints (e.g., a drying track easing off
rain mid-race) rather than a controlled "same conditions, older tyre" comparison. Reported
honestly rather than smoothed over or omitted; treat the intermediate curve as unreliable and
the three dry-compound curves as the trustworthy result of this experiment.

## Problems encountered, and fixes

1. **The blocking dependency**: this experiment could not start until `round_number` was
   trustworthy (see the bugfix report) — the very first thing this pipeline does is call
   `fastf1.get_session(year, round_number, 'R')` per race, and 82%/89% of train/dev rows had a
   corrupted value there. Caught before it silently produced wrong weather joins, not after.
2. **`gap_ahead` is undefined for the leading car on a lap** (~5.8% of rows) — no error, just a
   real absence of a "car ahead." Filled with a large sentinel (200s) rather than dropped or
   imputed to a plausible small gap, so "alone on track" reads to the model as a real,
   qualitatively different state rather than an average traffic scenario.
3. **`team_pace` computed from train only, applied to dev by lookup** — the same
   fit-on-train/apply-to-dev discipline every other engineered feature in this project already
   follows (scaler fits, `train_columns` reindexing). Zero dev `(year, Team)` combinations fell
   outside train's coverage in practice, but the fallback (project-wide mean team_pace) exists
   in case a future data pull ever introduces one.
4. **Rate-limited API warnings during the FastF1 session loads** (`429 Client Error` from
   `api.jolpi.ca`, an Ergast results mirror FastF1 queries internally) — non-fatal;
   `requests_cache` fell back to a cached response each time and every one of the 89 races
   loaded successfully with 100% weather coverage on both train and dev. Left as printed
   warnings rather than suppressed, since a future environment without a warm cache for that
   endpoint could have this actually fail rather than degrade gracefully.

## Recommendation / next steps

The target change (absolute → delta) remains the single highest-leverage decision in this
whole project, confirmed again here. Enriched features gave a real but modest lift over the
notebook's plain fuel-proxy features on the delta target, and the monotonic constraint is worth
keeping by default now (it *helped* here, unlike in July) — but re-check that if the feature
set changes again, since which way that trade cuts depends on whether the unconstrained model
finds a spurious dip to protect.

What's still not done, unchanged from the notebook's own "Open work" and the July report's
conclusions:

- **Stint-level / pit-survivorship modeling.** Every curve here still measures whichever stints
  actually happened to run to a given TyreLife — bad stints get pitted before their worst laps
  occur, which likely explains part of why the recovered degradation slopes (a fraction of a
  second per lap) sit well below textbook tyre-degradation magnitudes.
- **Per-compound models fit separately**, rather than one global model with `Compound` as a
  dummy — the curves above show real different shapes per compound; a shared model has to
  compromise across all of them.
- **The INTERMEDIATE curve needs wet-race-specific handling** (holding `Rainfall`/track-drying
  state fixed properly, or modeling wet stints entirely separately) before it's trustworthy for
  anything beyond "intermediates are ~7x slower than dry tyres," which was already obvious.
