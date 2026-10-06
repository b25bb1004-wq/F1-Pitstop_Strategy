#!/usr/bin/env python3
"""Pitwall command line.

  python -m pitwall.cli decide  --circuit Sakhir --lap 15 --compound SOFT --age 14
  python -m pitwall.cli decide  --circuit Sakhir --lap 15 --compound SOFT --age 14 --status sc
  python -m pitwall.cli predict --circuit Monza --lap 30 --compound HARD --age 12
  python -m pitwall.cli replay  --race 2025_04 --driver NOR      (needs data/pitwall)

`decide` and `predict` only need models/pitwall.pkl (committed); `replay`
needs the local lap table built by `python -m pitwall.build`.
"""
import argparse
import pickle

import numpy as np
import pandas as pd

from pitwall.config import DRY, MODEL_DIR, START_FUEL_KG
from pitwall.strategy import RaceState, decide


def load_bundle():
    with open(MODEL_DIR / "pitwall.pkl", "rb") as fh:
        return pickle.load(fh)


def _circuit(bundle, name):
    known = sorted(bundle["tables"]["circuit_L"])
    if name not in known:
        match = [c for c in known if c.lower().startswith(name.lower())]
        if len(match) != 1:
            raise SystemExit(f"unknown circuit {name!r}; choose from: {', '.join(known)}")
        name = match[0]
    return name


def cmd_decide(args):
    b = load_bundle()
    t = b["tables"]
    circ = _circuit(b, args.circuit)
    st = RaceState(circ, args.lap, args.laps or int(t["circuit_laps"][circ]), args.compound.upper(),
                   args.age, args.two_compounds, args.status,
                   args.track_temp or float(t["circuit_temp"][circ]))
    r = decide(b["model"], t, st, samples=b["boots"])
    verdict = f"BOX THIS LAP for {r['fit_compound']}" if r["pit_now"] else "STAY OUT"
    print(f"\n{circ}  lap {st.lap}/{st.race_laps}  {st.compound} age {st.tyre_age}  "
          f"track {st.status.upper()}  {st.track_temp:.0f}C")
    print(f"  decision           : {verdict}")
    print(f"  pit-now vs stay    : {r['gain_if_pit_now_s']:+.2f} s expected (positive = pitting now is faster)")
    print(f"  P(pit now optimal) : {r['p_pit_now_optimal']:.0%} over {len(b['boots'])} bootstrap models")
    print(f"  pit loss (s)       : green {r['pit_loss_s']['green']}, SC {r['pit_loss_s']['sc']}, "
          f"VSC {r['pit_loss_s']['vsc']}")
    stops = ", ".join(f"lap {s['lap']} -> {s['fit']}" for s in r["plan"]["stops"]) or "no more stops"
    print(f"  optimal plan       : {stops}")
    print("  committed-stop window (expected loss vs best lap to stop, green running):")
    for w in r["window"]:
        print(f"     lap {w['lap']:>3}: +{w['delta_s']:.2f} s {'#' * int(min(w['delta_s'], 6) * 5)}")


def cmd_predict(args):
    b = load_bundle()
    m, t = b["model"], b["tables"]
    circ = _circuit(b, args.circuit)
    N = args.laps or int(t["circuit_laps"][circ])
    L = t["circuit_L"][circ]
    base = args.base or t["circuit_base"][circ]
    temp = args.track_temp or float(t["circuit_temp"][circ])
    c = args.compound.upper()
    fuel = START_FUEL_KG * (N - args.lap + 0.5) / N
    parts = {
        "base pace (empty tank, fresh MEDIUM)": base,
        "fuel": L * (m.get("fuel", "fuel")) * fuel,
        "compound offset": L * m.offset(c, circuit=circ),
        "tyre degradation": L * float(m.deg_curve(c, [args.age], circuit=circ, track_temp=temp)[0]),
        "traffic": L * (m.get("traffic", "gap1") if args.gap < 1 else
                        m.get("traffic", "gap2") if args.gap < 2 else 0.0),
    }
    print(f"\n{circ} lap {args.lap}/{N}  {c} age {args.age}  fuel {fuel:.0f} kg  {temp:.0f}C  gap {args.gap}s")
    for k, v in parts.items():
        print(f"  {k:<38} {v:+8.3f}" if k != "base pace (empty tank, fresh MEDIUM)" else f"  {k:<38} {v:8.3f}")
    print(f"  {'predicted lap time':<38} {sum(parts.values()):8.3f} s  (+-{m.sigma:.2f} s lap noise)")


def cmd_replay(args):
    from pitwall.evaluate import decision_rows
    from pitwall.train import load_features
    b = load_bundle()
    df = load_features()
    rows = decision_rows(df, b, [args.race])
    d = rows[rows["Driver"] == args.driver.upper()].sort_values("lap")
    if d.empty:
        raise SystemExit("no rows for that race/driver (wet race, or driver not found)")
    print(f"\n{args.race} {d['circuit'].iloc[0]} {args.driver.upper()}  (model fitted on all seasons)")
    print("  lap  tyre      age  track  model-gain  call   real")
    for _, r in d.iterrows():
        status = ("GREEN", "SC", "VSC")[int(r["status"])]
        print(f"  {r['lap']:>3}  {DRY[int(r['comp'])]:<8} {int(r['age']):>4}  {status:<5} {r['dp_gain']:+9.2f}   "
              f"{'BOX' if r['dp_pit'] else '   '}   {'BOX' if r['y'] else ''}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decide", help="should the car pit this lap?")
    d.add_argument("--circuit", required=True)
    d.add_argument("--lap", type=int, required=True, help="lap about to be driven")
    d.add_argument("--laps", type=int, help="race distance (default: circuit history)")
    d.add_argument("--compound", required=True, choices=[c.lower() for c in DRY] + list(DRY))
    d.add_argument("--age", type=int, required=True, help="laps already done on this set")
    d.add_argument("--two-compounds", action="store_true", help="two dry compounds already used")
    d.add_argument("--status", default="green", choices=["green", "sc", "vsc"])
    d.add_argument("--track-temp", type=float)
    d.set_defaults(fn=cmd_decide)
    q = sub.add_parser("predict", help="predict a lap time for given conditions")
    q.add_argument("--circuit", required=True)
    q.add_argument("--lap", type=int, required=True)
    q.add_argument("--laps", type=int)
    q.add_argument("--compound", required=True)
    q.add_argument("--age", type=int, required=True)
    q.add_argument("--gap", type=float, default=99.0, help="gap to car ahead, s")
    q.add_argument("--track-temp", type=float)
    q.add_argument("--base", type=float, help="driver base pace; default: circuit's recent median")
    q.set_defaults(fn=cmd_predict)
    r = sub.add_parser("replay", help="lap-by-lap calls for a past race vs what the team did")
    r.add_argument("--race", required=True, help="e.g. 2025_04")
    r.add_argument("--driver", required=True)
    r.set_defaults(fn=cmd_replay)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
