#!/usr/bin/env python3
"""Stage 6: honest evaluation on held-out seasons.

Protocol: fit on 2021-2023, choose anything tunable on 2024 (dev), then refit
on 2021-2024 and report 2025 (test) once. Every number in reports/ comes
from this script.

1. Lap-time prediction
   a. pre-race (conditions only, no laps of this race seen)
   b. in-race (laps up to k seen, predict every later lap) vs baselines
2. Pit loss prediction for the unseen season
3. Race-time simulation: predicted vs actual time over a driver's remaining
   green laps and stops, from lap 10
4. Pit decision backtest against what teams actually did, plus imitation
   classifiers in the style of published per-lap pit predictors
"""
import json
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score

from pitwall.config import DEV_YEARS, DRY, REPORT_DIR, TEST_YEARS, TRAIN_YEARS
from pitwall.pitstops import GREEN, SC, VSC, pit_events, transition_matrix
from pitwall.strategy import DECISION, RaceState, lap_cost_table, pit_losses, solve
from pitwall.train import fit_bundle, load_features

COMP_CODE = {c: i for i, c in enumerate(DRY)}


def mae(a, b):
    m = np.isfinite(a) & np.isfinite(b)
    return float(np.mean(np.abs(a[m] - b[m])))


def rmse(a, b):
    m = np.isfinite(a) & np.isfinite(b)
    return float(np.sqrt(np.mean((a[m] - b[m]) ** 2)))


# --------------------------------------------------------------- 1a pre-race
def add_form(df):
    """Pre-race information only: each team's/driver's pace relative to the
    field in their previous 4 races, and the circuit's previous race pace."""
    rep = df[df["rep"]]
    order = df.groupby("race_id")[["year", "round"]].first().sort_values(["year", "round"]).index
    pos = {r: i for i, r in enumerate(order)}
    rel = (rep.assign(rel=rep["LapTime"] / rep["race_ref"])
           .groupby(["race_id", "Team"])["rel"].median().reset_index())
    rel["t"] = rel["race_id"].map(pos)
    rel = rel.sort_values("t")
    rel["team_form"] = rel.groupby("Team")["rel"].transform(lambda s: s.shift().rolling(4, 1).mean())
    drel = (rep.assign(rel=rep["LapTime"] / rep["race_ref"])
            .groupby(["race_id", "Driver"])["rel"].median().reset_index())
    drel["t"] = drel["race_id"].map(pos)
    drel = drel.sort_values("t")
    drel["driver_form"] = drel.groupby("Driver")["rel"].transform(lambda s: s.shift().rolling(4, 1).mean())
    ref = df.groupby("race_id").agg(circuit=("circuit", "first"), race_ref=("race_ref", "first")).reset_index()
    ref["t"] = ref["race_id"].map(pos)
    ref = ref.sort_values("t")
    ref["prev_ref"] = ref.groupby("circuit")["race_ref"].shift()
    out = df.merge(rel[["race_id", "Team", "team_form"]], on=["race_id", "Team"], how="left")
    out = out.merge(drel[["race_id", "Driver", "driver_form"]], on=["race_id", "Driver"], how="left")
    return out.merge(ref[["race_id", "prev_ref"]], on="race_id", how="left")


PRE_NUM = ["year", "age", "fuel_kg", "lap_in_stint", "Stint", "TrackTemp", "AirTemp", "Humidity",
           "WindSpeed", "gap_ahead", "Position", "team_form", "driver_form", "prev_ref"]
PRE_CAT = ["circuit", "Team", "Driver", "Compound"]


def prerace_base_model(model, rep_fit, half_life=1.0):
    """Pre-race base pace: a ridge over the structural model's fitted
    driver-race base paces on circuit + driver + team, recent seasons weighted
    up (half-life in years, 1.0 chosen on dev)."""
    info = rep_fit.groupby(["race_id", "Driver"])[["circuit", "Team", "year"]].first()
    fe = pd.Series({k[1]: v for k, v in model.coef.items() if k[0] == "fe"})
    info = info.loc[info.index.intersection(fe.index)]
    X = pd.get_dummies(info.reset_index()[["circuit", "Driver", "Team"]].astype(str))
    w = 0.5 ** ((info["year"].max() - info["year"]) / half_life)
    ridge = Ridge(alpha=0.3).fit(X, fe.loc[info.index].to_numpy(), sample_weight=w.to_numpy())

    def predict(rows):
        Xt = pd.get_dummies(rows[["circuit", "Driver", "Team"]].astype(str)).reindex(columns=X.columns, fill_value=0)
        return ridge.predict(Xt) + model.predict_global(rows)
    return predict


def prerace_eval(df, fit_years, eval_years, model):
    rep = add_form(df[df["rep"]])
    tr, te = rep[rep["year"].isin(fit_years)], rep[rep["year"].isin(eval_years)]
    out = {"prerace_structural": _reg_metrics(te["LapTime"].to_numpy(),
                                              prerace_base_model(model, tr)(te))}
    # previous Pitwall model: Ridge on one-hot circuit/driver/compound + tyre age + lap number
    cols = ["circuit", "Driver", "Compound"]
    Xtr = pd.get_dummies(tr[cols].astype(str)).assign(age=tr["age"], lap=tr["LapNumber"])
    Xte = pd.get_dummies(te[cols].astype(str)).reindex(columns=Xtr.columns[:-2], fill_value=0)
    Xte = Xte.assign(age=te["age"].values, lap=te["LapNumber"].values)
    r = Ridge(alpha=1.0).fit(Xtr, tr["LapTime"])
    p = r.predict(Xte)
    out["old_pitwall_ridge"] = _reg_metrics(te["LapTime"].to_numpy(), p)
    # gradient boosting on conditions + pre-race form
    cats = {c: pd.Categorical(pd.concat([tr[c], te[c]]).astype(str)).categories for c in PRE_CAT}

    def enc(d):
        x = d[PRE_NUM].astype(float).copy()
        for c in PRE_CAT:
            x[c] = pd.Categorical(d[c].astype(str), categories=cats[c]).codes
        return x

    gb = HistGradientBoostingRegressor(max_iter=600, learning_rate=0.06, max_leaf_nodes=63,
                                       categorical_features=[len(PRE_NUM) + i for i in range(len(PRE_CAT))],
                                       random_state=0)
    gb.fit(enc(tr), tr["LapTime"])
    out["prerace_gbm"] = _reg_metrics(te["LapTime"].to_numpy(), gb.predict(enc(te)))
    out["n_eval_laps"] = int(len(te))
    return out


def _reg_metrics(y, p):
    ss = np.sum((y - y.mean()) ** 2)
    return {"mae": mae(y, p), "rmse": rmse(y, p), "r2": float(1 - np.sum((y - p) ** 2) / ss)}


# --------------------------------------------------------------- 1b in-race
def _inrace_linear(obs, tgt):
    """The common public approach: a linear model fitted on this race's own
    laps (driver dummies + compound + tyre age per compound + lap number)."""
    def X(d):
        x = pd.get_dummies(d[["Driver", "Compound"]].astype(str))
        for c in DRY:
            x[f"age_{c}"] = d["age"].where(d["Compound"] == c, 0.0)
        x["lap"] = d["LapNumber"]
        return x
    Xo = X(obs)
    Xt = X(tgt).reindex(columns=Xo.columns, fill_value=0)
    return Ridge(alpha=0.1).fit(Xo, obs["LapTime"]).predict(Xt)


def inrace_predictions(df, model, races, step=5, min_obs=3):
    frames = []
    for rid in races:
        rep = df[(df["race_id"] == rid) & df["rep"]]
        if rep.empty:
            continue
        N = int(rep["race_laps"].iloc[0])
        for k in range(5, N - 1, step):
            obs, tgt = rep[rep["LapNumber"] <= k], rep[rep["LapNumber"] > k]
            counts = obs.groupby("Driver").size()
            tgt = tgt[tgt["Driver"].map(counts).fillna(0) >= min_obs]
            if len(obs) < 30 or tgt.empty:
                continue
            local = model.fit_local(obs)
            g = obs.groupby("Driver")["LapTime"]
            stint_k = obs.groupby("Driver")["Stint"].last()
            f = pd.DataFrame({
                "race_id": rid, "year": tgt["year"].values, "k": k,
                "h": (tgt["LapNumber"] - k).values, "Driver": tgt["Driver"].values,
                "y": tgt["LapTime"].values,
                "structural": model.predict_with_local(tgt, local),
                "last_lap": tgt["Driver"].map(g.last()).values,
                "mean_last5": tgt["Driver"].map(g.apply(lambda s: s.tail(5).mean())).values,
                "inrace_linear": _inrace_linear(obs, tgt),
                # features for the residual booster
                "age": tgt["age"].values, "comp": tgt["Compound"].map(COMP_CODE).values,
                "lap_in_stint": tgt["lap_in_stint"].values, "gap_ahead": tgt["gap_ahead"].values,
                "Position": tgt["Position"].values, "fuel_kg": tgt["fuel_kg"].values,
                "dtemp": (tgt["TrackTemp"] - obs["TrackTemp"].mean()).values,
                "pitted_since": (tgt["Stint"].values > tgt["Driver"].map(stint_k).values).astype(float),
                "n_obs": tgt["Driver"].map(counts).values, "k_frac": k / N, "L": tgt["L"].values,
            })
            frames.append(f)
    return pd.concat(frames, ignore_index=True)


RES_FEATS = ["h", "age", "comp", "lap_in_stint", "gap_ahead", "Position", "fuel_kg", "dtemp",
             "pitted_since", "n_obs", "k_frac", "L"]


def horizon_table(pred, models):
    bins = [(1, 5), (6, 10), (11, 20), (21, 99)]
    out = {}
    for m in models:
        row = {"all": mae(pred["y"].values, pred[m].values)}
        for lo, hi in bins:
            sub = pred[pred["h"].between(lo, hi)]
            row[f"h{lo}-{hi}"] = mae(sub["y"].values, sub[m].values)
        row["rmse"] = rmse(pred["y"].values, pred[m].values)
        out[m] = row
    out["n_predictions"] = int(len(pred))
    return out


# --------------------------------------------------------------- 2 pit loss
def pitloss_eval(df, bundle, eval_years):
    ev = pit_events(df[df["year"].isin(eval_years)], bundle["model"])
    ev = ev[(ev["regime"] == GREEN) & ev["loss_green"].between(5, 80)]
    tab = bundle["tables"]["pit_loss"]
    pred = ev["circuit"].map(lambda c: tab.get(c, tab["_global"])["green"])
    naive = np.full(len(ev), 22.0)
    keep = ev["loss_green"] < pred + 8           # slow stops are unforecastable
    return {"stops": int(keep.sum()),
            "mae_circuit_model": mae(ev["loss_green"][keep].values, pred[keep].values),
            "mae_constant_22s": mae(ev["loss_green"][keep].values, naive[keep.values]),
            "median_actual": float(ev["loss_green"][keep].median())}


# --------------------------------------------------------------- 3 race time
def racetime_eval(df, bundle, eval_years, k=10):
    model, tab = bundle["model"], bundle["tables"]["pit_loss"]
    rows = []
    for rid, r in df[df["year"].isin(eval_years) & df["dry_race"]].groupby("race_id"):
        rep = r[r["rep"]]
        obs = rep[rep["LapNumber"] <= k]
        if len(obs) < 50:
            continue
        local = model.fit_local(obs)
        pl = tab.get(r["circuit"].iloc[0], tab["_global"])["green"]
        finished = r["FinishStatus"].fillna("").str.match(r"Finished|\+")
        for drv, d in r[finished].groupby("Driver"):
            d = d[d["LapNumber"] > k].sort_values("LapNumber")
            if d.empty or drv not in set(obs["Driver"]):
                continue
            racing = d["green"] & ~d["pit_in"] & ~d["pit_out"] & d["LapTime"].notna() & d["Compound"].isin(DRY)
            nxt = d.shift(-1)
            stop = d["pit_in"] & d["green"] & nxt["green"].fillna(False).astype(bool) & nxt["pit_out"].fillna(False).astype(bool)
            stop_out = stop.shift(fill_value=False)
            laps = d[racing | stop | stop_out]
            if racing.sum() < 10:
                continue
            # future traffic is unknown: use this driver's traffic rate so far
            seen = obs[obs["Driver"] == drv]
            p = model.predict_with_local(laps.assign(gap1=seen["gap1"].mean(), gap2=seen["gap2"].mean()), local)
            pred = p.sum() + pl * stop.sum()
            act = laps["LapTime"].sum()
            mean_k = obs[obs["Driver"] == drv]["LapTime"].mean()
            naive = mean_k * len(laps) + 22.0 * stop.sum()
            rows.append((rid, drv, len(laps), int(stop.sum()), act, pred, naive))
    t = pd.DataFrame(rows, columns=["race_id", "Driver", "laps", "stops", "actual", "pred", "naive"])
    err = (t["pred"] - t["actual"]).abs()
    nerr = (t["naive"] - t["actual"]).abs()
    return {"drivers": int(len(t)), "mean_laps": float(t["laps"].mean()),
            "mae_s": float(err.mean()), "median_ae_s": float(err.median()),
            "mape_pct": float((err / t["actual"]).mean() * 100),
            "naive_mae_s": float(nerr.mean()), "naive_mape_pct": float((nerr / t["actual"]).mean() * 100)}


# --------------------------------------------------------------- 4 decisions
def _rival_context(r):
    """Information a pit wall has at the start of lap n about lap n-1:
    how many cars stopped, whether the cars directly ahead/behind stopped,
    and how much pace this driver has lost since the best lap of the stint."""
    r = r.sort_values(["Driver", "LapNumber"])
    stopped = r.groupby("LapNumber")["pit_in"].sum()
    pos = r.set_index(["LapNumber", "Position"])["Driver"]
    pitted = set(zip(r.loc[r["pit_in"], "Driver"], r.loc[r["pit_in"], "LapNumber"]))
    prev_pos = r.groupby("Driver")["Position"].shift()
    ahead, behind = [], []
    for drv, n, p in zip(r["Driver"], r["LapNumber"], prev_pos):
        a = pos.get((n - 1, p - 1)) if np.isfinite(p) else None
        b = pos.get((n - 1, p + 1)) if np.isfinite(p) else None
        ahead.append(float((a, n - 1) in pitted) if isinstance(a, str) else 0.0)
        behind.append(float((b, n - 1) in pitted) if isinstance(b, str) else 0.0)
    lt = r["LapTime"].where(r["rep"])
    grp = [r["Driver"], r["Stint"]]
    best = lt.groupby(grp).transform(lambda s: s.shift().expanding().min())
    last3 = lt.groupby(grp).transform(lambda s: s.shift().rolling(3, 1).mean())
    return pd.DataFrame({
        "cars_stopped_prev": r["LapNumber"].map(lambda n: stopped.get(n - 1, 0)).values,
        "ahead_stopped_prev": ahead, "behind_stopped_prev": behind,
        "pace_drop": (last3 - best).values,
        "gap_behind_prev": r.groupby("Driver")["gap_behind"].shift().values,
    }, index=r.index)


def decision_rows(df, bundle, races, in_race=True, deg_sd=DECISION["local_deg_sd"], sc_ratio=None):
    """One row per (driver, lap) mid-stint state with the optimiser's call."""
    model, tables = bundle["model"], bundle["tables"]
    out = []
    for rid in races:
        r = df[df["race_id"] == rid]
        if not r["dry_race"].iloc[0]:
            continue
        N = int(r["race_laps"].iloc[0])
        circ = r["circuit"].iloc[0]
        rep = r[r["rep"]]
        nxt_out = r.groupby("Driver")["pit_out"].shift(-1).fillna(False).astype(bool)
        r = r.assign(real_stop=r["pit_in"] & nxt_out,
                     retire=r["pit_in"] & ~nxt_out)
        r = r.join(_rival_context(r))
        cand = r[(r["LapNumber"] >= 2) & (r["LapNumber"] <= N - 1) & ~r["pit_out"] & ~r["red"]
                 & r["Compound"].isin(DRY) & ~r["retire"]]
        PL = pit_losses(tables, circ)
        if sc_ratio is not None:
            PL[SC] = PL[GREEN] * sc_ratio
        P = transition_matrix(tables["neutral"].get(circ, tables["neutral"]["_global"]))
        temp = float(r["TrackTemp"].median())
        L = float(r["L"].iloc[0])
        pre = RaceState(circ, 2, N, "MEDIUM", 0, False, track_temp=temp, L=L)
        T_pre = lap_cost_table(model, tables, pre, N + 45)
        _, pol_pre = solve(T_pre, PL, P, 2, N)
        for n, lap in cand.groupby("LapNumber"):
            n = int(n)
            if in_race:
                obs = rep[rep["LapNumber"] < n]
                local = model.fit_local(obs, deg_sd) if len(obs) >= 30 else {}
                st = RaceState(circ, n, N, "MEDIUM", 0, False, track_temp=temp, L=L,
                               race_id=rid, local=local)
                T = lap_cost_table(model, tables, st, N + 45)
                _, pol = solve(T, PL, P, n, N)
            else:
                pol = pol_pre
            action, stay, pit = pol[n]
            _, stay0, pit0 = pol_pre[n]
            c = lap["Compound"].map(COMP_CODE).to_numpy()
            a = np.clip(lap["age"].to_numpy() - 1, 0, N + 44).astype(int)
            f = lap["two_compounds"].to_numpy().astype(int)
            s = np.where(lap["sc"], SC, np.where(lap["vsc"], VSC, GREEN))
            out.append(pd.DataFrame({
                "race_id": rid, "year": lap["year"].values, "circuit": circ, "Driver": lap["Driver"].values,
                "lap": n, "Stint": lap["Stint"].values, "y": lap["real_stop"].values.astype(int),
                "dp_pit": (action[c, a, f, s] >= 0).astype(int),
                "dp_gain": stay[c, a, f, s] - pit[c, a, f, s],
                "dp_gain_pre": stay0[c, a, f, s] - pit0[c, a, f, s],
                "age": lap["age"].values, "comp": c, "lap_frac": n / N, "laps_left": N - n,
                "stops_before": lap["stops_before"].values, "two_compounds": f, "status": s,
                "Position": lap["Position"].values, "gap_ahead": lap["gap_ahead"].values,
                "pit_loss": PL[0], "race_laps": N, "TrackTemp": lap["TrackTemp"].values,
                "age_ratio": lap["age"].values / tables["max_age"].get(
                    f"{circ}|MEDIUM", tables["max_age"]["_global|MEDIUM"]),
                "cars_stopped_prev": lap["cars_stopped_prev"].values,
                "ahead_stopped_prev": lap["ahead_stopped_prev"].values,
                "behind_stopped_prev": lap["behind_stopped_prev"].values,
                "pace_drop": lap["pace_drop"].values, "gap_behind_prev": lap["gap_behind_prev"].values,
                # current-lap time vs the driver's previous lap: only known after the lap
                # is complete, and an in-lap is slow *because* the car is pitting
                "lap_delta_leaky": (lap["LapTime"] - lap.index.map(
                    lambda i: r["LapTime"].get(i - 1, np.nan))).values,
            }))
    return pd.concat(out, ignore_index=True)


BASIC = ["age", "comp", "lap_frac", "laps_left", "stops_before", "two_compounds", "status",
         "Position", "gap_ahead", "pit_loss", "race_laps", "TrackTemp"]
RIVALS = ["age_ratio", "cars_stopped_prev", "ahead_stopped_prev", "behind_stopped_prev",
          "pace_drop", "gap_behind_prev"]
CONTEXT = BASIC + RIVALS
HYBRID = CONTEXT + ["dp_gain", "dp_gain_pre", "dp_pit"]
LEAKY = BASIC + ["lap_delta_leaky"]


def tolerant(rows, pred_col, k):
    """Precision/recall when a call within +-k laps of a real stop counts."""
    hit_r, hit_p, n_r, n_p = 0, 0, 0, 0
    for _, g in rows.groupby(["race_id", "Driver"]):
        real = g.loc[g["y"] == 1, "lap"].to_numpy()
        call = g.loc[g[pred_col] == 1, "lap"].to_numpy()
        n_r += len(real)
        n_p += len(call)
        hit_r += sum(np.any(np.abs(call - x) <= k) for x in real)
        hit_p += sum(np.any(np.abs(real - x) <= k) for x in call)
    rec = hit_r / max(n_r, 1)
    prec = hit_p / max(n_p, 1)
    return {"precision": prec, "recall": rec, "f1": 2 * prec * rec / max(prec + rec, 1e-9)}


def first_call_error(rows, pred_col):
    """Per stint that ended in a real stop: laps between the model's first pit
    call in that stint and the real stop (negative = model earlier)."""
    errs = []
    for _, g in rows.groupby(["race_id", "Driver", "Stint"]):
        real = g.loc[g["y"] == 1, "lap"]
        if real.empty:
            continue
        calls = g.loc[g[pred_col] == 1, "lap"]
        # a stint where the model never calls a stop is a miss, not "1 lap late"
        errs.append(calls.min() - real.iloc[0] if len(calls) else np.inf)
    e = np.array(errs, float)
    return {"stints": int(len(e)), "never_called": float(np.mean(~np.isfinite(e))),
            "median_abs_laps": float(np.median(np.abs(e))),
            "within_2_laps": float(np.mean(np.abs(e) <= 2)), "within_5_laps": float(np.mean(np.abs(e) <= 5)),
            "median_signed_laps": float(np.median(e[np.isfinite(e)])) if np.isfinite(e).any() else np.nan}


def classify_metrics(rows, pred_col, prob_col=None):
    y, p = rows["y"].to_numpy(), rows[pred_col].to_numpy()
    out = {"precision": float(precision_score(y, p, zero_division=0)),
           "recall": float(recall_score(y, p, zero_division=0)),
           "f1": float(f1_score(y, p, zero_division=0))}
    if prob_col is not None:
        out["roc_auc"] = float(roc_auc_score(y, rows[prob_col]))
    out["tol1"] = tolerant(rows, pred_col, 1)
    out["tol2"] = tolerant(rows, pred_col, 2)
    out["first_call"] = first_call_error(rows, pred_col)
    neutral = rows[rows["status"] != GREEN]
    if len(neutral):
        yn, pn = neutral["y"].to_numpy(), neutral[pred_col].to_numpy()
        tpr = (pn[yn == 1] == 1).mean() if (yn == 1).any() else np.nan
        tnr = (pn[yn == 0] == 0).mean() if (yn == 0).any() else np.nan
        out["sc_vsc_balanced_accuracy"] = float(np.nanmean([tpr, tnr]))
        out["sc_vsc_f1"] = float(f1_score(yn, pn, zero_division=0))
        out["sc_vsc_states"] = int(len(neutral))
        out["sc_vsc_stops"] = int(yn.sum())
    return out


def fit_classifier(train, feats):
    clf = HistGradientBoostingClassifier(max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                         class_weight="balanced", random_state=0)
    clf.fit(train[feats], train["y"])
    return clf


def best_threshold(y, prob):
    grid = np.linspace(0.05, 0.99, 95)
    scores = [f1_score(y, prob >= t, zero_division=0) for t in grid]
    return float(grid[int(np.argmax(scores))])


# --------------------------------------------------------------- driver
def run():
    t0 = time.time()
    df = load_features()
    races = df.groupby("race_id")["year"].first()
    rid = lambda years: sorted(races[races.isin(years)].index)
    fit_dev, fit_test = list(TRAIN_YEARS), list(TRAIN_YEARS) + list(DEV_YEARS)
    report = {"protocol": {"train": fit_dev, "dev": list(DEV_YEARS), "test": list(TEST_YEARS)}}

    print("[1/4] fitting dev and test bundles")
    b_dev = fit_bundle(df, fit_dev, verbose=False)
    b_test = fit_bundle(df, fit_test, n_boot=20, verbose=False)
    report["structural_test_fit"] = b_test["model"].summary()

    print("[2/4] lap-time prediction")
    report["prerace"] = {"dev": prerace_eval(df, fit_dev, DEV_YEARS, b_dev["model"]),
                         "test": prerace_eval(df, fit_test, TEST_YEARS, b_test["model"])}
    models = ["last_lap", "mean_last5", "inrace_linear", "structural"]
    p_tr = inrace_predictions(df, b_dev["model"], rid(TRAIN_YEARS))
    p_dev = inrace_predictions(df, b_dev["model"], rid(DEV_YEARS))
    booster = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
                                            random_state=0)
    booster.fit(p_tr[RES_FEATS], p_tr["y"] - p_tr["structural"])
    p_dev["structural+gbm"] = p_dev["structural"] + booster.predict(p_dev[RES_FEATS])
    report["inrace"] = {"dev": horizon_table(p_dev, models + ["structural+gbm"])}
    # keep the booster only if it buys at least 1% on dev
    use_booster = (report["inrace"]["dev"]["structural+gbm"]["all"]
                   < 0.99 * report["inrace"]["dev"]["structural"]["all"])
    p_tr2 = inrace_predictions(df, b_test["model"], rid(TRAIN_YEARS + DEV_YEARS))
    p_test = inrace_predictions(df, b_test["model"], rid(TEST_YEARS))
    booster.fit(p_tr2[RES_FEATS], p_tr2["y"] - p_tr2["structural"])
    p_test["structural+gbm"] = p_test["structural"] + booster.predict(p_test[RES_FEATS])
    report["inrace"]["test"] = horizon_table(p_test, models + ["structural+gbm"])
    report["inrace"]["booster_selected_on_dev"] = bool(use_booster)
    p_test.to_parquet(REPORT_DIR / "inrace_predictions_test.parquet")

    print("[3/4] pit loss and race-time simulation")
    report["pit_loss"] = {"dev": pitloss_eval(df, b_dev, DEV_YEARS),
                          "test": pitloss_eval(df, b_test, TEST_YEARS)}
    report["race_time"] = {"dev": racetime_eval(df, b_dev, DEV_YEARS),
                           "test": racetime_eval(df, b_test, TEST_YEARS)}

    print("[4/4] pit decision backtest (optimiser per lap; takes a few minutes)")
    d_dev = decision_rows(df, b_dev, rid(TRAIN_YEARS + DEV_YEARS))
    d_test = decision_rows(df, b_test, rid(TRAIN_YEARS + DEV_YEARS + TEST_YEARS))
    d_test.to_parquet(REPORT_DIR / "decisions_test.parquet")
    dec = {}
    tr_dev, ev_dev = d_dev[d_dev["year"].isin(TRAIN_YEARS)], d_dev[d_dev["year"].isin(DEV_YEARS)]
    tr_test, ev_test = d_test[d_test["year"].isin(fit_test)], d_test[d_test["year"].isin(TEST_YEARS)]
    for split, tr, ev in (("dev", tr_dev, ev_dev), ("test", tr_test, ev_test)):
        ev = ev.copy()
        res = {"states": int(len(ev)), "real_stops": int(ev["y"].sum()),
               "optimiser_in_race": classify_metrics(ev, "dp_pit")}
        ev["dp_pit_pre"] = (ev["dp_gain_pre"] > 0).astype(int)
        res["optimiser_pre_race_only"] = classify_metrics(ev, "dp_pit_pre")
        for name, feats in (("imitation_basic", BASIC), ("imitation_rivals", CONTEXT),
                            ("hybrid_optimiser_features", HYBRID), ("leaky_current_lap_time", LEAKY)):
            clf = fit_classifier(tr, feats)
            prob_tr = clf.predict_proba(tr[feats])[:, 1]
            if split == "dev":
                thr = best_threshold(ev["y"], clf.predict_proba(ev[feats])[:, 1])
                dec.setdefault("thresholds", {})[name] = thr
            else:
                thr = dec["thresholds"][name]
            ev[f"p_{name}"] = clf.predict_proba(ev[feats])[:, 1]
            ev[f"c_{name}"] = (ev[f"p_{name}"] >= thr).astype(int)
            res[name] = classify_metrics(ev, f"c_{name}", f"p_{name}")
            res[name]["threshold"] = thr
        dec[split] = res
        if split == "test":
            ev.to_parquet(REPORT_DIR / "decisions_test_scored.parquet")
    report["decisions"] = dec
    report["runtime_s"] = round(time.time() - t0, 1)
    REPORT_DIR.mkdir(exist_ok=True)
    with open(REPORT_DIR / "metrics.json", "w") as fh:
        json.dump(report, fh, indent=1, default=float)
    print(f"wrote reports/metrics.json in {report['runtime_s']} s")
    return report


if __name__ == "__main__":
    run()
