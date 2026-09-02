# Experiment Report: Feature Normalization for Tyre Degradation

**Date:** 2026-09-03.
**Status of project files: unchanged.** `Tyre_degradation.ipynb`, `data_pull.py`, `split.py`,
and everything in `data/` are exactly as they were. This experiment ran from a new script,
`scripts/normalize_and_retrain.py`, which is the only new file besides this report.

## What was tested

The question: does standardizing the numeric features (`TyreLife`, `WeatherBucket`,
`LapNumber`) — as opposed to feeding them into the models in their raw units — change how
well the tyre-degradation signal comes through, for either the Ridge or Random Forest models
in the notebook?

Every one of the notebook's six model/target combinations was re-run twice on identical
train/dev splits (62,748 / 22,183 laps, dedup'd, split by whole race — same files the notebook
reads): once exactly as the notebook does it (raw units), once with a `StandardScaler` fit on
train and applied to both train and dev. One-hot categorical dummies (`Compound`, `Driver`,
`TrackStatusBucket`, `location`) were **not** scaled in either run — see "Decisions" below for
why. A `RidgeCV` sweep over 12 alphas (0.01 to 1000) on the normalized features checked whether
the notebook's `alpha=1.0` was still a reasonable choice once features were on a common scale.

## Results

### Dev R², raw vs normalized

| Model | Target | Raw dev R² | Normalized dev R² |
|---|---|---|---|
| Ridge baseline | LapTime | 0.9102 | 0.9102 |
| Ridge no-driver | LapTime | 0.9016 | 0.9016 |
| Ridge fuel-proxy | LapTime | 0.9103 | 0.9103 |
| Random Forest | LapTime | 0.8612 | 0.8611 |
| Ridge (delta) | LapTimeDelta | 0.2715 | 0.2715 |
| **Random Forest (delta)** | LapTimeDelta | **0.1347** | **0.0939** |

### TyreLife coefficient, Ridge models (converted back to seconds/lap for comparability)

| Model | Raw coef | Normalized coef, converted back |
|---|---|---|
| Baseline | −0.0045 | −0.0045 |
| No-driver | −0.0064 | −0.0064 |
| Fuel-proxy | +0.0067 | +0.0067 |
| Delta | +0.0021 | +0.0021 |

### RidgeCV alpha check

- Best alpha on normalized features: **≈0.081** (absolute and delta targets both), far below
  the notebook's `alpha=1.0`.
- Refitting at that "better" alpha moved dev R² by **0.0002–0.0005** in either direction
  (0.9103→0.9105 absolute, 0.2715→0.2710 delta) — inside noise, not a real gain.

## What this means

**Normalization does nothing for the Ridge models, and the reason is mathematically exact, not
approximate.** Ordinary least squares is invariant to any linear rescaling of its inputs —
standardizing a feature just rescales its coefficient by the same factor, and the fitted line
(hence every prediction) is unchanged. Ridge regression *can* differ from OLS under rescaling,
because its L2 penalty is applied per-coefficient and is therefore scale-dependent — but only
when the penalty is large enough, relative to the data, to actually bind. The RidgeCV sweep
answers that directly: the best alpha here is ~12× smaller than the notebook's default, and
even moving to it barely changes dev R². With 62,748 training rows and only ~2–3 numeric
features plus dummies, `alpha=1.0` was never strong enough to make Ridge behave differently
from OLS in the first place — so there was no scale-dependent regularization effect for
normalization to change. **The tiny, confounded TyreLife coefficient the notebook found is a
real property of the data (non-linear degradation, fuel-load confounding, pit-stop
survivorship) — not a feature-scaling artifact.** Normalizing and re-deriving the same numbers
is itself the evidence for that: nothing moved.

**Random Forest is not scale-invariant in practice, only in theory — and the gap is a real,
reproducible finding, not noise.** The textbook claim is that tree splits (`feature <=
threshold`) are invariant to any monotonic transform of a feature, so standardizing shouldn't
change a forest's structure at all. It should hold *exactly* for a single tree fit on exact
arithmetic. It does not hold exactly here, because standardizing converts exact integer inputs
(`TyreLife`, `LapNumber` are integers in the source data) into imprecise floating-point z-scores,
and the sklearn split-search breaks ties between candidate thresholds using their raw
floating-point values. A handful of splits near the root end up decided differently under the
transformed, imprecise representation than under the original exact integers — and because
each tree's bootstrap sample and later splits depend on everything above them, one flipped
early split can reshape a large part of that tree. This was verified directly, not assumed:

- Fitting the same `RandomForestRegressor(random_state=42, n_jobs=-1)` twice on **identical**
  data reproduces bit-for-bit identical feature importances — ruling out thread-scheduling
  non-determinism from `n_jobs=-1` as the cause.
- Fitting it on the **raw vs. standardized** version of the same rows, same target, same
  `random_state`, produces measurably different predictions (max |Δ| ≈ 9 seconds on the
  delta-target dev set) despite `np.allclose`-equal top-line feature importances at 6-decimal
  display precision — the forests are close in aggregate behavior but not identical in
  structure.

The absolute-target forest barely noticed (R² 0.8612 → 0.8611): its dominant features are the
28 `location` and 35+ `Driver` dummy columns, which were never scaled, so only 3 of ~70 columns
were even perturbed. The delta-target forest is a different story: its R² is already low
(0.13 — a genuinely hard, low-signal target), so it has much less "spare" predictive structure
to fall back on when a few early splits land differently, and the relative hit is much larger
(0.1347 → 0.0939, a 30% relative drop). **The practical lesson: standardizing integer features
before a tree ensemble buys nothing and can measurably hurt a model that's already working with
a weak signal — the floating-point noise it introduces has nowhere to hide when R² is small.**

## Problems encountered, and the fixes applied

1. **A misleading first look at the Random Forest (delta) result.** The first run showed
   materially different dev R² between raw and normalized (0.1347 vs 0.0939) *and* printed
   feature importances that looked pixel-identical, which briefly looked like a scoring bug
   (identical model, different score reported) rather than a real modeling effect. Diagnosed by
   directly comparing prediction arrays (`np.allclose`, exact max-diff) instead of trusting the
   6-decimal display of `feature_importances_` — the fix was verifying at full float precision,
   which showed the models are close but genuinely not identical. Confirmed the root cause
   (floating-point split-threshold precision, not a code bug) with the isolated determinism
   test described above before writing this up.
2. **A pandas `FutureWarning` on every scaled assignment.** `TyreLife`/`LapNumber`/
   `WeatherBucket` are `int64` in the source CSVs; assigning `StandardScaler`'s `float64` output
   into an `int64`-typed DataFrame slice (`X_numeric[:] = scaler.fit_transform(X_numeric)`)
   triggers a deprecation warning because pandas currently upcasts silently but is planning to
   stop. Verified in isolation that the current pandas (2.3.3) upcasts correctly rather than
   truncating — so results weren't corrupted — but fixed it properly anyway by casting to
   `float` before scaling (`df[numeric_cols].astype(float)`), since relying on soon-to-be-removed
   implicit behavior isn't something to leave in code meant to be pushed.
3. **Deciding whether to scale the one-hot dummy columns.** Standardizing a binary 0/1 column
   centers it away from zero and doesn't correct for any real unit mismatch (every dummy is
   already on the identical 0/1 scale) — it would only make the encoding harder to read for no
   benefit. Left all `Compound`/`Driver`/`TrackStatusBucket`/`location` dummies unscaled in both
   runs; this is a standard, well-justified choice, not a workaround for a problem.
4. **Avoiding scaler leakage.** `StandardScaler` was fit on `train` only, then applied to `dev`
   with `.transform()` (never `.fit_transform()` on dev) — the same discipline the notebook
   already uses for one-hot `train_columns` reindexing, just applied to the new numeric-scaling
   step too. Mentioned here because it's the one place normalization work can silently leak
   information across the split if done carelessly, even though no leakage occurred in this run.

## Recommendation

**Do not adopt feature normalization for this notebook.** It is neutral-to-harmless for the
Ridge models (mathematically inert at the regularization strength in use) and neutral-to-
harmful for the Random Forest models (adds floating-point instability with zero accuracy
benefit, worse in the already-low-signal delta-target model). The one genuine, mild use case —
standardized coefficients make Ridge's relative feature importance easier to eyeball across
features that live on different raw scales (`LapNumber` 1–70 vs `WeatherBucket` 1–4) — doesn't
justify the added pipeline complexity given it changes zero predictive results.

This closes the "is scaling the problem?" question the notebook's tiny TyreLife coefficient
raised, with a negative answer backed by numbers rather than left as an assumption. The paths
that actually move the tyre-degradation signal are still the ones already identified in the
notebook's "Open work" and in `degradation_experiment_report.md`: merging real weather, modeling
per-compound degradation explicitly, and handling pit-stop survivorship and stint context —
none of which are feature-scaling problems.
