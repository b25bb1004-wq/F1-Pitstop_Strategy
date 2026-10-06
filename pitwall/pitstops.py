"""Stage 4: what a pit stop costs, and how likely a Safety Car is.

Pit loss is measured, not assumed. For every stop, the in-lap and out-lap
times are compared with what the structural model says those two laps would
have taken without stopping (same driver, same race, same tyres):

    green loss = (in_lap + out_lap) - (expected_in + expected_out)

Under a Safety Car or VSC a lap-time comparison is misleading, because the
queue behind the SC closes most of the pit-lane deficit afterwards. So SC/VSC
stops are measured by gap to the leader three laps later, against non-stopping
cars that started from the same gap. That gives the "cheap stop" discount that
drives most real SC strategy calls (SC and VSC are pooled across circuits as a
fraction of the green loss; per-circuit samples are too small).

Neutralisations are modelled as a per-circuit Markov chain over lap states
{green, SC, VSC}: a per-lap onset hazard (shrunk toward the global rate) and a
mean duration.
"""
import numpy as np
import pandas as pd

GREEN, SC, VSC = 0, 1, 2


def pit_events(df, model):
    """One row per pit stop with its measured time loss."""
    d = df.sort_values(["race_id", "Driver", "LapNumber"]).reset_index(drop=True)
    nxt = d.groupby(["race_id", "Driver"]).shift(-1)
    ev = d[d["pit_in"] & nxt["pit_out"].fillna(False).astype(bool)
           & d["LapTime"].notna() & nxt["LapTime"].notna()
           & (d["LapNumber"] > 1) & d["dry_race"] & ~d["red"] & ~nxt["red"].fillna(False).astype(bool)].copy()
    out = nxt.loc[ev.index].copy()
    for c in ("race_id", "circuit", "year", "Driver", "L", "race_laps"):
        out[c] = ev[c]
    ev["out_time"] = out["LapTime"].to_numpy()
    ev["next_compound"] = out["Compound"].to_numpy()

    # expected clean-lap times for the in-lap and out-lap, race-local base pace
    exp_in = np.full(len(ev), np.nan)
    exp_out = np.full(len(ev), np.nan)
    rep = d[d["rep"]]
    for rid, idx in ev.groupby("race_id").groups.items():
        local = model.fit_local(rep[rep["race_id"] == rid])
        pos = ev.index.get_indexer(idx)
        a = ev.loc[idx].assign(gap1=0.0, gap2=0.0)
        b = out.loc[idx].assign(gap1=0.0, gap2=0.0, lap_in_stint=1)
        exp_in[pos] = model.predict_with_local(a, local)
        exp_out[pos] = model.predict_with_local(b, local)
    ev["loss_green"] = ev["LapTime"] + ev["out_time"] - exp_in - exp_out

    sc_both = ev["sc"] & out["sc"].fillna(False).astype(bool)
    vsc_both = ev["vsc"] & out["vsc"].fillna(False).astype(bool)
    clean = ~(ev["sc"] | ev["vsc"]) & ~(out["sc"].fillna(False).astype(bool) | out["vsc"].fillna(False).astype(bool))
    ev["regime"] = np.select([sc_both, vsc_both, clean], [SC, VSC, GREEN], default=-1)
    ev["loss_gap"] = _gap_matched_loss(d, ev)
    ev["loss"] = np.where(ev["regime"] == GREEN, ev["loss_green"], ev["loss_gap"])
    cols = ["race_id", "year", "circuit", "Driver", "LapNumber", "Compound", "next_compound",
            "age", "regime", "loss", "loss_green", "loss_gap"]
    return ev[cols].reset_index(drop=True)


def _gap_matched_loss(d, ev, after=3):
    """Effective cost of a stop once the field has (or has not) compressed:
    the stopper's gap to the leader `after` laps past the in-lap, minus the gap
    a non-stopping car that started from the same gap ended up with.
    Under a Safety Car the queue closes most of the pit-lane deficit, which a
    lap-time comparison cannot see."""
    lead = d.groupby(["race_id", "LapNumber"])["Time"].transform("min")
    gap = pd.Series((d["Time"] - lead).to_numpy(),
                    index=pd.MultiIndex.from_frame(d[["race_id", "Driver", "LapNumber"]]))
    stop_lap = d["pit_in"] | d["pit_out"]
    stops = d.loc[stop_lap, ["race_id", "Driver", "LapNumber"]]
    out = np.full(len(ev), np.nan)
    for i, (rid, drv, n) in enumerate(zip(ev["race_id"], ev["Driver"], ev["LapNumber"].astype(int))):
        a, b = n - 1, n + after
        g0, g1 = gap.get((rid, drv, a)), gap.get((rid, drv, b))
        if g0 is None or g1 is None or not np.isfinite(g0) or not np.isfinite(g1):
            continue
        busy = set(stops[(stops["race_id"] == rid) & stops["LapNumber"].between(a - 1, b + 1)]["Driver"])
        ctrl = []
        for other in d.loc[d["race_id"] == rid, "Driver"].unique():
            if other == drv or other in busy:
                continue
            c0, c1 = gap.get((rid, other, a)), gap.get((rid, other, b))
            if c0 is not None and c1 is not None and np.isfinite(c0) and np.isfinite(c1):
                ctrl.append((c0, c1))
        if len(ctrl) < 3:
            continue
        c = np.array(sorted(ctrl))
        out[i] = g1 - np.interp(g0, c[:, 0], c[:, 1])
    return out


def _robust(x):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return np.nan, np.nan, 0
    med = np.median(x)
    x = x[x < med + 8.0]                # slow stops, penalties served in the box
    med = np.median(x)
    mad = 1.4826 * np.median(np.abs(x - med))
    return float(med), float(mad), len(x)


def pit_loss_table(events):
    """Per-circuit green pit loss (latest season with >=6 stops, else pooled)
    and SC/VSC losses as a fraction of it."""
    ev = events[np.isfinite(events["loss_green"]) & events["loss_green"].between(5, 80)]
    green = ev[ev["regime"] == GREEN]
    table = {}
    g_all, g_sd, _ = _robust(green["loss_green"])
    for circ, g in green.groupby("circuit"):
        latest = g[g["year"] == g["year"].max()]
        use = latest if len(latest) >= 6 else g
        med, mad, n = _robust(use["loss_green"])
        table[circ] = {"green": med, "green_sd": mad if n > 3 else g_sd, "n_green": int(len(g))}
    ratios = {}
    g_gap = _robust(ev.loc[ev["regime"] == GREEN, "loss_gap"])[0]
    for regime, name in ((SC, "sc"), (VSC, "vsc")):
        sub = events[(events["regime"] == regime) & np.isfinite(events["loss_gap"])]
        ratios[name] = float(np.clip(np.median(sub["loss_gap"]) / g_gap, 0.0, 1.0)) if len(sub) else 0.5
        table["_n_" + name] = int(len(sub))
    for circ in [c for c in table if not c.startswith("_")]:
        for name in ("sc", "vsc"):
            table[circ][f"{name}_ratio"] = ratios[name]
    table["_global"] = {"green": g_all, "green_sd": g_sd, "sc_ratio": ratios["sc"],
                        "vsc_ratio": ratios["vsc"], "n_green": int(len(green))}
    return table


def neutralisation_table(df, prior_laps=200):
    """Per-circuit Markov chain over {green, SC, VSC} lap states."""
    lap = (df[df["LapNumber"] >= 2].groupby(["race_id", "circuit", "LapNumber"])
           .agg(sc=("sc", "mean"), vsc=("vsc", "mean")).reset_index())
    lap["state"] = np.where(lap["sc"] > 0.5, SC, np.where(lap["vsc"] > 0.5, VSC, GREEN))
    lap["prev"] = lap.groupby("race_id")["state"].shift(fill_value=GREEN)
    at_risk = lap[lap["prev"] == GREEN]
    on_sc = (at_risk["state"] == SC)
    on_vsc = (at_risk["state"] == VSC)
    g_sc, g_vsc = on_sc.mean(), on_vsc.mean()

    def mean_len(state):
        runs = (lap["state"] == state) & (lap["prev"] != state)
        n_runs = runs.sum()
        return (lap["state"] == state).sum() / max(n_runs, 1)

    len_sc, len_vsc = mean_len(SC), mean_len(VSC)
    table = {"_global": {"p_sc": float(g_sc), "p_vsc": float(g_vsc),
                         "len_sc": float(len_sc), "len_vsc": float(len_vsc)}}
    for circ, g in at_risk.groupby("circuit"):
        n = len(g)
        table[circ] = {
            "p_sc": float(((g["state"] == SC).sum() + prior_laps * g_sc) / (n + prior_laps)),
            "p_vsc": float(((g["state"] == VSC).sum() + prior_laps * g_vsc) / (n + prior_laps)),
            "len_sc": float(len_sc), "len_vsc": float(len_vsc), "laps_at_risk": int(n),
        }
    return table


def transition_matrix(neut):
    p_sc, p_vsc = neut["p_sc"], neut["p_vsc"]
    q_sc = 1 - 1 / max(neut["len_sc"], 1.01)
    q_vsc = 1 - 1 / max(neut["len_vsc"], 1.01)
    return np.array([
        [1 - p_sc - p_vsc, p_sc, p_vsc],
        [1 - q_sc, q_sc, 0.0],
        [1 - q_vsc, 0.0, q_vsc],
    ])
