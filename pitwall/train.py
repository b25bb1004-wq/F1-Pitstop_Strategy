#!/usr/bin/env python3
"""Fit every component on a set of seasons and bundle them.

`python -m pitwall.train` fits on all 2021-2025 races and writes
models/pitwall.pkl (used by the CLI) plus models/pitwall_summary.json.
"""
import json
import pickle

import numpy as np
import pandas as pd

from pitwall.config import DRY, MODEL_DIR, PITWALL_DATA
from pitwall.pitstops import neutralisation_table, pit_events, pit_loss_table
from pitwall.structural import Structural


def load_features():
    path = PITWALL_DATA / "laps_features.parquet"
    if not path.exists():
        from pitwall.features import load
        df, _ = load()
        df.to_parquet(path)
    return pd.read_parquet(path)


def stint_limits(df, q=0.95):
    """Longest stint (tyre age at stint end) teams were willing to run, per
    circuit and compound. Beyond it the degradation curve is extrapolation, so
    the optimiser adds a quadratic cliff penalty there."""
    d = df[df["dry_race"] & df["Compound"].isin(DRY)]
    end = d.groupby(["race_id", "Driver", "Stint"]).agg(
        circuit=("circuit", "first"), c=("Compound", "first"), age=("age", "max"))
    out = {f"_global|{c}": float(g["age"].quantile(q)) for c, g in end.groupby("c")}
    for (circ, c), g in end.groupby(["circuit", "c"]):
        if len(g) >= 10:
            out[f"{circ}|{c}"] = float(g["age"].quantile(q))
    return out


def circuit_base(model, df):
    """Median driver base pace (empty tank, fresh MEDIUM) at each circuit's
    most recent race, for `pitwall.cli predict` defaults."""
    latest = df.sort_values(["year", "round"]).groupby("circuit")["race_id"].last()
    fe = pd.Series({k[1]: v for k, v in model.coef.items() if k[0] == "fe"})
    out = {}
    for circ, rid in latest.items():
        vals = [v for (r, _), v in fe.items() if r == rid]
        if vals:
            out[circ] = float(np.median(vals))
    return out


def fit_bundle(df, years, n_boot=0, seed=0, verbose=True):
    fit = df[df["year"].isin(years)]
    rep = fit[fit["rep"]]
    if verbose:
        print(f"fitting on {sorted(set(years))}: {rep['race_id'].nunique()} races, {len(rep)} laps")
    model = Structural.fit(rep, verbose=verbose)
    events = pit_events(fit, model)
    tables = {
        "pit_loss": pit_loss_table(events),
        "neutral": neutralisation_table(fit),
        "max_age": stint_limits(fit),
        "circuit_L": fit.groupby("circuit")["L"].last().to_dict(),
        "circuit_temp": fit.groupby("circuit")["TrackTemp"].median().to_dict(),
        "circuit_laps": fit.groupby("circuit")["race_laps"].last().to_dict(),
        "circuit_base": circuit_base(model, fit),
        "years": sorted(set(years)),
    }
    boots = []
    if n_boot:
        rng = np.random.default_rng(seed)
        races = rep["race_id"].unique()
        by_race = {r: g for r, g in rep.groupby("race_id")}
        for b in range(n_boot):
            pick = rng.choice(races, size=len(races), replace=True)
            sample = pd.concat([by_race[r] for r in pick], ignore_index=True)
            boots.append(Structural.fit(sample, verbose=False))
        if verbose:
            print(f"  {n_boot} race-bootstrap refits done")
    return {"model": model, "tables": tables, "boots": boots, "events": events}


def main():
    df = load_features()
    bundle = fit_bundle(df, years=sorted(df["year"].unique()), n_boot=30)
    MODEL_DIR.mkdir(exist_ok=True)
    slim = {k: v for k, v in bundle.items() if k != "events"}
    # keep only the physics in bootstrap copies (base paces are not needed to decide)
    keep = ("off_g", "off_circ", "deg0", "deg", "temp", "deg_circ", "cold")
    for m in slim["boots"]:
        m.coef = {k: v for k, v in m.coef.items() if k[0] in keep}
    with open(MODEL_DIR / "pitwall.pkl", "wb") as fh:
        pickle.dump(slim, fh)
    summary = {"structural": bundle["model"].summary(),
               "pit_loss": bundle["tables"]["pit_loss"],
               "neutralisation": bundle["tables"]["neutral"],
               "stint_limits": bundle["tables"]["max_age"]}
    with open(MODEL_DIR / "pitwall_summary.json", "w") as fh:
        json.dump(summary, fh, indent=1, default=float)
    print("wrote models/pitwall.pkl and models/pitwall_summary.json")


if __name__ == "__main__":
    main()
