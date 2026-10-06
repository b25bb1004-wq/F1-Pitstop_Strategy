# Pitwall v2: end-to-end lap-time, degradation and pit-stop pipeline

**Date:** 2026-10-06.
**Request:** build an end-to-end pipeline that predicts lap time from race conditions, models
tyre degradation, prepares a strategy, and decides whether a car should pit now; document it,
and compare it against existing models.

All numbers below come from `reports/metrics.json` (written by `python -m pitwall.evaluate`).
`reports/RESULTS.md` has the full tables.

## 1. Why v1 could not do this

v1 (`scripts/`) trained on `IsAccurate` laps only. FastF1 marks in-laps, out-laps and most
Safety Car laps as inaccurate, so the data had no pit stops and no neutralisations in it. A
pit-stop model cannot be built from that. v1's best lap-time model was a Ridge on absolute
lap time whose R2 of 0.91 came from circuit identity. Its tyre-age coefficient was small or
backwards because nothing separated tyre wear from fuel burn, driver pace or race strategy.

## 2. Data (`pitwall/build.py`, `pitwall/features.py`)

- Rebuilt from the local FastF1 cache in **offline mode** (no API calls, no rate limits, about
  2 s per race): 114 races, 125,046 laps, every lap kept, with weather merged per lap and
  classification results attached.
- Qualifying sessions are missing from the cache for 93 of 114 races, so qualifying pace could
  not be used as a pre-race feature.
- **Representative lap** (used to fit pace): dry race, dry compound, the whole lap green
  (TrackStatus all `1`), not an in/out lap, not lap 1, not deleted, no rain, within 5% of the
  driver's race median. 90,709 laps qualify (97 dry races).
- Fuel load: 100 kg at the start, burned linearly to the flag.
  `L = race median representative lap / 90 s` scales every effect to the circuit's length.

## 3. The structural lap-time model (`pitwall/structural.py`)

```
LapTime = base[driver, race]
        + L * (offset_c + offset_c,circuit + offset_c,race)
        + L * b_fuel * fuel_kg
        + L * deg_c(age)                         piecewise linear, knots 0/4/10/18/28/40
        + L * age * (b_temp_c * (TrackTemp-35)/10 + d_c,circuit + d_c,race)
        + L * (cold tyre on the first flying lap, traffic within 1 s / 1-2 s, laps 2-3, first stint)
```

One penalised least-squares problem (about 2,500 parameters), fitted in two passes with
gross outliers (beyond 4 robust sigma) dropped after the first. Each block has a Gaussian prior
(ridge penalty sigma^2 / prior_sd^2), so circuit and race deviations shrink toward the global
curve when data are thin.

**Identification.** The per-driver-race base pace means tyre and fuel effects come only from
variation within a driver's race. Inside a stint, tyre age and fuel are both linear in the lap
number and so collinear. Stint boundaries separate them: tyre age resets while fuel keeps
falling. The fitted fuel effect, 0.033 s per kg per 90 s lap (about 0.058 s per lap of fuel),
sits in the range published for current F1 cars, which is the main sanity check that the
separation worked.

**In-race updates** (`fit_local`): during a race, the race-level blocks (each driver's base
pace, the race compound offsets, the race wear-rate deviation) are re-solved from the laps seen
so far, with everything else held fixed. On 2024 (dev) the wear-rate update needed a much
tighter prior than the historical fit (0.01 vs 0.03), otherwise a few early laps produced early
pit calls.

### Rejected variants (dev season 2024)

| Variant | In-race MAE | Remaining-race error | Kept? |
|---|---|---|---|
| Base model | 0.777 s | 40.4 s | yes |
| + race-level fuel / track-evolution slope | 0.907 s | 54.3 s | no: within one stint it is collinear with the race wear rate, and extrapolates badly |
| Wider race priors (wear 0.06, offset 0.5) | 0.899 s | 58.7 s | no |
| + gradient-boosted residual correction | 0.776 s | n/a | no: under 1% gain, rule requires 1% |

## 4. Pit loss and Safety Cars (`pitwall/pitstops.py`)

- **Green stops:** loss = (in-lap + out-lap) minus the structural model's expected time for
  those laps without a stop, using the race's own base pace. The circuit value is the median of
  the latest season with at least 6 stops (slow stops more than 8 s over the median are
  dropped). 2025 hold-out: MAE 1.53 s vs 2.16 s for a constant 22 s.
- **SC / VSC stops:** a lap-time comparison gives nonsense under a Safety Car (the first
  version said an SC stop cost 94% of a green one). The queue behind the SC closes most of the
  pit-lane deficit later, so the effective cost is measured by gap to the leader three laps
  after the in-lap, against non-stopping cars that started from the same gap. That gives 9% of
  a green stop under SC and 59% under VSC (pooled; per-circuit samples are too small).
- **Neutralisation risk:** per-circuit onset hazards for SC and VSC (shrunk toward the global
  rate with a 200-lap prior) plus mean durations (SC 4.1 laps, VSC 2.1) form a 3-state Markov
  chain for the optimiser.

## 5. The decision (`pitwall/strategy.py`)

State at the start of lap n: (compound, laps on the set, two-compound rule met, track status).
Backward induction over the remaining laps:

```
V_n(c,a,f,s) = min( T(c,a+1) + E V_{n+1}(c, a+1, f, s'),                        stay out
                    T(c,a+1) + PitLoss(s) + E V_{n+1}(c', 0, f or c'!=c, s') )    pit for c'
```

T comes from the structural model (fuel and base pace are the same for every strategy and
cancel). Beyond the 95th-percentile stint length for the circuit and compound a quadratic
cliff is added instead of trusting extrapolation. Finishing a dry race without two compounds
is penalised as infeasible. Outputs: pit now or not, the time gain, P(pit now is optimal)
across 30 race-bootstrap refits, the optimal plan, and a committed-stop window. The window
assumes green running until the stop, which is why it can favour an earlier lap than the plan:
the plan also values the chance of a cheap SC stop.

**Calibrated on dev (2024) only**, grid in `reports/decision_tuning_dev.csv`: effective SC
stop cost 50% of green (vs the measured 9% in time), and the in-race wear prior above. Teams
pitting under an SC give away track position that time alone does not price.

## 6. Results on the 2025 hold-out

| | Pitwall | Best baseline |
|---|---|---|
| In-race lap time, MAE all horizons | **0.616 s** | 1.111 s (last lap) |
| In-race, 1-5 laps ahead | **0.446 s** | 0.536 s |
| In-race, 21+ laps ahead | **0.723 s** | 1.519 s |
| Pre-race lap time, MAE | **1.556 s** | 1.708 s (v1 Ridge) |
| Pit loss MAE | **1.53 s** | 2.16 s (constant) |
| Remaining-race time from lap 10 | **20.0 s (0.49%)** | 54.3 s (1.32%) |

Pit decisions vs teams, 22,331 lap states with 625 real stops:

| Model | P | R | F1 | F1 within 2 laps | PR-AUC | ROC-AUC |
|---|---|---|---|---|---|---|
| Optimiser alone | 0.10 | 0.48 | 0.16 | 0.33 | n/a | n/a |
| Classifier, tyre/race state | 0.12 | 0.56 | 0.19 | 0.40 | 0.182 | 0.844 |
| Pit-call model (+ rivals, field) | 0.21 | 0.41 | 0.27 | 0.45 | 0.245 | 0.876 |
| Pit-call model + optimiser outputs | 0.22 | 0.37 | 0.27 | 0.43 | 0.219 | 0.872 |
| Leaky (current lap time) | 0.90 | 0.79 | 0.84 | 0.85 | 0.911 | 0.994 |

Classifier thresholds were chosen on 2024 and frozen for 2025.

### Second pass (same day): what moved the numbers

- **Recency-weighted in-race calibration.** Weighting laps already driven with a 5-lap half-life,
  plus the tighter wear prior, took dev in-race MAE from 0.777 s to 0.626 s; on 2025 it took
  0.748 s to 0.616 s and the remaining-race error from 25.8 s to 20.0 s. Grid on dev: half-life
  none/30/15/8/5/3/2/1.5 with the wear prior 0.003-0.03. Per-driver wear rates were also tried
  and gave nothing.
- **A leak in my own baselines.** `gap_ahead` and `Position` were taken from the end of the
  current lap, which an in-lap distorts. Switching to lap n-1 values dropped the first hybrid
  from F1 0.32 to 0.27. The 0.32 in the first write-up was partly the leak.
- **Rival and field context** (all from lap n-1 or earlier): positions lost if the car stopped
  now, the gap at the rejoin point, gap and tyre-age difference to the cars ahead and behind,
  teammate stop, stops by cars within 3 places in the last 2 laps, and the share of the field
  already stopped. These took the classifier from F1 0.19 to 0.27 and PR-AUC from 0.182 to 0.245.
  The optimiser's outputs add nothing on top once these are present.
- **Dashboard** (`docs/`, GitHub Pages) with the optimiser ported to JavaScript and a parity
  test against Python, plus pytest coverage of strategy behaviour and physics recovery.

## 7. Comparison with existing models

- **v1 of this repo:** pre-race MAE 1.708 s, now 1.556 s; in-race 0.616 s. v1 had no in-race mode, pit loss or
  decision layer.
- **Public FastF1 lap-time projects** report 0.29-0.57 s and 0.33-0.37 s MAE. Those numbers
  come from 1-3 races, with laps or stints of the same race in the training set
  (interpolation). Their approach (a linear model on the race's own laps) re-implemented as a
  forecaster over all 2025 races scores 2.549 s. Pitwall forecasts 1-5 laps ahead at 0.446 s
  over an unseen season.
- **Bi-LSTM pit predictor (Frontiers in AI, 2025):** per-lap F1 0.81, ROC-AUC 0.988, on the
  last 8 races of 2024. Pitwall's classifier reaches the same level (0.84 / 0.994) only when
  given the current lap's time: an in-lap is slow because the car is entering the pits, so
  the "prediction" reads the stop off the lap itself. Restricted to information available
  before the lap, the best model scores 0.27 / 0.876. I have not verified that the paper's
  features include the lap time, so this explanation is [Likely], not proven.
- **Virtual Strategy Engineer (Heilmeier et al., 2020):** neural networks trained to imitate
  team pit decisions inside a race simulator. Pitwall separates the two concerns instead: an
  explicit, inspectable optimiser for "should", and an imitation model for "will".

## 8. Bugs found and fixed during the build

1. **Index labels used as row positions.** The first design-matrix builder grouped rows with
   `Series.groupby(...).groups`. That returns index labels, and on a filtered frame those are
   not row positions. Base-pace columns pointed at the wrong rows, and scipy's sparse
   constructor did not catch it, so memory was silently corrupted. Replaced with a
   factorise-and-split helper that returns positions. Every reported number comes from runs
   after the fix.
2. **`scipy.linalg.solve(assume_a="pos")` segfaults** after a few calls on scipy 1.17 /
   numpy 2.4 (reproduced in isolation; `numpy.linalg.solve` is clean). Switched solvers.
3. **A flattering metric.** The first version of "first pit call within 2 laps" scored a stint
   where the model never called a stop as "1 lap late", and SC accuracy rewarded a model that
   never pits. Both were rewritten (never-called counts as a miss; SC uses balanced accuracy)
   before any decision parameter was chosen.

## 9. Limitations and next steps

- The optimiser minimises one car's own time. Undercut/overcut, covering rivals and tyre-set
  availability are not modelled, which is most of the gap between it and team calls. Next
  step: a two-car undercut model using the gap features already built.
- Survivorship still flattens the far end of the tyre curves. A selection model for stint
  length, or FP2 long runs, would help.
- The C1-C5 compound allocation is not in FastF1. Adding Pirelli's per-event allocation would
  sharpen compound offsets.
- Wet races are excluded.
