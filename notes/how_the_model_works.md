# How Pitwall predicts: the models, and how they were built

**Date:** 2026-10-06. Every number here comes from `reports/metrics.json`. The test season (2025) was scored
once, after all choices were made on 2021-2024.

## In one minute

Pitwall makes two kinds of prediction, and each uses the model that fits the job:

| Question | Model | Type |
|---|---|---|
| How fast will this lap be? | **Structural lap-time model** | Penalised (ridge) regression with physics-shaped terms and hierarchical shrinkage |
| What does a pit stop cost here? | **Measured pit-loss table** | Per-circuit medians of real stops; Safety Car stops measured by gap to the leader |
| How likely is a Safety Car? | **Neutralisation chain** | 3-state Markov chain (green / SC / VSC) per circuit |
| Should we pit now? | **Strategy optimiser** | Stochastic dynamic programming (Bellman backward induction) |
| Will this team pit this lap? | **Pit-call model** | Gradient-boosted trees (scikit-learn `HistGradientBoostingClassifier`) |

The "should we pit" answer is not a black box trained to copy teams. It is an optimiser that adds up predicted
lap times and pit costs for every possible future strategy and picks the fastest. The "will they pit" classifier
is a separate model, built so the app can compare the optimiser's calls with what real teams did.

## 1. Data

- **Source:** FastF1 timing data for every race from 2021 to 2025, rebuilt offline from the local cache
  (`pitwall/build.py`): 114 races and 125,046 laps. Unlike the v1 pipeline, every lap is kept, including in-laps,
  out-laps and Safety Car laps, because those are exactly what a pit-stop model needs.
- **Per lap:** driver, team, lap time, tyre compound and age (`TyreLife`), stint, pit in/out, track status, position,
  weather (track and air temperature, humidity, wind, rain), plus derived features: fuel load
  (100 kg at the start, burned linearly), the gap to the car ahead, the lap within the stint, and the two-compound rule.
- **Representative laps** (used to fit pace): dry race, dry compound, green flag for the whole lap, not an in/out
  lap, not lap 1, not deleted, no rain, and within 5% of the driver's own race median. That leaves 90,709 laps.
- **Splits are whole seasons:** fit on 2021-2023, tune on 2024 (dev), report 2025 (test) once. No lap, stint or
  race of a test season is ever seen during fitting.

## 2. The lap-time model (the core)

### The equation

```
LapTime = base[driver, race]                                   car + driver + track on the day
        + L * offset[compound]   (global + circuit + race)      fresh-tyre pace of S / M / H
        + L * 0.0333 * fuel_kg                                  a lighter car is faster
        + L * deg_c(tyre age)                                   piecewise-linear wear curve per compound
        + L * age * (temp_c * (TrackTemp - 35)/10 + d_circuit,c + d_race,c)
        + L * (cold first flying lap, traffic within 1 s / 1-2 s, laps 2-3, first stint)
```

`L` is the race's typical lap divided by 90 s, so every coefficient means "seconds per 90-second lap". That lets
Monaco and Spa share one set of physics.

### Why this shape: the v1 lesson

The v1 model (a Ridge regression on absolute lap time) scored R2 = 0.91. Ablations showed that almost all of
that came from knowing which circuit it was. Remove circuit and driver, and R2 fell to 0.02. It had learned
"Monaco laps are slow", not tyre physics, and its tyre-age coefficient even came out backwards.

The fix is the first term. Each driver in each race gets their own **base pace**, so the model never needs tyre
or fuel terms to explain why one car or track is faster than another. Tyre wear and fuel are learned only from
variation *within* a driver's race. That is the deconfounding step.

### Separating fuel from tyre wear

Within one stint, fuel load falls and tyre age rises together, lap for lap, so the two are perfectly entangled.
The model separates them at the **pit stops**: at a stop, tyre age resets to zero but the fuel keeps falling. The
learned fuel effect, **0.0333 s per kg per 90 s lap** (about 0.058 s per lap of fuel), sits inside the range
quoted for current F1 cars. That is the main sanity check that the separation worked.

### How it is fitted

It is one penalised least-squares problem with about 2,500 parameters, solved in closed form:
`(X'X + Lambda) b = X'y`. Each block of parameters has a Gaussian prior (ridge penalty = noise variance divided
by prior variance):

| Block | Prior SD | Effect |
|---|---|---|
| Driver-race base pace, global offsets, fuel | 1000 (free) | learned purely from data |
| Circuit and race compound offsets | 0.35 s | shrink to the global offset when data are thin |
| Circuit wear-rate deviation | 0.03 s/lap | Monaco wears less, Bahrain more, but not wildly |
| Race wear-rate deviation | 0.03 s/lap | the day's conditions |
| Temperature x age | 0.02 | hotter track, faster wear |

These hierarchical priors (global, then circuit, then race) are what stop a circuit with only a few stints from
producing a nonsense curve. The fit runs twice: the second pass drops laps more than 4 robust SDs from the
first fit (mistakes, traffic jams). The robust lap-to-lap noise is **0.41 s**.

### What it learned (fit on all seasons)

| Quantity | Value |
|---|---|
| Fuel | 0.0333 s/kg per 90 s lap |
| SOFT: loss vs a fresh tyre at age 10 / 20 / 30 | +0.26 / +0.87 / +1.72 s |
| MEDIUM: same | +0.73 / +1.34 / +2.00 s |
| HARD: same | +0.55 / +1.08 / +1.59 s |
| Running within 1 s of the car ahead | +0.41 s per lap |
| Running 1-2 s behind | +0.20 s per lap |

### Predicting during a race

When laps of a race have been seen, the race-level terms (each driver's base pace, the race's compound offsets
and the race's wear rate) are re-fitted from those laps, with everything learned from history held fixed
(`Structural.fit_local`). Two settings were chosen on the 2024 dev season only:

- **Recent laps weigh more** (5-lap half-life), because pace drifts with track evolution and race mode. This cut
  in-race error by 18%.
- **The race's wear rate stays close to history** (prior SD 0.01), so a few noisy early laps cannot trigger a wrong
  early stop.

### Predicting before the race

With no laps seen, base pace is estimated by a ridge regression on circuit, driver and team, fitted to past base
paces with recent seasons weighted more (1-year half-life, chosen on dev). The physics terms are added on top.

### Tried and rejected (on dev)

- A gradient-boosted correction on the residuals: under 1% better, so it was not kept.
- A race-specific fuel slope: worse, because within one stint it is entangled with the race wear rate.
- Per-driver wear rates: no gain.

## 3. Pit loss

For every real stop: **loss = (in-lap + out-lap) − (what those two laps would have taken without stopping)**,
where the "without stopping" times come from the lap-time model for the same driver and race. Each circuit gets
the median of its latest season (slow stops more than 8 s over the median are dropped). The average is **22.6 s**.

Under a Safety Car, a lap-time comparison is misleading, because the queue behind the SC gives most of the loss
back later. So SC and VSC stops are measured by **gap to the leader three laps later**, against cars that started
from the same gap and did not stop:

- An SC stop costs **9%** of a green stop in pure time.
- A VSC stop costs **59%**.

Teams behave as if an SC stop costs about half a green one, because track position given away under the SC is hard
to win back. The optimiser uses that effective value (0.5), chosen on 2024.

## 4. Safety Car risk

Per circuit, each lap is green, SC or VSC. The chance of a neutralisation starting on a green lap (on average 1.2%
SC and 0.95% VSC per lap, shrunk toward the global rate with a 200-lap prior) and the mean durations (SC 4.1 laps,
VSC 2.1 laps) form a 3-state Markov chain.

## 5. The decision: should we pit now?

At the start of lap *n* the car's state is (compound, tyre age, two-compound rule met, track status). Working
backwards from the flag, the optimiser computes the best expected remaining race time from every state:

```
V_n(c, a, f, s) = min( stay out:   T(c, a+1) + E[ V_{n+1}(c, a+1, f, s') ]
                       pit for c': T(c, a+1) + PitLoss(s) + E[ V_{n+1}(c', 0, f or c' != c, s') ] )
```

- `T(c, age)` is the lap-time model's tyre cost: compound offset, wear curve and the cold first lap, scaled to the
  circuit. Fuel and base pace are the same for every strategy, so they cancel.
- `s'` follows the Safety Car chain, so the optimiser values staying out for a possible cheap SC stop.
- Finishing a dry race without two compounds is ruled out, as in the regulations.
- Beyond the 95th-percentile stint length seen at that circuit, a quadratic "cliff" is added instead of trusting
  the extrapolation.

**Pit now** means the best action at the current state is to stop. The app shows the expected gain, the full plan,
and the pit window. **Agreement** comes from refitting the tyre model on 30 resampled sets of races and counting how
many of the 30 make the same call.

The same optimiser runs in the browser: `web/src/core/pitwall-core.js` is a line-for-line port, and a test checks
that it makes the same calls as Python.

## 6. The pit-call model: what will the team do?

This is a per-lap classifier (gradient-boosted trees) trained on 2021-2024 to predict whether a team boxes on
that lap. It uses only information available before the lap:

- tyre and race state
- what rivals did last lap: how many cars stopped, whether the cars directly ahead or behind or the teammate stopped
- where the car would rejoin after a stop
- the share of the field already stopped
- the pace drop since the stint's best lap

The decision threshold was chosen on 2024 and frozen for 2025.

**A leak found and removed.** An early version took the gap to the car ahead and the position from the *end* of
the current lap, which is distorted when that lap ends in the pit lane. Using lap n−1 values instead dropped F1
from 0.32 to 0.27. All numbers below are after the fix.

## 7. Results on 2025 (never seen in fitting or tuning)

### Lap time during a race (109,883 predictions; MAE in seconds)

| Model | All | 1-5 laps ahead | 21+ laps ahead |
|---|---|---|---|
| Repeat the last lap | 1.111 | 0.536 | 1.519 |
| Mean of last 5 laps | 1.148 | 0.581 | 1.570 |
| Linear fit on the race's own laps (the usual public approach) | 2.549 | 0.607 | 4.508 |
| **Pitwall structural model** | **0.616** | **0.446** | **0.723** |

### Other predictions

| What | Pitwall | Baseline |
|---|---|---|
| Lap time before the race (20,391 laps) | **1.556 s MAE**, R2 0.955 | 1.708 s (v1 Ridge) |
| Pit loss per stop (465 green stops) | **1.53 s MAE** | 2.16 s (a fixed 22 s) |
| Remaining-race time from lap 10 (190 drivers) | **20.0 s (0.49%)** | 54.3 s (1.32%) |

### Pit calls vs real teams (22,331 lap states, 625 real stops)

| Model | Precision | Recall | F1 | F1 within 2 laps | PR-AUC | ROC-AUC |
|---|---|---|---|---|---|---|
| Optimiser alone (time-minimising) | 0.10 | 0.48 | 0.16 | 0.33 | n/a | n/a |
| Classifier on tyre and race state | 0.12 | 0.56 | 0.19 | 0.40 | 0.182 | 0.844 |
| **Pit-call model (+ rivals and field)** | **0.21** | **0.41** | **0.27** | **0.45** | **0.245** | **0.876** |
| Leaky: sees the lap's own time | 0.90 | 0.79 | 0.84 | 0.85 | 0.911 | 0.994 |

The leaky row reproduces the score of a published Bi-LSTM pit predictor (F1 0.81, ROC-AUC 0.988). A lap that ends
in the pit lane is slow *because* of the stop, so a model given that lap's time is reading the answer off the lap
itself. Without that information, F1 is about 0.27. Pitwall reports both.

## 8. The What-If engine

What-If reruns a real 2025 race with one thing changed:

1. Each driver's real **clean pace** is taken lap by lap (real lap times with any pit-lane time removed).
2. The change is applied through the model. For example, moving a stop changes which tyre and age each lap runs on;
   the tyre cost difference comes from the wear curves, and the pit loss moves to the new lap.
3. Safety Cars are **events**: SC laps run at a common pace, and at the end of each SC period the field queues
   up, with lapped cars staying a lap down.
4. Each car's what-if clock is its **real clock plus the modelled change** (difference-in-differences), so model
   error cancels out and an unchanged race reproduces reality exactly.
5. The field is re-ranked by elapsed time.

Not modelled: traffic and how hard it is to overtake. Time gained is assumed to turn into positions.

## 9. Limits, stated plainly

- The optimiser minimises one car's own time. Undercuts, covering rivals and tyre-set availability are why it
  agrees with real team calls far less than the pit-call model does.
- Tyre curves have some **survivorship** bias: very old tyres are mostly seen on cars where they held up.
- SOFT, MEDIUM and HARD are relative per event (the C1-C5 allocation is not in FastF1); circuit offsets absorb most
  of this, but the curves overlap.
- Wet races are excluded throughout.
- Pre-race prediction still errs by about 1.5 s per lap, because a new season's car pace is the main unknown.
  In-race calibration removes most of it.

## 10. Where it lives in the code

| File | What |
|---|---|
| `pitwall/build.py`, `pitwall/features.py` | data rebuild and representative-lap filter |
| `pitwall/structural.py` | the lap-time model (fit, in-race refit, curves) |
| `pitwall/pitstops.py` | pit loss and Safety Car chain |
| `pitwall/strategy.py` | the dynamic-programming optimiser |
| `pitwall/evaluate.py`, `pitwall/tune.py` | held-out evaluation and dev-only tuning |
| `web/src/core/pitwall-core.js` | the optimiser in the browser (parity-tested) |
| `web/src/whatif/engine.ts` | the What-If race simulator |
