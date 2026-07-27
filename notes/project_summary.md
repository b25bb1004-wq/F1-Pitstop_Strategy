# F1 Tyre Degradation Project — Build History

An honest record of how this project was built: the pipeline, the bugs, the design decisions,
and the first modeling experiment. Written 2026-07-17, updated the same day after a bug-fix
pass. Code lives in `scripts/` (`data_pull.py`, `split.py`, `Tyre_degradation.ipynb`);
per-circuit raw CSVs and the train/dev/test splits live in `data/`.

Timeline from git:

- **2026-07-10** — initial pipeline commit: `data_pull.py`, `stack_data_together.py`
  (stack + diagnostics), `split.py` (empty placeholder), `progress.py`, `sandstone.py`
  (telemetry scratch script).
- **2026-07-13** — split fix commit: filename-based location, per-circuit year split with
  tiered fallback; `stack_data_together.py` deleted (its job absorbed into `split.py`).
- **2026-07-15** — backup before PC transfer.
- **2026-07-17** — linear regression experiment in `Tyre_degradation.ipynb`; then a bug-fix
  pass that uncovered massive lap duplication in the raw data (see §1), regenerated the
  splits, and re-ran the experiment on clean data.

## 1. Data pipeline (`data_pull.py`)

Pulls every race ('R' session) from the FastF1 API across **2021–2025**: for each year, take
the event schedule, keep `RoundNumber > 0` (drops pre-season testing), load the session, keep
only laps flagged `IsAccurate`, convert `LapTime` to seconds, and append to a per-circuit CSV
(`data/<location>.csv`). A local FastF1 cache (`cache/`) means re-runs don't re-hit the API
for races already downloaded.

**Rate-limit handling.** FastF1 rate-limits aggressively. Two measures ended up in the script:

1. A `time.sleep(4)` between races to stay under the limit in the first place.
2. Explicit `except RateLimitExceededError: sys.exit()` at every stage. The first version only
   had generic `except Exception: continue` handlers, which swallowed the rate-limit error and
   kept hammering the API on every subsequent round. The rewrite makes a rate-limit hit stop
   the script immediately; on the next run the cache fast-forwards through already-pulled races
   and the pull resumes where it stopped. `progress.py` (counts unique years per circuit file)
   was the quick way to check how far the pull had gotten between runs.

**The duplicate-lap bug (found 2026-07-17).** The resume strategy had a flaw that was flagged
as a risk in the initial commit ("dedup") but whose scale wasn't appreciated: `to_csv(mode='a')`
appends unconditionally, and there was no check for races already in the file. Every re-run
after a rate-limit stop re-appended *all* cached races from the top. By the time the pull
completed, **452,968 of 561,225 raw rows were duplicates** — each race present ~3–5 times —
and the original train/dev/test splits (and the first run of the regression experiment) were
built on that inflated data. Because splitting is by year, duplicates never leaked across
splits, but every dataset size and metric was distorted. Fixes applied:

- `data_pull.py` now has an `already_pulled(csv, year, round)` guard that skips races already
  present in the circuit file before loading the session (also saves API budget).
- `split.py` deduplicates at stack time on `(Time, Driver, LapNumber, year, location)` —
  `Time` is the session timestamp, so genuine double-headers (e.g. Spielberg 2021 rounds 8+9)
  survive. Raw files are left as-is; dedup happens downstream.
- The pre-fix splits are archived at `data/pre_dedup_split_backup/` (gzipped) in case the old
  experiment ever needs to be reproduced exactly.

**The location-column corruption bug.** Each lap row gets a `location` column from
`race_session.event['Location']`. After stacking all circuit CSVs together
(`stack_data_together.py`), the combined data had rows where `location` was NaN — the
diagnostic script printed exactly this: the NaN-location rows and their distribution by year.
The 2026-07-17 pass confirmed the mechanism: different script versions wrote **different
column sets** to the same append-mode CSVs. Files whose header includes `round_number` also
contain older 34-column rows appended without a header — pandas reads those rows shifted, so
the location string lands in `round_number` and `location` reads as NaN (e.g. `Monza.csv` has
rows with `round_number == "Monza"`). A few circuit files are pure old-schema and have no
`round_number` column at all.

The fix (2026-07-13 commit) exploits the file layout: each CSV is *named* after its circuit,
and that name is fixed once at file creation — reliable ground truth for every row in the file
even where the stored column isn't. `split.py` therefore ignores the stored `location` column
and overwrites it from `os.path.basename(f)`. A related FastF1 quirk surfaced at the same
time: the same circuit gets different `Location` strings in different seasons, producing **two
files for one circuit** (`Monte Carlo.csv` + `Monaco.csv`, `Miami Gardens.csv` + `Miami.csv`).
`split.py` normalizes these with an explicit rename map. As of 2026-07-17, `data_pull.py`
also aligns any new rows to the existing file's header before appending
(`append_matching_schema`), so a future schema change can't silently shift columns again.

**Honest caveat on `WeatherBucket`.** The script fetches `race_session.weather_data` but never
actually joins it. `WeatherBucket` (1–4) as implemented is which *quarter of the race* a lap
falls in (quartiles of `LapNumber`), guarded against NaN `total_laps`. So the "weather" feature
downstream is really a race-progress bucket. It still carries some signal (conditions and track
evolution correlate with race phase) but merging the real weather data is unfinished work —
and doing it properly means a clean re-pull, since bolting new columns onto the existing
mixed-schema files is exactly what caused the corruption above.

## 2. Train/dev/test split (`split.py`)

The split unit is a **(circuit, year) pair — i.e., a whole race**. Laps from one race never
straddle splits, because if half of a race's laps were in train and the model predicted its
sister laps in dev, R² would be inflated by race-specific conditions (weather, track evolution,
safety cars) leaking across — not by generalization. Splitting *within* circuit (rather than
holding out whole circuits) was deliberate: the model uses `location` as a feature, so every
circuit that appears in dev/test needs at least one year of it in train.

Per circuit, shuffle the available years (seeded with `random.seed(42)` since 2026-07-17, so
the split is reproducible) and apply tiered logic based on how many years exist:

- **≥ 5 years**: 60% of years → train, 20% → dev, 20% → test.
- **3–4 years**: all but the last two years → train, one year → dev, one year → test.
- **< 3 years**: everything → train (a dev/test year would leave the circuit with almost no
  training representation, so these circuits contribute training data only).

Result after dedup: **train 62,748 laps (28 circuits), dev 22,183 (23 circuits), test 23,326
(23 circuits)** — 108,257 unique laps total. Five low-history circuits (Istanbul,
Le Castellet, Portimão, Sochi, Shanghai) are train-only.

Two more fixes from the 2026-07-17 pass: the glob now excludes `train/dev/test.csv`
themselves (previously, re-running `split.py` a second time would have stacked its own outputs
back into the pool), and the year shuffle is seeded (previously every run produced a different
split, which would have silently invalidated any comparison across re-runs).

## 3. Feature engineering decisions

- **Driver and location included, with eyes open.** Both are identity features, and the
  tradeoff was discussed up front: they capture huge real variance (car pace ≈ seconds/lap
  between teams; circuit baseline ≈ tens of seconds between tracks), but they let the model
  succeed without learning anything about tires, and they can't generalize to unseen drivers
  or circuits. They were kept because absolute lap-time prediction is hopeless without the
  circuit baseline, and the plan was always to *measure* how much they dominate (see §4 — they
  dominate almost completely).
- **TrackStatus parsed from FastF1's real flag codes.** FastF1 encodes track status as
  concatenated digit codes ('1' clear, '2' yellow, '4' SC, '5' red, '6'/'7' VSC), so a lap can
  carry combined values like '12' or '21'. The bucketing checks digit membership: any '5' →
  red; any of '2'/'4'/'6'/'7' → yellow; else green. (SC/VSC were originally bucketed green —
  harmless here because `IsAccurate` filtering leaves only statuses {1, 2, 12, 21} in the
  data, but the function now handles them in case the filter ever changes.) Clean train data:
  ~60.7k green / ~2.1k yellow / 0 red laps.
- **`WeatherBucket`** — see the caveat in §1; it is a race-quarter proxy, not measured weather.
- **`LapNumber`** was added in a second model iteration as a fuel-load proxy (cars start heavy
  and get faster as fuel burns).

## 4. Linear regression experiment (`Tyre_degradation.ipynb`)

Full detail in [`linear_regression_experiment.md`](linear_regression_experiment.md), including
pre- vs post-dedup numbers; the short version (clean data):

- `Ridge(alpha=1.0)` on TyreLife + WeatherBucket (numeric) + Compound, Driver,
  TrackStatusBucket, location (one-hot; 71 columns). Dev: **R² 0.910, MSE 12.31**
  (RMSE ≈ 3.5 s). The pre-dedup run had reported a rosier R² 0.948 / MSE 5.51.
- Ablations show the R² is almost entirely Driver + location: dropping Driver alone barely
  moves it (0.902), dropping Driver *and* location collapses it to **0.018** (MSE 134.6).
  This finding replicated identically before and after dedup — the model is a
  circuit-baseline lookup, not a degradation model.
- The **TyreLife coefficient** came out negative in the base model (−0.0045 s/lap — physically
  backwards). Adding `LapNumber` as a fuel proxy **flips it positive** on the clean data
  (+0.0067, with LapNumber absorbing a sensible −0.053 s/lap fuel-burn effect). Note this is a
  data-revision result: on the duplicated data the coefficient had stayed negative even with
  the fuel proxy, and that stronger claim didn't survive the cleanup. Right sign now, but the
  magnitude is still ~10× too small to be believable degradation — non-linearity (warm-up
  phase then cliff), pit-stop survivorship, and per-compound rates are all invisible to a
  single global slope.
- A small notebook bug from the first pass is also fixed: the TyreLife coefficient was printed
  from the variable `model` after it had been rebound to a different fit; the models now have
  distinct names and both coefficients are printed explicitly.
- **Conclusion:** linear regression cannot cleanly recover the tire-age effect. Next model:
  **Random Forest**, to capture the non-linear TyreLife curve and compound/circuit
  interactions.

## Known open items

*(Update 2026-07-27: the Random Forest experiment now lives in the notebook (§5) — it
overfits as configured, train R² ≈ 0.99 vs dev ≈ 0.86, below the ridge baseline — and a
first pace-delta-target pass (§6), following the direction of
[`degradation_experiment_report.md`](degradation_experiment_report.md), is in the notebook
too. Remaining items below.)*

- Merge real weather data (fetched but unused) and retire the `WeatherBucket` misnomer —
  needs a clean re-pull into fresh files (see §1 schema caveat). The follow-up experiment
  proved the merge works from the existing cache; it just isn't in the pipeline proper yet.
- Tune the Random Forests (leaf size, depth, feature subsampling) — both the absolute and
  delta forests overfit.
- Optional cleanup: the raw circuit CSVs still contain the duplicate rows and shifted-schema
  rows (dedup happens in `split.py`); a one-off rewrite of the raw files would make them
  trustworthy on their own. `data/pre_dedup_split_backup/` can be deleted once the old
  experiment numbers no longer matter.
