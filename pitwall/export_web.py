#!/usr/bin/env python3
"""Export the data behind the Pitwall web app (web/, deployed to GitHub Pages by Actions).

web/public/data/model.json   physics of the final model per circuit (the browser runs the
                       same dynamic programme as pitwall.strategy)
web/public/data/races.json   every 2025 test race, lap by lap: actual time, the model's
                       one-lap-ahead prediction (calibrated only on earlier laps),
                       tyres, track status, the optimiser's pit-now advantage, the
                       hybrid classifier's pit probability, and the real stops
web/public/data/metrics.json headline evaluation numbers
"""
import json
import pickle

import numpy as np
import pandas as pd

from pitwall.evaluate import finite
from pitwall.config import DRY, MODEL_DIR, REPORT_DIR, ROOT, TEST_YEARS, TRAIN_YEARS, DEV_YEARS
from pitwall.pitstops import transition_matrix
from pitwall.strategy import CLIFF, DECISION
from pitwall.structural import IN_RACE, KNOTS
from pitwall.train import fit_bundle, load_features

WEB = ROOT / "web" / "public" / "data"


def r(x, nd=3):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def physics(m):
    """Coefficients the browser needs to rebuild T(compound, age)."""
    return {c: {"knots": list(KNOTS),
                "spline": [m.get("deg0" if j == 0 else "deg", (c, j)) for j in range(len(KNOTS))],
                "temp": m.get("temp", c), "cold": m.get("cold", c), "offset": m.offset(c)}
            for c in DRY}


def model_json(bundle):
    m, t = bundle["model"], bundle["tables"]
    circuits = {}
    for circ in sorted(t["circuit_L"]):
        pl = t["pit_loss"].get(circ, t["pit_loss"]["_global"])
        neut = t["neutral"].get(circ, t["neutral"]["_global"])
        circuits[circ] = {
            "L": r(t["circuit_L"][circ], 4), "laps": int(t["circuit_laps"][circ]),
            "temp": r(t["circuit_temp"][circ], 1), "base": r(t["circuit_base"].get(circ), 3),
            "pit_green": r(pl["green"], 2), "pit_vsc_ratio": r(pl["vsc_ratio"], 3),
            "pit_sc_ratio_measured": r(pl["sc_ratio"], 3), "n_stops": int(pl.get("n_green", 0)),
            "P": np.round(transition_matrix(neut), 5).tolist(),
            "p_sc": r(neut["p_sc"], 4), "p_vsc": r(neut["p_vsc"], 4),
            "deg_circ": {c: r(m.get("deg_circ", (circ, c)), 5) for c in DRY},
            "off_circ": {c: r(m.get("off_circ", (circ, c)), 4) for c in DRY},
            "max_age": {c: t["max_age"].get(f"{circ}|{c}", t["max_age"][f"_global|{c}"]) for c in DRY},
        }
    return {"compounds": list(DRY), "physics": physics(m), "fuel": r(m.get("fuel", "fuel"), 5),
            "sigma": r(m.sigma), "cliff": CLIFF, "sc_ratio_eff": DECISION["sc_ratio_eff"],
            "boots": [{"physics": physics(b),
                       "deg_circ": {f"{k[1][0]}|{k[1][1]}": r(v, 5) for k, v in b.coef.items() if k[0] == "deg_circ"},
                       "off_circ": {f"{k[1][0]}|{k[1][1]}": r(v, 4) for k, v in b.coef.items() if k[0] == "off_circ"}}
                      for b in bundle["boots"]],
            "circuits": circuits}


def races_json(df, bundle):
    """2025 replays with the test-stage model (fitted on 2021-2024 only)."""
    model = bundle["model"]
    scored = pd.read_parquet(REPORT_DIR / "decisions_test_scored.parquet")
    scored = scored.set_index(["race_id", "Driver", "lap"])
    out = []
    for rid, race in df[df["year"].isin(TEST_YEARS)].groupby("race_id"):
        if not race["dry_race"].iloc[0]:
            continue
        race = race.sort_values(["Driver", "LapNumber"])
        rep = race[race["rep"]]
        pred = pd.Series(np.nan, index=race.index)
        for n in range(3, int(race["LapNumber"].max()) + 1):
            obs = rep[rep["LapNumber"] < n]
            lap = race[(race["LapNumber"] == n) & race["Compound"].isin(DRY)]
            if len(obs) < 30 or lap.empty:
                continue
            local = model.fit_local(obs, **IN_RACE)
            pred.loc[lap.index] = model.predict_with_local(lap, local)
        t0 = race.loc[race["LapNumber"] == 1, "LapStartTime"].min()
        drivers = []
        finish = race.groupby("Driver")["ClassifiedPosition"].first()
        for drv, d in race.groupby("Driver"):
            laps = []
            for idx, row in d.iterrows():
                k = (rid, drv, int(row["LapNumber"]))
                sc = scored.loc[k] if k in scored.index else None
                laps.append([
                    int(row["LapNumber"]), r(row["LapTime"]), r(pred.get(idx)),
                    (row["Compound"] or "?")[0], int(row["age"]),
                    "S" if row["sc"] else "V" if row["vsc"] else "R" if row["red"] else "G",
                    int(bool(row["pit_in"])), int(bool(row["rep"])),
                    r(sc["dp_gain"], 2) if sc is not None else None,
                    r(sc["p_pit_call_model"], 3) if sc is not None else None,
                    int(sc["c_pit_call_model"]) if sc is not None else None,
                    r(row["Time"] - t0, 2) if np.isfinite(row["Time"]) else None,
                    int(row["Position"]) if np.isfinite(row["Position"]) else None,
                ])
            drivers.append({"driver": drv, "team": d["Team"].iloc[0], "finish": str(finish.get(drv, "")),
                            "laps": laps})
        drivers.sort(key=lambda x: (int(x["finish"]) if x["finish"].isdigit() else 99, x["driver"]))
        out.append({"race_id": rid, "event": race["event_name"].iloc[0] if "event_name" in race else rid,
                    "circuit": race["circuit"].iloc[0], "laps": int(race["race_laps"].iloc[0]),
                    "drivers": drivers})
    return {"fields": ["lap", "time", "pred", "tyre", "age", "status", "pit", "rep", "gain", "p_call", "call", "t", "pos"],
            "races": out}


def main():
    WEB.mkdir(parents=True, exist_ok=True)
    with open(MODEL_DIR / "pitwall.pkl", "rb") as fh:
        final = pickle.load(fh)
    (WEB / "model.json").write_text(json.dumps(model_json(final), separators=(",", ":")))
    df = load_features()
    races = pd.read_parquet(ROOT / "data" / "pitwall" / "races.parquet")
    df = df.merge(races[["race_id", "event_name"]], on="race_id", how="left")
    test_bundle = fit_bundle(df, list(TRAIN_YEARS) + list(DEV_YEARS), verbose=False)
    (WEB / "races.json").write_text(json.dumps(races_json(df, test_bundle), separators=(",", ":")))
    metrics = finite(json.load(open(REPORT_DIR / "metrics.json")))
    (WEB / "metrics.json").write_text(json.dumps(metrics, separators=(",", ":"), allow_nan=False))
    for f in ("model.json", "races.json", "metrics.json"):
        print(f, f"{(WEB / f).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
