#!/usr/bin/env python3
"""Render reports/RESULTS.md from reports/metrics.json (no hand-copied numbers)."""
import json

from pitwall.config import REPORT_DIR


def f(x, nd=3):
    if x is None:
        return "n/a"
    return f"{x:.{nd}f}" if isinstance(x, (int, float)) else str(x)


def pct(x):
    return "n/a" if x is None or x != x else f"{100 * x:.1f}%"


def main():
    m = json.load(open(REPORT_DIR / "metrics.json"))
    L = []
    w = L.append
    p = m["protocol"]
    w("# Pitwall v2: results\n")
    w(f"Generated from `reports/metrics.json` by `python -m pitwall.report`. Protocol: fit on "
      f"{p['train']}, tune on {p['dev']} (dev), refit on train+dev and report {p['test']} (test) once. "
      "Splits are whole seasons, so no lap, stint or race of an evaluation season is ever seen in fitting.\n")

    s = m["structural_test_fit"]
    w("## 1. What the structural model learned (fit on 2021-2024)\n")
    w("| Quantity | Value |\n|---|---|")
    w(f"| Fuel effect | {f(s['fuel_s_per_kg_per_90s'], 4)} s per kg per 90 s lap "
      f"(~{s['fuel_s_per_kg_per_90s'] * 1.75:.3f} s per lap of fuel burned) |")
    for c in ("SOFT", "MEDIUM", "HARD"):
        d = s[f"deg_{c}_lap10_20_30"]
        w(f"| {c}: offset vs fresh MEDIUM / loss at age 10, 20, 30 | {s[f'offset_{c}']:+.3f} s / "
          f"{d[0]:+.2f}, {d[1]:+.2f}, {d[2]:+.2f} s |")
    w(f"| Traffic: gap < 1 s / 1-2 s | {s['traffic_gap<1s']:+.3f} s / {s['traffic_gap1-2s']:+.3f} s |")
    w(f"| Lap-to-lap noise (robust sigma) | {f(s['sigma'])} s |\n")

    w("## 2. Lap-time prediction\n")
    w("### 2a. In-race (laps up to k seen, every later lap predicted; k = 5, 10, 15, ...)\n")
    for split in ("dev", "test"):
        t = m["inrace"][split]
        models = [k for k in t if isinstance(t[k], dict)]
        bins = [k for k in t[models[0]] if k.startswith("h")]
        w(f"**{split} ({t['n_predictions']:,} predictions), MAE in seconds**\n")
        w("| Model | all | " + " | ".join(b[1:] + " laps ahead" for b in bins) + " | RMSE |")
        w("|---|---|" + "---|" * len(bins) + "---|")
        for k in models:
            w(f"| {k} | {f(t[k]['all'])} | " + " | ".join(f(t[k][b]) for b in bins) + f" | {f(t[k]['rmse'])} |")
        w("")
    w(f"Residual booster kept: {m['inrace']['booster_selected_on_dev']} (chosen on dev).\n")
    w("### 2b. Pre-race (no laps of the race seen; conditions + form from earlier races)\n")
    w("| Model | dev MAE | dev RMSE | dev R2 | test MAE | test RMSE | test R2 |\n|---|---|---|---|---|---|---|")
    for k in ("old_pitwall_ridge", "prerace_gbm", "prerace_structural"):
        a, b = m["prerace"]["dev"][k], m["prerace"]["test"][k]
        w(f"| {k} | {f(a['mae'])} | {f(a['rmse'])} | {f(a['r2'])} | {f(b['mae'])} | {f(b['rmse'])} | {f(b['r2'])} |")
    w("")

    w("## 3. Pit loss and race-time simulation\n")
    w("| | dev | test |\n|---|---|---|")
    a, b = m["pit_loss"]["dev"], m["pit_loss"]["test"]
    w(f"| Green stops scored | {a['stops']} | {b['stops']} |")
    w(f"| Pit-loss MAE, per-circuit model | {f(a['mae_circuit_model'], 2)} s | {f(b['mae_circuit_model'], 2)} s |")
    w(f"| Pit-loss MAE, constant 22 s | {f(a['mae_constant_22s'], 2)} s | {f(b['mae_constant_22s'], 2)} s |")
    a, b = m["race_time"]["dev"], m["race_time"]["test"]
    w(f"| Remaining-race time from lap 10, drivers | {a['drivers']} | {b['drivers']} |")
    w(f"| ... model MAE (MAPE) | {f(a['mae_s'], 1)} s ({f(a['mape_pct'], 2)}%) | {f(b['mae_s'], 1)} s ({f(b['mape_pct'], 2)}%) |")
    w(f"| ... naive pace x laps + 22 s/stop | {f(a['naive_mae_s'], 1)} s ({f(a['naive_mape_pct'], 2)}%) | "
      f"{f(b['naive_mae_s'], 1)} s ({f(b['naive_mape_pct'], 2)}%) |\n")

    w("## 4. Pit-stop decision backtest (every driver, every mid-stint lap, dry races)\n")
    for split in ("dev", "test"):
        d = m["decisions"][split]
        w(f"**{split}: {d['states']:,} lap states, {d['real_stops']} real stops**\n")
        w("| Decision model | P | R | F1 (exact lap) | F1 +-1 lap | F1 +-2 laps | first call within 2 laps | "
          "median first-call error | SC/VSC balanced acc. | SC/VSC F1 | ROC-AUC |")
        w("|---|---|---|---|---|---|---|---|---|---|---|")
        for k in ("optimiser_in_race", "optimiser_pre_race_only", "imitation_basic", "pit_call_model",
                  "hybrid_optimiser_features", "leaky_current_lap_time"):
            r = d[k]
            fc = r["first_call"]
            w(f"| {k} | {f(r['precision'], 2)} | {f(r['recall'], 2)} | {f(r['f1'], 2)} | {f(r['tol1']['f1'], 2)} | "
              f"{f(r['tol2']['f1'], 2)} | {pct(fc['within_2_laps'])} | {f(fc['median_abs_laps'], 1)} laps | "
              f"{pct(r.get('sc_vsc_balanced_accuracy', float('nan')))} | {f(r.get('sc_vsc_f1', float('nan')), 2)} | "
              f"{f(r.get('roc_auc', float('nan')), 3)} |")
        w("")
    (REPORT_DIR / "RESULTS.md").write_text("\n".join(L) + "\n")
    print("wrote reports/RESULTS.md")


if __name__ == "__main__":
    main()
