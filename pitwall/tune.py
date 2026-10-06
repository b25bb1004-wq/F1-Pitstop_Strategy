#!/usr/bin/env python3
"""Choose the optimiser's two decision parameters on the 2024 dev season only.

Grid: in-race wear-rate prior (None = no in-race updates) x effective SC stop
cost (fraction of a green stop) x decision margin. Objective: mean of
F1 within +-2 laps, first pit call within 2 laps of the real stop, and SC/VSC
balanced accuracy. Writes reports/decision_tuning_dev.csv; the chosen values
live in pitwall.strategy.DECISION.
"""
import itertools

import numpy as np
import pandas as pd

import pitwall.evaluate as E
from pitwall.config import DEV_YEARS, REPORT_DIR, TRAIN_YEARS
from pitwall.train import fit_bundle, load_features


def main():
    df = load_features()
    b = fit_bundle(df, list(TRAIN_YEARS), verbose=False)
    dev = sorted(df[df["year"].isin(DEV_YEARS)]["race_id"].unique())
    res = []
    for deg_sd, sc in itertools.product([None, 0.01, 0.005, 0.0025], [0.1, 0.3, 0.5, 0.7]):
        rows = E.decision_rows(df, b, dev, in_race=deg_sd is not None, deg_sd=deg_sd, sc_ratio=sc)
        for margin in [0, 0.5, 1, 2, 3, 4]:
            rows["call"] = (rows["dp_gain"] > margin).astype(int)
            m = E.classify_metrics(rows, "call")
            comp = np.mean([m["tol2"]["f1"], m["first_call"]["within_2_laps"],
                            m["sc_vsc_balanced_accuracy"]])
            res.append(dict(deg_sd=deg_sd, sc=sc, margin=margin, comp=comp, f1_2=m["tol2"]["f1"],
                            fc2=m["first_call"]["within_2_laps"], sc_bal=m["sc_vsc_balanced_accuracy"],
                            never=m["first_call"]["never_called"], f1=m["f1"],
                            signed=m["first_call"]["median_signed_laps"]))
        print("done", deg_sd, sc, flush=True)
    r = pd.DataFrame(res).sort_values("comp", ascending=False)
    r.to_csv(REPORT_DIR / "decision_tuning_dev.csv", index=False)
    print(r.head(5).round(3).to_string())


if __name__ == "__main__":
    main()
