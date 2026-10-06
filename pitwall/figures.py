#!/usr/bin/env python3
"""Figures for the README and report (reads models/ and reports/)."""
import json
import pickle

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from pitwall.config import DRY, FIG_DIR, MODEL_DIR, REPORT_DIR

COL = {"SOFT": "#d62728", "MEDIUM": "#e6b800", "HARD": "#7f7f7f"}


def deg_curves(bundle):
    m, boots = bundle["model"], bundle["boots"]
    ages = np.arange(1, 41)
    fig, axes = plt.subplots(1, 3, figsize=(13, 4), sharey=True)
    for ax, circ in zip(axes, (None, "Sakhir", "Monaco")):
        for c in DRY:
            f = lambda mm: mm.offset(c, circ) + mm.deg_curve(c, ages, circuit=circ)
            ax.plot(ages, f(m), color=COL[c], lw=2, label=c)
            if boots:
                band = np.array([f(b) for b in boots])
                ax.fill_between(ages, *np.percentile(band, [5, 95], axis=0), color=COL[c], alpha=0.2)
        ax.set_title(circ or "All circuits (35C track)")
        ax.set_xlabel("tyre age (laps)")
        ax.grid(alpha=0.3)
    axes[0].set_ylabel("lap time vs fresh MEDIUM (s per 90 s lap)")
    axes[0].legend()
    fig.suptitle("Fuel-corrected tyre degradation, 90% race-bootstrap bands")
    fig.tight_layout()
    fig.savefig(FIG_DIR / "degradation_curves.png", dpi=130)


def pit_losses(bundle):
    t = {k: v for k, v in bundle["tables"]["pit_loss"].items() if not k.startswith("_")}
    s = pd.Series({k: v["green"] for k, v in t.items()}).sort_values()
    fig, ax = plt.subplots(figsize=(8, 7))
    ax.barh(s.index, s.values, color="#1f77b4")
    g = bundle["tables"]["pit_loss"]["_global"]
    ax.set_xlabel("green-flag pit loss (s)")
    ax.set_title(f"Measured pit loss per circuit\nSC stop = {g['sc_ratio']:.0%} of green, "
                 f"VSC stop = {g['vsc_ratio']:.0%} (gap-matched)")
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "pit_loss_by_circuit.png", dpi=130)


def horizon(metrics):
    t = metrics["inrace"]["test"]
    models = [m for m in t if isinstance(t[m], dict)]
    bins = [k for k in t[models[0]] if k.startswith("h")]
    fig, ax = plt.subplots(figsize=(8, 4.5))
    w = 0.8 / len(models)
    for i, m in enumerate(models):
        ax.bar(np.arange(len(bins)) + i * w, [t[m][b] for b in bins], w, label=m)
    ax.set_xticks(np.arange(len(bins)) + 0.4 - w / 2)
    ax.set_xticklabels([b.replace("h", "") + " laps ahead" for b in bins])
    ax.set_ylabel("MAE (s)")
    ax.set_title("2025 held-out races: in-race lap-time error by forecast horizon")
    ax.legend(fontsize=8)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "laptime_mae_by_horizon.png", dpi=130)


def timeline(scored, race=None, driver=None):
    d = scored
    if race is None:   # pick the 2025 race/driver with the most stops for illustration
        k = d.groupby(["race_id", "Driver"])["y"].sum().sort_values()
        race, driver = k.index[-1]
    d = d[(d["race_id"] == race) & (d["Driver"] == driver)].sort_values("lap")
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.plot(d["lap"], d["dp_gain"], color="k", lw=1.5, label="optimiser: time gained by pitting now (s)")
    ax.axhline(0, color="grey", lw=0.8)
    for lap in d.loc[d["y"] == 1, "lap"]:
        ax.axvline(lap, color="tab:green", lw=2, alpha=0.7)
    neutral = d[d["status"] > 0]
    ax.scatter(neutral["lap"], neutral["dp_gain"], color="orange", zorder=3, label="SC / VSC lap")
    ax.plot([], [], color="tab:green", lw=2, label="team actually pitted")
    ax.set_xlabel("lap")
    ax.set_ylim(max(d["dp_gain"].min(), -30), max(d["dp_gain"].max(), 5) + 2)
    ax.set_title(f"{race} {d['circuit'].iloc[0]} - {driver}: pit-now advantage, lap by lap")
    ax.legend(fontsize=8, loc="lower left")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "decision_timeline.png", dpi=130)


def main():
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(MODEL_DIR / "pitwall.pkl", "rb") as fh:
        bundle = pickle.load(fh)
    deg_curves(bundle)
    pit_losses(bundle)
    with open(REPORT_DIR / "metrics.json") as fh:
        horizon(json.load(fh))
    scored = REPORT_DIR / "decisions_test_scored.parquet"
    if scored.exists():
        timeline(pd.read_parquet(scored))
    print(f"figures written to {FIG_DIR}")


if __name__ == "__main__":
    main()
