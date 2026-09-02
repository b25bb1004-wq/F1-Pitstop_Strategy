# Report: An Explicit LapTime = f(TyreLife, Fuel, Compound) Equation

**Date:** 2026-09-03.
**Request:** "now work on connecting lap time with tyrelife and fuel compound."

Every prior model script in this project (`model_enriched_degradation.py`,
`model_per_compound_degradation.py`) predicts `LapTimeDelta` — LapTime minus the driver's own
best green-flag lap that race — specifically so the model doesn't waste capacity re-deriving
circuit/driver baseline speed from features. That's the right choice for prediction accuracy,
but it means "how many seconds does a lap of tyre wear cost" isn't a number you can read
straight off a coefficient — it's baked into a delta.

This does the same deconfounding job a different way: predicts raw `LapTime` directly, and
removes the circuit/car speed confound by **controlling for it as a feature** (location
dummies + `team_pace`) rather than subtracting it from the target. That leaves `TyreLife` and
`laps_remaining` (fuel) as ordinary regression coefficients, in seconds per lap, directly on
lap time — a literal equation connecting the three things asked for.

## A collinearity bug caught before trusting any numbers

The first version of this script also included `lap_in_stint` and `stint_start_tyre_age`
alongside `TyreLife` in the same regression. `enrich_data.py` defines
`stint_start_tyre_age = TyreLife - lap_in_stint + 1` — an **exact linear identity**, confirmed
directly on real data (`(stint_start_tyre_age - (TyreLife - lap_in_stint + 1)).abs().max()` is
`0.0`, not just small). Three variables where one is an exact linear function of the other two
is perfect multicollinearity: Ridge has no way to decide which of them "owns" the shared
variance, so it splits credit arbitrarily based on relative feature variance and the
regularization strength. This showed up concretely as backwards-signed, wildly
inconsistent-across-compound `TyreLife` coefficients (SOFT -0.022, MEDIUM -0.026, HARD +0.063,
WET -0.534) that had nothing to do with tyre physics — an artifact of which of the three
collinear columns absorbed the regularization penalty least.

**Fix:** dropped `lap_in_stint` and `stint_start_tyre_age` from this equation, keeping only
`TyreLife` and `laps_remaining`. Checked their correlation before trusting the pair
(`-0.435`) — meaningfully related (more tyre age within a race does correlate with less fuel
remaining, as expected) but nowhere near collinear, so this pair's coefficients are safe to
read directly.

## The equation, per compound

Fit on green-flag laps only (`TrackStatusBucket == 'green'`) — a Safety Car or red-flag lap's
time reflects the incident, not tyre wear or fuel, and would otherwise swamp both coefficients.

| Compound | Train laps | Dev laps | TyreLife (s/lap) | Fuel: laps_remaining (s/lap) | Dev R² | Dev MAE (s) |
|---|---|---|---|---|---|---|
| HARD | 26,155 | 10,154 | **+0.0276** | +0.0604 | 0.9311 | 1.887 |
| MEDIUM | 21,174 | 7,998 | -0.0054 | +0.0369 | 0.9071 | 2.177 |
| SOFT | 8,255 | 1,735 | -0.0024 | +0.0531 | 0.8562 | 2.839 |
| INTERMEDIATE | 4,002 | 853 | -0.0741 | +0.0468 | -0.0403 | 12.665 |
| WET (train-only) | 213 | 0 | -1.1915 | -0.3673 | n/a | n/a |

Combined equation (`Compound` folded in as a dummy, one shared `TyreLife`/fuel slope across all
compounds): dev R²=0.9115, MAE=2.20s, shared `TyreLife` coefficient **+0.0048 s/lap**, shared
fuel coefficient **+0.0479 s/lap**.

## Reading the numbers

- **Fuel is the clean, consistent signal.** `laps_remaining`'s coefficient is positive and in a
  tight, physically sensible range (+0.037 to +0.060 s/lap) across every dry compound: more
  laps of fuel still to burn means a heavier car means a slower lap, exactly the expected
  direction, and the magnitude lines up with textbook F1 fuel-effect estimates (~0.03-0.06 s
  per lap of fuel).
- **TyreLife is small and compound-dependent, consistent with every other experiment in this
  project.** HARD gives a clean, positive, physically sensible +0.0276 s/lap. SOFT and MEDIUM
  come out slightly *negative* — not because tyre wear speeds cars up, but because, as
  documented since the original notebook (`Tyre_degradation.ipynb` section 4) and again in
  `enriched_degradation_report.md`, a *linear* model can't fully separate tyre wear from race
  strategy: drivers push hardest on fresh soft/medium tyres early in a stint and back off
  ("lift and coast") as the tyre ages to manage it to the pit window, which pulls the raw
  TyreLife-vs-LapTime relationship toward flat or slightly negative for exactly the compounds
  driven that way. HARD's stints run longer and flatter (less strategic pace variation within
  the stint), which is likely why its coefficient comes out clean while SOFT/MEDIUM's don't.
- **This is not a contradiction of the nonlinear per-compound curves** — it's a direct,
  reassuring consistency check. `model_per_compound_degradation.py`'s HGB curves imply an
  *average* slope of ≈+0.023 s/lap for HARD (1.04s at lap 1 → 1.72s at lap 30, over 29 laps) and
  ≈+0.001 s/lap for SOFT (1.93s → 1.97s, essentially flat) — both close to this linear
  equation's +0.0276 and -0.0024 respectively. Two different models (linear vs. gradient-boosted
  trees, raw LapTime vs. pace-delta target) landing on the same conclusion — HARD degrades at a
  small but real, positive, roughly consistent rate; SOFT's degradation is close to
  undetectable in this data — makes both results more credible than either alone.
- **INTERMEDIATE and WET carry the same caveats as every prior report**: INTERMEDIATE's dev R²
  is negative for the same reason diagnosed in `per_compound_degradation_report.md` (dev is only
  2 wet races, a different mix of severity than train's 10), and WET has zero dev rows so its
  coefficients are an unvalidated train-only diagnostic, not a trustworthy number.

## Problems encountered, and fixes

1. **Perfect multicollinearity** between `TyreLife`, `lap_in_stint`, and `stint_start_tyre_age`
   (an exact identity by construction in `enrich_data.py`) produced meaningless, sign-flipping
   coefficients — caught by comparing the first run's numbers against physical expectation
   (they made no sense across compounds) before writing any of them down, confirmed with a
   direct residual check, and fixed by dropping the two redundant columns from this equation.

## What this adds that wasn't there before

The prior reports have degradation *curves* (nonlinear, hard to quote as a single number) and a
pace-delta target (deconfounded but not in raw-LapTime units). This gives a single, quotable
number per compound in the units that actually matter for strategy — "an extra lap on this
Hard tyre costs about 0.03 seconds; an extra lap of fuel costs about 0.06 seconds" — cross-
checked against the existing nonlinear results rather than presented as a replacement for them.
