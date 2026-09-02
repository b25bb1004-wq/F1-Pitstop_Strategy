#!/usr/bin/env python3
"""Model tyre degradation on the enriched features (real weather, traffic,
stint/fuel context, team_pace) against the pace-delta target, making
permanent (and reproducing, on the now-round_number-fixed data) the
approach notes/degradation_experiment_report.md first tried as
session-temporary scratch scripts.

Requires data/train_enriched.csv and data/dev_enriched.csv (run
enrich_data.py first). Run from scripts/: `python model_enriched_degradation.py`
"""
import pandas as pd
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

pd.set_option("display.width", 120)

train_df = pd.read_csv("../data/train_enriched.csv", low_memory=False)
dev_df = pd.read_csv("../data/dev_enriched.csv", low_memory=False)

# rows with no green-flag lap that race have no delta target; rows with no
# car ahead have no gap_ahead - fill that one rather than drop (being alone
# on track is real, common information, not missing data)
train_df["gap_ahead"] = train_df["gap_ahead"].fillna(200.0)
dev_df["gap_ahead"] = dev_df["gap_ahead"].fillna(200.0)
train_df = train_df[train_df["LapTimeDelta"].notna()]
dev_df = dev_df[dev_df["LapTimeDelta"].notna()]
print(f"train {len(train_df)} laps, dev {len(dev_df)} laps with a delta target")

NUMERIC_COLS = [
    "TyreLife", "LapNumber", "TrackTemp", "AirTemp", "Humidity", "WindSpeed",
    "gap_ahead", "lap_in_stint", "stint_start_tyre_age", "laps_remaining", "team_pace",
]
CATEGORICAL_COLS = ["Compound", "TrackStatusBucket", "location", "Rainfall", "clean_air"]


def build_matrix(df, train_columns=None, target="LapTimeDelta"):
    X = pd.concat([df[NUMERIC_COLS], pd.get_dummies(df[CATEGORICAL_COLS])], axis=1)
    if train_columns is not None:
        X = X.reindex(columns=train_columns, fill_value=0)
    X = X.dropna()
    y = df[target].loc[X.index]
    return X, y


X_train, y_train = build_matrix(train_df)
X_dev, y_dev = build_matrix(dev_df, train_columns=X_train.columns)
print(f"feature matrix: train {X_train.shape}, dev {X_dev.shape}")

# ---------------------------------------------------------------------------
# Ridge, linear reference.
# ---------------------------------------------------------------------------
ridge = Ridge(alpha=1.0).fit(X_train, y_train)
pred_ridge = ridge.predict(X_dev)
r2_ridge = r2_score(y_dev, pred_ridge)
mae_ridge = mean_absolute_error(y_dev, pred_ridge)
tyre_coef = ridge.coef_[list(X_train.columns).index("TyreLife")]
print(f"\n--- Ridge, enriched features ---")
print(f"dev R2={r2_ridge:.4f}  MAE={mae_ridge:.4f}  TyreLife coef={tyre_coef:+.4f} s/lap")

# ---------------------------------------------------------------------------
# HistGradientBoostingRegressor, unconstrained.
# ---------------------------------------------------------------------------
hgb = HistGradientBoostingRegressor(max_iter=500, min_samples_leaf=50, random_state=42)
hgb.fit(X_train, y_train)
pred_hgb = hgb.predict(X_dev)
r2_hgb = r2_score(y_dev, pred_hgb)
mae_hgb = mean_absolute_error(y_dev, pred_hgb)
print(f"\n--- HistGradientBoosting, enriched features ---")
print(f"dev R2={r2_hgb:.4f}  MAE={mae_hgb:.4f}")

# ---------------------------------------------------------------------------
# HGB with a monotonic-increasing constraint on TyreLife (degradation should
# never make the car faster) - a trade against the real warm-up dip, per
# the July report; kept for direct comparison.
# ---------------------------------------------------------------------------
tyre_idx = list(X_train.columns).index("TyreLife")
monotonic_cst = [1 if i == tyre_idx else 0 for i in range(X_train.shape[1])]
hgb_mono = HistGradientBoostingRegressor(
    max_iter=500, min_samples_leaf=50, random_state=42, monotonic_cst=monotonic_cst
)
hgb_mono.fit(X_train, y_train)
pred_hgb_mono = hgb_mono.predict(X_dev)
r2_hgb_mono = r2_score(y_dev, pred_hgb_mono)
mae_hgb_mono = mean_absolute_error(y_dev, pred_hgb_mono)
print(f"\n--- HGB + monotonic TyreLife constraint ---")
print(f"dev R2={r2_hgb_mono:.4f}  MAE={mae_hgb_mono:.4f}")

# ---------------------------------------------------------------------------
# Permutation importance (unconstrained HGB) - which features the model
# actually leans on, on real held-out data rather than training-set gain.
# ---------------------------------------------------------------------------
print("\n--- Permutation importance (HGB, dev set, 10 repeats) ---")
perm = permutation_importance(hgb, X_dev, y_dev, n_repeats=10, random_state=42, n_jobs=-1)
imp = pd.Series(perm.importances_mean, index=X_dev.columns).sort_values(ascending=False)
print(imp.head(12).to_string())
tyre_rank = list(imp.index).index("TyreLife") + 1
print(f"\nTyreLife importance: {imp['TyreLife']:.4f} (rank {tyre_rank} of {len(imp)})")

# ---------------------------------------------------------------------------
# Degradation curves per compound: sweep TyreLife 1->30 on real dev laps,
# holding every other feature at that lap's own actual value, and take the
# median predicted delta at each TyreLife value. This shows the model's
# *learned* degradation shape, not just a single slope number.
# ---------------------------------------------------------------------------
print("\n--- Degradation curves per compound (HGB, unconstrained) ---")
compound_cols = [c for c in X_dev.columns if c.startswith("Compound_")]
for compound_col in compound_cols:
    compound_name = compound_col.replace("Compound_", "")
    mask = X_dev[compound_col] == 1
    if mask.sum() < 200:
        continue
    subset = X_dev[mask].copy()
    curve = {}
    for tl in [1, 5, 10, 15, 20, 25, 30]:
        sweep = subset.copy()
        sweep["TyreLife"] = tl
        preds = hgb.predict(sweep)
        curve[tl] = np.median(preds)
    print(f"{compound_name:12s} " + "  ".join(f"lap{k}={v:.2f}s" for k, v in curve.items()))

print("\n\n=== SUMMARY ===")
summary = pd.DataFrame({
    "model": ["Ridge (enriched)", "HGB (enriched)", "HGB + monotonic TyreLife"],
    "dev R2": [r2_ridge, r2_hgb, r2_hgb_mono],
    "dev MAE": [mae_ridge, mae_hgb, mae_hgb_mono],
}).set_index("model")
print(summary.round(4).to_string())
print(f"\nFor comparison, notebook baseline (LapTime target, no enrichment): dev R2=0.9103 (but ~90% circuit lookup)")
print(f"July experiment (scratch, same approach): Ridge delta R2=0.293, HGB delta R2=0.380")
