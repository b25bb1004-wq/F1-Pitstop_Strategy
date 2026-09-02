#!/usr/bin/env python3
"""Fit an explicit, interpretable equation connecting raw LapTime to TyreLife
(degradation) and fuel load, separately per tyre Compound:

    LapTime = intercept
              + tyre_coef * TyreLife
              + fuel_coef * laps_remaining
              + stint_coef * stint_start_tyre_age
              + circuit/car controls (location dummies + team_pace)

This is deliberately on raw LapTime, not the LapTimeDelta target every other
model script in this project uses — the pace-delta target already subtracts
out circuit+driver baseline from the *target*, which is the right choice for
prediction accuracy, but it makes "how many seconds does a lap of tyre wear
cost" harder to read directly off a coefficient. Here the same job (removing
circuit/car speed as a confound) is done by *controlling for it as a
feature* (location dummies + team_pace) instead, so TyreLife's and
laps_remaining's coefficients can be read directly as seconds/lap on the
actual lap time.

Restricted to green-flag laps only (TrackStatusBucket == 'green') — a
Safety Car or red-flag lap's LapTime reflects the incident, not tyre wear or
fuel load, and would otherwise swamp both coefficients.

Uses only TyreLife and laps_remaining as the tyre/fuel terms — NOT
lap_in_stint or stint_start_tyre_age, which enrich_data.py defines as
`stint_start_tyre_age = TyreLife - lap_in_stint + 1`, an exact linear
identity. Putting all three in one regression together is perfectly
multicollinear (confirmed directly: max abs residual of that identity is
0.0 on real data), so Ridge splits credit between them arbitrarily and the
TyreLife coefficient becomes an artifact of the regularization rather than
a real number — this was caught by a first run of this script producing
backwards-signed, wildly inconsistent-across-compound TyreLife coefficients
before this fix. TyreLife and laps_remaining alone are correlated (-0.44)
but nowhere near collinear, so that pair is safe to interpret directly.

Requires data/train_enriched.csv and data/dev_enriched.csv (run
clean_data.py then enrich_data.py first). Run from scripts/:
`python model_laptime_tyrelife_fuel.py`
"""
import pandas as pd
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error

pd.set_option("display.width", 120)

train_df = pd.read_csv("../data/train_enriched.csv", low_memory=False)
dev_df = pd.read_csv("../data/dev_enriched.csv", low_memory=False)

train_df = train_df[train_df["TrackStatusBucket"] == "green"].copy()
dev_df = dev_df[dev_df["TrackStatusBucket"] == "green"].copy()
print(f"green-flag laps: train {len(train_df)}, dev {len(dev_df)}")

FUEL_TYRE_COLS = ["TyreLife", "laps_remaining"]
CONTROL_NUMERIC = ["team_pace"]
CONTROL_CATEGORICAL = ["location"]


def build_matrix(df, train_columns=None):
    numeric = FUEL_TYRE_COLS + CONTROL_NUMERIC
    X = pd.concat([df[numeric], pd.get_dummies(df[CONTROL_CATEGORICAL])], axis=1)
    if train_columns is not None:
        X = X.reindex(columns=train_columns, fill_value=0)
    X = X.dropna()
    y = df["LapTime"].loc[X.index]
    return X, y


COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]
rows = []

print("\n=== Per-compound equation: LapTime = f(TyreLife, fuel) | circuit + car controlled for ===")
for compound in COMPOUNDS:
    train_sub = train_df[train_df["Compound"] == compound]
    dev_sub = dev_df[dev_df["Compound"] == compound]
    if len(train_sub) < 100:
        print(f"\n{compound}: {len(train_sub)} train laps — too few, skipped.")
        continue

    X_train, y_train = build_matrix(train_sub)
    ridge = Ridge(alpha=1.0).fit(X_train, y_train)
    coefs = dict(zip(X_train.columns, ridge.coef_))

    print(f"\n{compound}: {len(train_sub)} train laps, {len(dev_sub)} dev laps")
    print(f"  TyreLife            {coefs['TyreLife']:+.4f} s/lap  (degradation: cost per lap of tyre age)")
    print(f"  laps_remaining      {coefs['laps_remaining']:+.4f} s/lap  (fuel: cost per lap still to burn)")

    row = {
        "compound": compound, "train_n": len(train_sub), "dev_n": len(dev_sub),
        "tyre_coef": coefs["TyreLife"], "fuel_coef": coefs["laps_remaining"],
    }

    if len(dev_sub) > 0:
        X_dev, y_dev = build_matrix(dev_sub, train_columns=X_train.columns)
        pred = ridge.predict(X_dev)
        dev_r2 = r2_score(y_dev, pred)
        dev_mae = mean_absolute_error(y_dev, pred)
        print(f"  dev R2={dev_r2:.4f}  MAE={dev_mae:.4f}")
        row["dev_r2"] = dev_r2
        row["dev_mae"] = dev_mae
    else:
        print(f"  NO DEV ROWS for {compound} — coefficients above are train-only, not validated.")
        row["dev_r2"] = np.nan
        row["dev_mae"] = np.nan

    rows.append(row)

print("\n\n=== Combined equation: LapTime = f(TyreLife, fuel, Compound) | circuit + car controlled for ===")
X_train_all = pd.concat([
    train_df[FUEL_TYRE_COLS + CONTROL_NUMERIC],
    pd.get_dummies(train_df[CONTROL_CATEGORICAL + ["Compound"]]),
], axis=1).dropna()
y_train_all = train_df["LapTime"].loc[X_train_all.index]

X_dev_all = pd.concat([
    dev_df[FUEL_TYRE_COLS + CONTROL_NUMERIC],
    pd.get_dummies(dev_df[CONTROL_CATEGORICAL + ["Compound"]]),
], axis=1).reindex(columns=X_train_all.columns, fill_value=0).dropna()
y_dev_all = dev_df["LapTime"].loc[X_dev_all.index]

ridge_all = Ridge(alpha=1.0).fit(X_train_all, y_train_all)
pred_all = ridge_all.predict(X_dev_all)
r2_all = r2_score(y_dev_all, pred_all)
mae_all = mean_absolute_error(y_dev_all, pred_all)
coefs_all = dict(zip(X_train_all.columns, ridge_all.coef_))
print(f"train {X_train_all.shape}, dev {X_dev_all.shape}")
print(f"dev R2={r2_all:.4f}  MAE={mae_all:.4f}")
print(f"  TyreLife (shared slope across compounds): {coefs_all['TyreLife']:+.4f} s/lap")
print(f"  laps_remaining (fuel):                    {coefs_all['laps_remaining']:+.4f} s/lap")
compound_cols = sorted(c for c in coefs_all if c.startswith("Compound_"))
print("  Compound intercept shifts (relative to the dropped reference level, i.e. one-hot collinearity"
      " absorbed into the intercept — read these as relative, not absolute):")
for c in compound_cols:
    print(f"    {c:20s} {coefs_all[c]:+.4f} s")

print("\n\n=== SUMMARY: per-compound LapTime equations ===")
summary = pd.DataFrame(rows).set_index("compound")
print(summary.round(4).to_string())

print(f"\nCombined shared-slope model for comparison: dev R2={r2_all:.4f}  MAE={mae_all:.4f}")
