# F1 Tyre Degradation

Modeling Formula 1 race lap times from 2021–2025 [FastF1](https://docs.fastf1.dev/) data to
recover the tyre-degradation signal — how much lap time a car loses per lap of tyre age — and
an honest record of how hard that turns out to be.

The headline finding so far: models that predict **absolute lap time** reach dev R² ≈ 0.91,
but ablations show almost all of it comes from knowing *which circuit* (and who is driving) —
the model is a circuit-baseline lookup, not a degradation model. The tyre signal only becomes
readable after proxying fuel load and, more decisively, after switching the target to each
lap's **pace delta** (gap to the driver's best green-flag lap of that race), which subtracts
the circuit baseline out of the target instead of letting the model spend all its capacity
predicting it.

## Repository layout

```
scripts/
  data_pull.py                       # pull every 2021–2025 race from FastF1 into per-circuit CSVs
  split.py                           # dedup + stack the CSVs, split train/dev/test by whole races,
                                      #   re-derive round_number from the FastF1 schedule
  clean_data.py                      # drop dead columns, track-limits-deleted laps, rows missing
                                      #   Compound/TyreLife; fix sector-time units -> *_clean.csv
  enrich_data.py                     # real weather, traffic, stint/fuel context, team_pace,
                                      #   pace-delta target, built on the *_clean.csv base
  model_enriched_degradation.py      # single shared model (all compounds) on the enriched features
  model_per_compound_degradation.py  # separate model per tyre compound on the same features
  model_laptime_tyrelife_fuel.py     # explicit LapTime = f(TyreLife, fuel, Compound) equation
  progress.py                        # quick count of how many races have been pulled so far
  sandstone.py                       # telemetry scratch script (FastF1 car-data exploration)
  Tyre_degradation.ipynb             # the original experiments: Ridge → Random Forest → pace-delta
notes/
  project_summary.md                   # build history, bugs found and fixed, design decisions
  linear_regression_experiment.md      # first modeling pass, written up in detail
  degradation_experiment_report.md     # July's enriched-features + pace-delta experiment (scratch)
  normalization_experiment_report.md   # feature-scaling ablation (Ridge invariant, RF mildly hurt)
  round_number_bugfix_report.md        # the round_number column-corruption bug and its fix
  enriched_degradation_report.md       # enrich_data.py/model_enriched_degradation.py made permanent
  per_compound_degradation_report.md   # data cleaning + per-compound degradation models
  laptime_tyrelife_fuel_equation.md    # explicit LapTime~TyreLife+fuel+Compound equation per compound
data/    (gitignored)     # per-circuit raw CSVs + train/dev/test splits (+ *_clean, *_enriched)
cache/   (gitignored)     # FastF1 HTTP cache, several GB
```

## Setup

```bash
pip install -r requirements.txt
cd scripts
python data_pull.py   # pulls all 2021–2025 races; resumable — rerun after rate-limit stops
python split.py       # dedups, fixes round_number, writes data/train.csv, dev.csv, test.csv
python clean_data.py  # drops dead columns / bad laps, writes data/*_clean.csv
python enrich_data.py # weather/traffic/stint features on the cleaned base, writes data/*_enriched.csv
jupyter lab Tyre_degradation.ipynb
```

`data/` and `cache/` are not in the repo (multi-GB), so a fresh clone needs the pull above.
FastF1 rate-limits aggressively: `data_pull.py` sleeps between races, stops cleanly on a
rate-limit hit, and on the next run skips races already in the files, so the pull resumes
where it stopped.

## The data

- Every race session 2021–2025, laps flagged `IsAccurate` only, `LapTime` in seconds —
  **108,257 unique laps** across 33 circuit files (28 circuits after name normalization).
- Features per lap: `TyreLife`, `Compound`, `TrackStatus` (bucketed green/yellow/red from
  FastF1's flag codes), `Driver`, `location`, `LapNumber`, plus `WeatherBucket` — which,
  honestly, is *which quarter of the race the lap falls in*, not measured weather (the real
  weather data is fetched but not yet merged; see notes).
- **Split by whole races** (a circuit-year pair never straddles splits), so race-specific
  conditions can't leak between train and dev: train 62,748 laps / dev 22,183 / test 23,326,
  seeded and reproducible.

## Results (dev set)

| Model | Target | Dev R² | Dev MSE |
|---|---|---|---|
| Ridge, full features | LapTime | 0.910 | 12.31 |
| Ridge, no Driver | LapTime | 0.902 | 13.49 |
| Ridge, no Driver + no location | LapTime | 0.018 | 134.63 |
| Ridge + fuel proxy (`LapNumber`) | LapTime | 0.910 | 12.29 |
| Random Forest | LapTime | 0.861 | 19.03 |
| Ridge | LapTimeDelta | 0.271 | 4.45 |
| Random Forest | LapTimeDelta | 0.135 | 5.29 |

What the numbers mean:

- **The R² 0.91 is circuit identity.** Dropping Driver barely moves it; dropping Driver *and*
  location collapses it to 0.02.
- **TyreLife comes out physically backwards** (negative) until fuel load is proxied with
  `LapNumber`, and even then the slope (+0.007 s/lap) is ~10× too small to be believable
  degradation — non-linear warm-up/cliff behavior, per-compound rates, and pit-stop
  survivorship (bad stints get pitted before their slow laps happen) are all invisible to a
  global linear slope.
- **On the pace-delta target** the delta R² of 0.27 is explaining *within-race* pace
  variation — the part the absolute models barely touched — and the forest's TyreLife
  importance jumps from 0.008 to 0.071 (rank 5). A follow-up experiment with enriched
  features (traffic gap, stint context, weather merged from the cache) pushed the linear
  tyre-age slope to +0.026 s/lap and produced the first physically sensible per-compound
  degradation curves — see `notes/degradation_experiment_report.md`.

## Lessons learned the hard way

The pipeline's history is documented in [`notes/project_summary.md`](notes/project_summary.md),
including bugs worth reading about before trusting any append-mode CSV pipeline:

- **The duplicate-lap bug**: resumable pulls that append unconditionally re-appended every
  cached race on every re-run — 452,968 of 561,225 raw rows were duplicates before the fix,
  and the first round of experiment numbers was built on that inflated data.
- **The schema-shift bug, and how much worse it actually was than first thought**:
  different script versions writing different column sets to the same CSVs silently shifted
  `location` into `round_number` on every append after the mismatch (or left it blank).
  `append_matching_schema` in `data_pull.py` stops *new* corruption, but that only prevents
  the bug from getting worse — it doesn't repair what's already collected, and a later audit
  found `round_number` was still corrupted in **82% of train rows, 89% of dev, 66% of test**.
  It was never used as a model feature, so no prior result was built on bad data — but it
  would have broken silently the moment anything needed a real session identifier (pulling
  weather from the FastF1 cache, for one). Fixed in `split.py` by re-deriving `round_number`
  for every row from FastF1's own event schedule, keyed on `(year, location, closest
  EventDate)` rather than trusted from the file — the date is needed, not just
  `(year, location)`, because Austria/Spielberg hosted two separate rounds in 2021 alone.
  See `notes/round_number_bugfix_report.md` for the full diagnosis and verification.

## Open work

- Merge the real weather data into the pipeline proper (currently proven out only in the
  follow-up experiment) and retire the `WeatherBucket` misnomer.
- Tune the Random Forests (both overfit: train ≈ 0.99 vs dev ≈ 0.86 on absolute laps).
- Model per-compound degradation explicitly; stint-level modeling to handle pit-stop
  survivorship.
- FP2 long runs and sprint races as cleaner degradation data (needs new API pulls).
