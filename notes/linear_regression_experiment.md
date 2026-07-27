# Linear Regression (Ridge) Experiment — Tyre Degradation

Notes on the first modeling pass: predicting race lap time with Ridge regression and trying to
read tire degradation off the TyreLife coefficient. Notebook: `scripts/Tyre_degradation.ipynb`.
Data: `data/train.csv` (62,748 laps) / `data/dev.csv` (22,183 laps), IsAccurate race laps,
2021–2025. Target is `LapTime` in seconds.

> **Data revision note (2026-07-17).** The first run of this experiment used splits built from
> raw files that contained each race ~3–5 times over (the data-puller re-appended cached races
> on every re-run — see `project_summary.md`). After deduplication the dataset shrank from
> 561k to 108k laps, the splits were regenerated with a fixed seed, and the notebook was
> re-run. The numbers below are from the clean data; where the pre-dedup run told a
> *different story*, that's called out explicitly.

## 1. Feature set

| Feature | Encoding | Why it's in |
|---|---|---|
| `TyreLife` | numeric (laps on current set) | The variable of interest — degradation should show up as a positive coefficient (older tires → slower laps). |
| `Compound` | one-hot (SOFT / MEDIUM / HARD / INTERMEDIATE / WET) | Compounds have different base pace and different degradation behavior; without it, soft-tire laps just look "fast". |
| `WeatherBucket` | numeric 1–4 | Coarse conditions/session-phase proxy, computed in the pipeline as which quarter of the race the lap falls in. (Caveat: it is a race-progress bucket, not measured weather — see project summary.) |
| `TrackStatusBucket` | one-hot (green / yellow / red) | Derived from FastF1's flag codes: `'5'` in status → red; `'2'`, `'4'` (SC), `'6'`/`'7'` (VSC) → yellow; else green. Yellow-flag laps are slow for reasons that have nothing to do with tires. Train data only contains statuses {1, 2, 12, 21}, so it ends up green (60,670) vs yellow (2,078). |
| `Driver` | one-hot (34 drivers) | Absorbs car + driver pace differences. A Red Bull lap and a Williams lap on identical tires differ by seconds; without Driver that variance pollutes everything else. Known tradeoff: it's an identity feature, so the model can lean on it instead of learning physics. |
| `location` | one-hot (28 circuits) | Circuit baseline. Lap times range from ~70 s (Zandvoort-class) to ~105 s+ (Spa-class); absolute lap-time prediction is meaningless without it. Same identity-feature tradeoff as Driver. |

Full design matrix: 71 columns (rows with NaN dropped before fitting).
Model: `Ridge(alpha=1.0)`, unscaled features. Dev features are reindexed to the train columns
with `fill_value=0` so categories unseen in dev don't break prediction.

## 2. Overall performance (dev set, 21,526 laps after NaN drop)

| Model | Dev R² | Dev MSE |
|---|---|---|
| Full (all features above) | **0.9102** | **12.31** (RMSE ≈ 3.5 s) |
| Full + LapNumber | 0.9103 | 12.29 |
| Without Driver (location kept) | 0.9016 | 13.49 |
| Without Driver and location | 0.0182 | 134.63 |

The pre-dedup run reported R² 0.9478 / MSE 5.51. Part of that gap is the reshuffled split, but
the flattering earlier numbers also came from a dev set where popular races were counted
several times over. R² ~0.91, RMSE ~3.5 s is the honest baseline.

## 3. Key finding: Driver + location dominate the prediction

The ablation rows above are the important result (and they replicate on the clean data exactly
as on the original run). Removing Driver alone barely matters (0.9102 → 0.9016). Removing
Driver **and** location collapses R² to ~0.02 — essentially no predictive power left.

So almost all of the R² comes from the model knowing *which circuit* the lap is on (and to a
much smaller extent who is driving), not from anything about tire state. The
tire/compound/weather/flag features contribute only marginally on top of "Spa laps take ~105 s,
Zandvoort laps take ~72 s". The model is a lookup table of circuit baselines with small
corrections — it is not a degradation model.

## 4. The TyreLife coefficient problem

Degradation physics says the TyreLife coefficient should be positive (each lap of tire age adds
time). What actually happened, before and after the data cleanup:

| Model | TyreLife coef, pre-dedup data | TyreLife coef, clean data |
|---|---|---|
| Full model | −0.0204 | −0.0045 |
| Without Driver | −0.0215 | −0.0064 |
| Full + `LapNumber` (fuel proxy) | −0.0134 | **+0.0067** (LapNumber: −0.0531) |

Two things changed with clean data:

1. **The base model's negative coefficient shrank ~4×** (−0.020 → −0.0045). The duplicated
   races were amplifying the confounded pattern.
2. **Adding `LapNumber` now flips TyreLife positive.** On the duplicated data the original
   conclusion was "fuel proxy halves it but can't flip the sign" — that turned out to be
   partly a data artifact. On clean data, LapNumber absorbs a sensible fuel-burn effect
   (−0.053 s per lap, i.e. the car gets faster as it burns fuel) and TyreLife comes out
   positive at +0.0067 s per lap of tire age.

So the linear model, on clean data and with a fuel proxy, does recover the right *sign*. But
the magnitude is not credible: +0.007 s/lap implies ~0.2 s lost over a 30-lap stint, an order
of magnitude below realistic degradation. The remaining suspects from the original analysis
still apply:

- **Non-linear degradation.** Warm-up phase (fresh tires slower for the first laps), a long
  flat phase, then a cliff. A single global linear slope through that shape averages toward
  zero.
- **Survivorship/censoring.** Drivers pit when degradation gets bad. The high-TyreLife laps
  that exist are disproportionately from stints where the tires were holding up (hard
  compounds, low-deg tracks, tire management). The steep-degradation laps are systematically
  missing from the right tail.
- **One global slope across compounds.** Degradation rate differs a lot by compound, but the
  model fits a single TyreLife slope with compound only shifting the intercept.
- **Fuel/tire-age collinearity.** LapNumber and TyreLife still move together within a stint;
  a linear model splits the shared variance between them in a way that's sensitive to
  specification.

¹ Historical note: the original notebook printed the TyreLife coefficient from the wrong model
— the cell reused the variable `model` after it had been rebound to the no-Driver fit. The
sign and magnitude happened to be similar so no conclusion changed, but the notebook now uses
distinct names (`model_full`, `model_simple`) and prints both coefficients explicitly.

## 5. Conclusion

Linear regression answers "what's the lap time" mostly by circuit identity. On clean data it
recovers a positive tire-age effect once fuel load is proxied, but the effect is implausibly
small — the non-linear warm-up/cliff shape, per-compound degradation rates, and pit-stop
censoring are all things a global linear slope can't represent. Next step: **Random Forest**,
which can capture the non-linear TyreLife curve and the compound × TyreLife × circuit
interactions without hand-specifying them.

See `project_summary.md` for how the dataset behind this experiment was built (and the
duplicate-lap bug that forced the data revision).
