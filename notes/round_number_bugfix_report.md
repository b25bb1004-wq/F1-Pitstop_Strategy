# Bugfix Report: `round_number` Corruption

**Date:** 2026-09-03.
**Trigger:** a data audit requested before starting new feature-engineering work (weather
enrichment needs a real session identifier per race), not a symptom anyone had noticed in a
model result. `round_number` was never used as a feature by any prior experiment, so nothing
in `Tyre_degradation.ipynb`, `degradation_experiment_report.md`, or
`normalization_experiment_report.md` was built on bad data — this bug was caught before it
caused a problem, not after.

## What was found

`round_number` in `train.csv`/`dev.csv`/`test.csv` is corrupted in **82% / 89% / 66%** of rows.
The corruption is not random noise — it's a fully deterministic column shift:

- ~16% of bad values are outright `NaN`.
- The other ~66–84% are non-numeric strings that, **in 100% of cases checked**, exactly equal
  that row's own `location` value (e.g. `round_number = "Austin"` on an Austin lap).

This is the same failure mode the README already documented as "the schema-shift bug"
(`data_pull.py` writing mismatched column sets to the same CSV across script versions,
shifting values sideways). The existing fix (`append_matching_schema`, aligning new appends to
the file's existing header) stops the corruption from *spreading further* — it does not, and
was never intended to, repair the rows already written before that fix existed. Those rows
made up the large majority of the dataset, and stayed broken.

## Why this wasn't caught earlier

`round_number` was never referenced anywhere in the modeling code — not in
`CATEGORICAL_COLS`, not in any `numeric_cols` list, not in `enrich_data.py`'s features. A
column nothing reads from can be arbitrarily wrong without a single dev-set number ever
changing. It surfaced now because the weather-enrichment step is the first thing in this
project that actually needs a genuine round number, to call `fastf1.get_session(year,
round_number, 'R')` per race.

## The fix

Re-derive `round_number` from FastF1's own event schedule (`fastf1.get_event_schedule(year)`)
instead of trusting the stored column at all, for every row — not just the ones that looked
obviously wrong, since a value that happens to parse as an integer isn't proof it's the
*correct* integer. Implemented in `split.py`, so every future regeneration of `train.csv`/
`dev.csv`/`test.csv` via the documented `data_pull.py` → `split.py` pipeline gets the fix
automatically, rather than a one-time patch to files that would drift back out of sync the
next time someone reruns the pipeline from scratch.

Two real subtleties came up while building this, both verified against actual data before
trusting the fix:

1. **Location names aren't even consistent within the schedule itself.** The same circuit is
   `"Monaco"` in the schedule some years and `"Monte Carlo"` in others; `"Miami"` vs. `"Miami
   Gardens"` likewise. A single fixed alias (`{"Monaco": "Monte Carlo"}`) failed for exactly
   the years that use the opposite spelling. Fixed with equivalence classes
   (`{"Monaco", "Monte Carlo"}`, `{"Miami", "Miami Gardens"}`) mapped to one canonical key on
   both sides of the join, rather than a one-directional rename — validated to give 0
   unmatched `(year, location)` pairs across all of train/dev/test (up from 7 unmatched with
   the naive fixed-alias approach).
2. **`(year, location)` isn't always a unique key into the schedule.** Austria/Spielberg
   hosted two separate races in 2021 (the Styrian GP, round 8, and the Austrian GP, round 9)
   — a join on `(year, location)` alone fans out to two candidate rows for every 2021 Spielberg
   lap. Resolved by matching each lap to whichever schedule row's `EventDate` is closest to
   that lap's own `LapStartDate` (already a column in the data). Verified against the actual
   rows: all 2452 affected laps sit in `test.csv`, split cleanly at the calendar boundary
   (1225 laps on 2021-06-27 correctly resolved to round 8, 1227 on 2021-07-04 to round 9), with
   a maximum lap-to-event-date gap of ~1.3 days across the *entire* dataset — nowhere close to
   large enough to have picked the wrong event by mistake.

## Verification

- **Row counts unchanged**: 62,748 / 22,183 / 23,326 before and after — the fix only replaces
  values in one existing column, it adds or drops no rows.
- **Zero remaining corruption**: `round_number` is 100% non-null and numeric in all three
  files after the fix (down from 82%/89%/66% corrupted).
- **Spot-checked against known facts**: every Sakhir (Bahrain) lap across all years resolves to
  round 1, the season-opening race every year in this window — correct.
- **Full regression test**: the notebook's headline Ridge-baseline result was re-run against
  the regenerated files end-to-end and reproduced **exactly** — dev R² = 0.9102, dev MSE =
  12.3103, matching the pre-fix value to 4 decimal places. Since the train/dev/test split
  itself keys on `(location, year)` (never `round_number` — see `split.py`), and every
  existing feature list never included `round_number`, this was the expected outcome, not a
  coincidence: it confirms the fix changed only what it was supposed to change and disturbed
  nothing else. Every result in `Tyre_degradation.ipynb` and both prior experiment reports
  remains exactly as valid as it was before this fix.

## What this unblocks

`round_number` is now trustworthy enough to use as a real session identifier — specifically,
to load each race's actual weather data from the FastF1 cache for the enriched-features work
that prompted this audit in the first place (see the in-progress `enrich_data.py`).
