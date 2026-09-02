#!/usr/bin/env python3
"""Re-run the tyre-degradation modeling battery with normalized numeric
features (StandardScaler on TyreLife / WeatherBucket / LapNumber, fit on
train only), and compare every result against the raw-feature baseline from
Tyre_degradation.ipynb.

This mirrors that notebook's exact experiment design (same six models, same
CATEGORICAL_COLS, same alpha=1.0) so the only variable that changes is
whether numeric features are standardized before fitting. One-hot dummy
columns are deliberately left unscaled — see the report for why.

Run from the scripts/ directory: `python normalize_and_retrain.py`
"""
import pandas as pd
import numpy as np
from sklearn.linear_model import Ridge, RidgeCV
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error, r2_score

pd.set_option("display.width", 120)

# ---------------------------------------------------------------------------
# 1. Load + bucket track status (identical to the notebook)
# ---------------------------------------------------------------------------
train_df = pd.read_csv("../data/train.csv", low_memory=False)
dev_df = pd.read_csv("../data/dev.csv", low_memory=False)
print(f"train {train_df.shape}, dev {dev_df.shape}")


def track_status_bucket(status):
    status = str(status)
    if "5" in status:
        return "red"
    elif any(code in status for code in ("2", "4", "6", "7")):
        return "yellow"
    else:
        return "green"


train_df["TrackStatusBucket"] = train_df["TrackStatus"].apply(track_status_bucket)
dev_df["TrackStatusBucket"] = dev_df["TrackStatus"].apply(track_status_bucket)

CATEGORICAL_COLS = ["Compound", "Driver", "TrackStatusBucket", "location"]

# ---------------------------------------------------------------------------
# 2. build_matrix, extended with an optional StandardScaler
#
# Numeric columns are standardized; one-hot dummy columns are left as 0/1.
# Scaling a binary dummy would center it away from 0 (destroying the sparse
# "off" state that gives it a clean interpretation) and there is no unit
# mismatch between dummies to correct for — they're already all on the same
# 0/1 scale. The scaler is fit on TRAIN ONLY and reused (via `.transform`)
# on dev, exactly like `train_columns` reindexing already does for
# categories — fitting on train+dev together would leak dev statistics
# (its mean/std) into the model.
# ---------------------------------------------------------------------------
def build_matrix(df, numeric_cols, categorical_cols, train_columns=None,
                  target="LapTime", scaler=None, fit_scaler=False):
    # Cast to float up front: TyreLife/LapNumber/WeatherBucket are int64 in
    # the source CSVs, and assigning StandardScaler's float output into an
    # int64 column via `X_numeric[:] = ...` triggers a pandas FutureWarning
    # (silently upcasting for now, but slated to become an error) — cast
    # explicitly instead of relying on that implicit behavior.
    X_numeric = df[numeric_cols].astype(float).copy()
    if scaler is not None:
        if fit_scaler:
            X_numeric[:] = scaler.fit_transform(X_numeric)
        else:
            X_numeric[:] = scaler.transform(X_numeric)
    X = pd.concat([X_numeric, pd.get_dummies(df[categorical_cols])], axis=1)
    if train_columns is not None:
        X = X.reindex(columns=train_columns, fill_value=0)
    X = X.dropna()
    y = df[target].loc[X.index]
    return X, y


def unstandardize_coef(coef, scaler, numeric_cols, col_name):
    """Convert a coefficient fit on standardized units back to the original
    per-unit slope (e.g. seconds per lap of TyreLife), so it's comparable
    to the raw-feature notebook's coefficients."""
    idx = numeric_cols.index(col_name)
    return coef / scaler.scale_[idx]


results_raw = {}
results_norm = {}

# ---------------------------------------------------------------------------
# 3. Section 4 equivalent — Ridge baseline / no-driver / fuel-proxy,
#    fit twice: once on raw features (reproducing the notebook, as a check
#    this script's own pipeline is faithful) and once normalized.
# ---------------------------------------------------------------------------
def run_ridge_experiment(name, numeric_cols, categorical_cols, target="LapTime",
                          train_source=train_df, dev_source=dev_df, alpha=1.0):
    # raw
    X_tr, y_tr = build_matrix(train_source, numeric_cols, categorical_cols, target=target)
    X_dv, y_dv = build_matrix(dev_source, numeric_cols, categorical_cols,
                               train_columns=X_tr.columns, target=target)
    m_raw = Ridge(alpha=alpha).fit(X_tr, y_tr)
    pred = m_raw.predict(X_dv)
    r2_raw = r2_score(y_dv, pred)
    mse_raw = mean_squared_error(y_dv, pred)

    # normalized
    scaler = StandardScaler()
    X_tr_n, y_tr_n = build_matrix(train_source, numeric_cols, categorical_cols, target=target,
                                   scaler=scaler, fit_scaler=True)
    X_dv_n, y_dv_n = build_matrix(dev_source, numeric_cols, categorical_cols,
                                   train_columns=X_tr_n.columns, target=target,
                                   scaler=scaler, fit_scaler=False)
    m_norm = Ridge(alpha=alpha).fit(X_tr_n, y_tr_n)
    pred_n = m_norm.predict(X_dv_n)
    r2_norm = r2_score(y_dv_n, pred_n)
    mse_norm = mean_squared_error(y_dv_n, pred_n)

    print(f"\n--- {name} ---")
    print(f"  raw        dev MSE={mse_raw:.4f}  R2={r2_raw:.4f}")
    print(f"  normalized dev MSE={mse_norm:.4f}  R2={r2_norm:.4f}")

    tyre_life_raw = None
    tyre_life_norm_std = None
    tyre_life_norm_physical = None
    if "TyreLife" in numeric_cols:
        tyre_life_raw = m_raw.coef_[list(X_tr.columns).index("TyreLife")]
        tyre_life_norm_std = m_norm.coef_[list(X_tr_n.columns).index("TyreLife")]
        tyre_life_norm_physical = unstandardize_coef(
            tyre_life_norm_std, scaler, numeric_cols, "TyreLife"
        )
        print(f"  TyreLife coef  raw={tyre_life_raw:+.4f} s/lap   "
              f"normalized(std units)={tyre_life_norm_std:+.4f}   "
              f"normalized(converted back to s/lap)={tyre_life_norm_physical:+.4f}")

    return {
        "raw": {"mse": mse_raw, "r2": r2_raw, "tyrelife_coef": tyre_life_raw},
        "normalized": {
            "mse": mse_norm, "r2": r2_norm,
            "tyrelife_coef_std": tyre_life_norm_std,
            "tyrelife_coef_physical": tyre_life_norm_physical,
        },
        "models": (m_raw, m_norm, scaler, list(X_tr.columns), list(X_tr_n.columns)),
    }


res_baseline = run_ridge_experiment(
    "4a Ridge baseline", ["TyreLife", "WeatherBucket"], CATEGORICAL_COLS)

res_nodriver = run_ridge_experiment(
    "4b Ridge no-driver", ["TyreLife", "WeatherBucket"],
    ["Compound", "TrackStatusBucket", "location"])

res_fuel = run_ridge_experiment(
    "4c Ridge fuel-proxy", ["TyreLife", "WeatherBucket", "LapNumber"], CATEGORICAL_COLS)

# ---------------------------------------------------------------------------
# 4. Section 5 equivalent — Random Forest, raw vs normalized.
#    Trees split on `feature <= threshold`; a monotonic rescaling of a
#    numeric column just rescales the threshold by the same factor, so the
#    *splits chosen* (and therefore every prediction) are identical. This
#    run exists to confirm that empirically, not because normalization is
#    expected to change anything here.
# ---------------------------------------------------------------------------
numeric_cols_fuel = ["TyreLife", "WeatherBucket", "LapNumber"]

X_tr_raw, y_tr_raw = build_matrix(train_df, numeric_cols_fuel, CATEGORICAL_COLS)
X_dv_raw, y_dv_raw = build_matrix(dev_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                   train_columns=X_tr_raw.columns)
rf_raw = RandomForestRegressor(n_estimators=100, min_samples_leaf=2, random_state=42, n_jobs=-1)
rf_raw.fit(X_tr_raw, y_tr_raw)
pred_rf_raw = rf_raw.predict(X_dv_raw)
r2_rf_raw = r2_score(y_dv_raw, pred_rf_raw)
mse_rf_raw = mean_squared_error(y_dv_raw, pred_rf_raw)

scaler_rf = StandardScaler()
X_tr_norm, y_tr_norm = build_matrix(train_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                     scaler=scaler_rf, fit_scaler=True)
X_dv_norm, y_dv_norm = build_matrix(dev_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                     train_columns=X_tr_norm.columns,
                                     scaler=scaler_rf, fit_scaler=False)
rf_norm = RandomForestRegressor(n_estimators=100, min_samples_leaf=2, random_state=42, n_jobs=-1)
rf_norm.fit(X_tr_norm, y_tr_norm)
pred_rf_norm = rf_norm.predict(X_dv_norm)
r2_rf_norm = r2_score(y_dv_norm, pred_rf_norm)
mse_rf_norm = mean_squared_error(y_dv_norm, pred_rf_norm)

print("\n--- 5 Random Forest ---")
print(f"  raw        dev MSE={mse_rf_raw:.4f}  R2={r2_rf_raw:.4f}")
print(f"  normalized dev MSE={mse_rf_norm:.4f}  R2={r2_rf_norm:.4f}")
print(f"  identical predictions? {np.allclose(pred_rf_raw, pred_rf_norm, atol=1e-6)}")

# ---------------------------------------------------------------------------
# 5. Section 6 equivalent — pace-delta target, raw vs normalized, Ridge + RF.
# ---------------------------------------------------------------------------
def add_delta_target(df):
    df = df.copy()
    green = df[df["TrackStatusBucket"] == "green"]
    df["PersonalBest"] = green.groupby(["Driver", "year", "location"])["LapTime"].transform("min")
    df["PersonalBest"] = df.groupby(["Driver", "year", "location"])["PersonalBest"].transform("min")
    df["LapTimeDelta"] = df["LapTime"] - df["PersonalBest"]
    return df[df["LapTimeDelta"].notna()]


train_delta_df = add_delta_target(train_df)
dev_delta_df = add_delta_target(dev_df)
print(f"\ntrain {len(train_delta_df)} laps, dev {len(dev_delta_df)} laps with a delta target")

res_delta = run_ridge_experiment(
    "6 Ridge delta", numeric_cols_fuel, CATEGORICAL_COLS, target="LapTimeDelta",
    train_source=train_delta_df, dev_source=dev_delta_df)

X_tr_d_raw, y_tr_d_raw = build_matrix(train_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                       target="LapTimeDelta")
X_dv_d_raw, y_dv_d_raw = build_matrix(dev_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                       train_columns=X_tr_d_raw.columns, target="LapTimeDelta")
rf_delta_raw = RandomForestRegressor(n_estimators=100, min_samples_leaf=2, random_state=42, n_jobs=-1)
rf_delta_raw.fit(X_tr_d_raw, y_tr_d_raw)
pred_rf_delta_raw = rf_delta_raw.predict(X_dv_d_raw)
r2_rf_delta_raw = r2_score(y_dv_d_raw, pred_rf_delta_raw)
mse_rf_delta_raw = mean_squared_error(y_dv_d_raw, pred_rf_delta_raw)

scaler_rf_delta = StandardScaler()
X_tr_d_norm, y_tr_d_norm = build_matrix(train_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                         target="LapTimeDelta", scaler=scaler_rf_delta, fit_scaler=True)
X_dv_d_norm, y_dv_d_norm = build_matrix(dev_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                         train_columns=X_tr_d_norm.columns, target="LapTimeDelta",
                                         scaler=scaler_rf_delta, fit_scaler=False)
rf_delta_norm = RandomForestRegressor(n_estimators=100, min_samples_leaf=2, random_state=42, n_jobs=-1)
rf_delta_norm.fit(X_tr_d_norm, y_tr_d_norm)
pred_rf_delta_norm = rf_delta_norm.predict(X_dv_d_norm)
r2_rf_delta_norm = r2_score(y_dv_d_norm, pred_rf_delta_norm)
mse_rf_delta_norm = mean_squared_error(y_dv_d_norm, pred_rf_delta_norm)

print("\n--- RF delta ---")
print(f"  raw        dev MSE={mse_rf_delta_raw:.4f}  R2={r2_rf_delta_raw:.4f}")
print(f"  normalized dev MSE={mse_rf_delta_norm:.4f}  R2={r2_rf_delta_norm:.4f}")

rf_delta_imp_raw = pd.Series(rf_delta_raw.feature_importances_, index=X_tr_d_raw.columns).sort_values(ascending=False)
rf_delta_imp_norm = pd.Series(rf_delta_norm.feature_importances_, index=X_tr_d_norm.columns).sort_values(ascending=False)
print("\nTop-5 RF-delta importances, raw:")
print(rf_delta_imp_raw.head(5).to_string())
print("\nTop-5 RF-delta importances, normalized:")
print(rf_delta_imp_norm.head(5).to_string())

# ---------------------------------------------------------------------------
# 6. Was alpha=1.0 still reasonable after standardizing? A quick RidgeCV
#    sweep on the fuel-proxy feature set (both targets) answers that
#    directly instead of assuming the old default still applies.
# ---------------------------------------------------------------------------
print("\n--- RidgeCV alpha check (normalized features) ---")
alphas = np.logspace(-2, 3, 12)

scaler_cv = StandardScaler()
X_tr_cv, y_tr_cv = build_matrix(train_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                 scaler=scaler_cv, fit_scaler=True)
ridge_cv = RidgeCV(alphas=alphas).fit(X_tr_cv, y_tr_cv)
print(f"  absolute target  best alpha = {ridge_cv.alpha_:.4g}")

scaler_cv_delta = StandardScaler()
X_tr_cv_d, y_tr_cv_d = build_matrix(train_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                     target="LapTimeDelta", scaler=scaler_cv_delta, fit_scaler=True)
ridge_cv_delta = RidgeCV(alphas=alphas).fit(X_tr_cv_d, y_tr_cv_d)
print(f"  delta target     best alpha = {ridge_cv_delta.alpha_:.4g}")

# Re-fit + score dev with the CV-selected alpha to see if it actually helps.
X_dv_cv, y_dv_cv = build_matrix(dev_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                 train_columns=X_tr_cv.columns, scaler=scaler_cv, fit_scaler=False)
pred_cv = ridge_cv.predict(X_dv_cv)
print(f"  absolute target  dev R2 at best alpha = {r2_score(y_dv_cv, pred_cv):.4f}  "
      f"(alpha=1.0 was {res_fuel['normalized']['r2']:.4f})")

X_dv_cv_d, y_dv_cv_d = build_matrix(dev_delta_df, numeric_cols_fuel, CATEGORICAL_COLS,
                                     train_columns=X_tr_cv_d.columns, target="LapTimeDelta",
                                     scaler=scaler_cv_delta, fit_scaler=False)
pred_cv_d = ridge_cv_delta.predict(X_dv_cv_d)
print(f"  delta target     dev R2 at best alpha = {r2_score(y_dv_cv_d, pred_cv_d):.4f}  "
      f"(alpha=1.0 was {res_delta['normalized']['r2']:.4f})")

# ---------------------------------------------------------------------------
# 7. Final comparison table
# ---------------------------------------------------------------------------
print("\n\n=== SUMMARY: dev R2, raw vs normalized ===")
summary = pd.DataFrame({
    "model": ["ridge baseline", "ridge no-driver", "ridge fuel-proxy", "random forest",
              "ridge (delta)", "random forest (delta)"],
    "target": ["LapTime"] * 4 + ["LapTimeDelta"] * 2,
    "raw dev R2": [res_baseline["raw"]["r2"], res_nodriver["raw"]["r2"], res_fuel["raw"]["r2"],
                   r2_rf_raw, res_delta["raw"]["r2"], r2_rf_delta_raw],
    "normalized dev R2": [res_baseline["normalized"]["r2"], res_nodriver["normalized"]["r2"],
                          res_fuel["normalized"]["r2"], r2_rf_norm,
                          res_delta["normalized"]["r2"], r2_rf_delta_norm],
}).set_index("model")
print(summary.round(4).to_string())
