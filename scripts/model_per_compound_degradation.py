#!/usr/bin/env python3
"""Fit tyre-degradation models SEPARATELY per compound (SOFT/MEDIUM/HARD/
INTERMEDIATE/WET), instead of one shared model with Compound as a dummy
column, on the enriched features (real weather, traffic, stint/fuel
context, team_pace) against the pace-delta target.

This is the direct follow-up to notes/enriched_degradation_report.md's
"Recommendation / next steps" item: a shared model has to compromise across
compounds whose degradation shapes clearly differ (see that report's
per-compound curve table). Splitting by compound lets each model fit its
own shape, and — for WET specifically — surfaces a real data limitation
(zero dev rows) explicitly instead of burying it inside a shared model's
aggregate dev score.

Requires data/train_enriched.csv and data/dev_enriched.csv (run
enrich_data.py first, which itself requires clean_data.py's output).
Run from scripts/: `python model_per_compound_degradation.py`
"""
import pandas as pd
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

pd.set_option("display.width", 120)

train_df = pd.read_csv("../data/train_enriched.csv", low_memory=False)
dev_df = pd.read_csv("../data/dev_enriched.csv", low_memory=False)

train_df["gap_ahead"] = train_df["gap_ahead"].fillna(200.0)
dev_df["gap_ahead"] = dev_df["gap_ahead"].fillna(200.0)
train_df = train_df[train_df["LapTimeDelta"].notna()]
dev_df = dev_df[dev_df["LapTimeDelta"].notna()]
print(f"train {len(train_df)} laps, dev {len(dev_df)} laps with a delta target")

print("\ncompound support:")
print(pd.DataFrame({
    "train": train_df["Compound"].value_counts(),
    "dev": dev_df["Compound"].value_counts(),
}).fillna(0).astype(int))

# Compound is fixed within each per-compound subset, so it's dropped from
# the feature list here (unlike model_enriched_degradation.py, which needs
# it to tell compounds apart in one shared model).
NUMERIC_COLS = [
    "TyreLife", "LapNumber", "TrackTemp", "AirTemp", "Humidity", "WindSpeed",
    "gap_ahead", "lap_in_stint", "stint_start_tyre_age", "laps_remaining", "team_pace",
]
CATEGORICAL_COLS = ["TrackStatusBucket", "location", "Rainfall", "clean_air"]


def build_matrix(df, train_columns=None, target="LapTimeDelta"):
    X = pd.concat([df[NUMERIC_COLS], pd.get_dummies(df[CATEGORICAL_COLS])], axis=1)
    if train_columns is not None:
        X = X.reindex(columns=train_columns, fill_value=0)
    X = X.dropna()
    y = df[target].loc[X.index]
    return X, y


def degradation_curve(model, X_ref, sweep_points=(1, 5, 10, 15, 20, 25, 30)):
    """Median predicted delta at each TyreLife, holding every other feature
    at each real row's own value (same methodology as the shared-model
    report, so the two are directly comparable)."""
    curve = {}
    for tl in sweep_points:
        sweep = X_ref.copy()
        sweep["TyreLife"] = tl
        curve[tl] = np.median(model.predict(sweep))
    return curve


results = []
curves = {}
COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]

for compound in COMPOUNDS:
    train_sub = train_df[train_df["Compound"] == compound]
    dev_sub = dev_df[dev_df["Compound"] == compound]
    print(f"\n=== {compound}: {len(train_sub)} train laps, {len(dev_sub)} dev laps ===")

    if len(train_sub) < 100:
        print("  too few train laps to fit anything meaningful — skipped.")
        continue

    X_train, y_train = build_matrix(train_sub)

    if len(dev_sub) == 0:
        # WET, per the audit: real train rows, zero dev rows. Fitting a
        # model and reporting a dev R2 for it would fabricate a number
        # that doesn't exist — report train-only diagnostics instead and
        # flag the limitation, per this project's established convention
        # (see enriched_degradation_report.md's INTERMEDIATE discussion).
        hgb = HistGradientBoostingRegressor(
            max_iter=100, min_samples_leaf=30, max_depth=3, l2_regularization=5.0, random_state=42
        )
        hgb.fit(X_train, y_train)
        train_pred = hgb.predict(X_train)
        train_r2 = r2_score(y_train, train_pred)
        train_mae = mean_absolute_error(y_train, train_pred)
        print(f"  NO DEV ROWS for {compound} — cannot report a held-out metric.")
        print(f"  train-only diagnostic (fit, not validated): R2={train_r2:.4f}  MAE={train_mae:.4f}")
        curves[compound] = degradation_curve(hgb, X_train)
        results.append({
            "compound": compound, "train_n": len(train_sub), "dev_n": 0,
            "dev_r2": np.nan, "dev_mae": np.nan, "tyre_coef": np.nan,
            "note": "no dev support — train-only diagnostic, not validated",
        })
        continue

    X_dev, y_dev = build_matrix(dev_sub, train_columns=X_train.columns)

    # Ridge, for the TyreLife coefficient (interpretable, if the effect is
    # roughly linear for this compound).
    ridge = Ridge(alpha=1.0).fit(X_train, y_train)
    tyre_coef = ridge.coef_[list(X_train.columns).index("TyreLife")]

    # HGB with a monotonic-increasing TyreLife constraint as the primary
    # model — this helped (rather than cost accuracy) in the shared-model
    # report, so it's the default here too. Regularized much harder than
    # the shared model (min_samples_leaf 200 vs 50, max_depth capped at 3,
    # l2_regularization=5.0): splitting by compound cuts each model's
    # training set to a fraction of the shared one, with far fewer distinct
    # races/locations to average noise over, and the shared model's
    # hyperparameters badly overfit at that size — see
    # notes/per_compound_degradation_report.md for the before/after numbers
    # that motivated this.
    tyre_idx = list(X_train.columns).index("TyreLife")
    monotonic_cst = [1 if i == tyre_idx else 0 for i in range(X_train.shape[1])]
    hgb = HistGradientBoostingRegressor(
        max_iter=100, min_samples_leaf=200, max_depth=3, l2_regularization=5.0,
        random_state=42, monotonic_cst=monotonic_cst
    )
    hgb.fit(X_train, y_train)
    pred = hgb.predict(X_dev)
    dev_r2 = r2_score(y_dev, pred)
    dev_mae = mean_absolute_error(y_dev, pred)
    print(f"  Ridge TyreLife coef={tyre_coef:+.4f} s/lap")
    print(f"  HGB (monotonic TyreLife) dev R2={dev_r2:.4f}  MAE={dev_mae:.4f}")

    curves[compound] = degradation_curve(hgb, X_dev)
    curve_str = "  ".join(f"lap{k}={v:.2f}s" for k, v in curves[compound].items())
    print(f"  degradation curve: {curve_str}")

    results.append({
        "compound": compound, "train_n": len(train_sub), "dev_n": len(dev_sub),
        "dev_r2": dev_r2, "dev_mae": dev_mae, "tyre_coef": tyre_coef, "note": "",
    })

print("\n\n=== SUMMARY: per-compound models ===")
summary = pd.DataFrame(results).set_index("compound")
print(summary.round(4).to_string())

print("\n=== Degradation curves (median predicted delta, s) ===")
curve_df = pd.DataFrame(curves).T
print(curve_df.round(2).to_string())

print("\nFor comparison, the shared model (all compounds, Compound as a dummy) from "
      "notes/enriched_degradation_report.md: HGB+monotonic dev R2=0.3531, MAE=1.036s")
