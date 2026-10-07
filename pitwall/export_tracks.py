#!/usr/bin/env python3
"""Circuit outlines for the web app, from FastF1 position telemetry in the local cache.

For each circuit: the fastest lap of its most recent cached race, rotated to the
official map orientation, normalised to a unit box and resampled to evenly
spaced points. Corner numbers come along when the cache has circuit info.
Writes web/public/data/tracks.json.
"""
import json
import logging

import fastf1
import numpy as np
import pandas as pd

from pitwall.config import CACHE_DIR, PITWALL_DATA, ROOT

fastf1.set_log_level("ERROR")
logging.getLogger("fastf1").setLevel(logging.ERROR)
fastf1.Cache.enable_cache(str(CACHE_DIR))
fastf1.Cache.offline_mode(True)
OUT = ROOT / "web" / "public" / "data" / "tracks.json"
N_POINTS = 360


def rotate(xy, deg):
    a = np.deg2rad(deg)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return xy @ R.T


def resample(xy, n, z=None):
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    t = np.linspace(0, seg[-1], n)
    out = np.c_[np.interp(t, seg, xy[:, 0]), np.interp(t, seg, xy[:, 1])]
    zr = np.interp(t, seg, z) if z is not None else None
    return out, seg[-1], zr


def drs_zone(s, n_laps=60):
    """Where DRS opens on this circuit: share of sampled green racing laps with DRS open, per distance fraction.
    The fastest lap is usually driven in clean air with DRS shut, so it cannot show the zones on its own."""
    laps = s.laps
    laps = laps[(laps["LapNumber"] > 3) & laps["PitInTime"].isna() & laps["PitOutTime"].isna() & (laps["TrackStatus"].astype(str) == "1")]
    if len(laps) == 0:
        return [0] * N_POINTS
    step = max(1, len(laps) // n_laps)
    grid = np.linspace(0, 1, N_POINTS)
    acc, used = np.zeros(N_POINTS), 0
    for _, lap in laps.iloc[::step].iterrows():
        try:
            cd = lap.get_car_data().add_distance()
        except Exception:
            continue
        d = cd["Distance"].to_numpy(float)
        if len(d) < 20 or d[-1] <= 0:
            continue
        acc += np.interp(grid, d / d[-1], (cd["DRS"].to_numpy(float) >= 10).astype(float))
        used += 1
    return (acc / max(used, 1) >= 0.2).astype(int).tolist()


def outline(year, rnd):
    s = fastf1.get_session(year, rnd, "R")
    s.load(laps=True, telemetry=True, weather=False, messages=False)
    lap = s.laps.pick_quicklaps().pick_fastest()
    pos = lap.get_pos_data()
    tel = lap.get_telemetry()
    xyz = pos[["X", "Y", "Z"]].to_numpy(float)
    xyz = xyz[np.r_[True, np.any(np.diff(xyz[:, :2], axis=0) != 0, axis=1)]]
    xy, zz = xyz[:, :2], xyz[:, 2]
    rot, corners = 0.0, []
    try:
        ci = s.get_circuit_info()
        rot = float(ci.rotation)
        corners = ci.corners[["X", "Y", "Number", "Letter"]].to_dict("records")
    except Exception:
        pass
    if rot == 0.0:   # no circuit info cached: lay the track along its principal axis
        c = xy - xy.mean(0)
        evals, evecs = np.linalg.eigh(np.cov(c.T))
        major = evecs[:, np.argmax(evals)]
        rot = -np.rad2deg(np.arctan2(major[1], major[0]))
    xy = rotate(xy, rot)
    pts, length, zr = resample(xy, N_POINTS, zz)
    lo, hi = pts.min(0), pts.max(0)
    scale = (hi - lo).max()
    norm = lambda p: ((p - lo) / scale).round(4)
    # telemetry of the same lap, resampled to the same N points by distance fraction so it aligns with `points`
    d = tel["Distance"].to_numpy(float)
    keep = np.r_[True, np.diff(d) > 0]
    d = d[keep]
    f = (d - d[0]) / (d[-1] - d[0])
    grid = np.linspace(0, 1, N_POINTS)
    ch = lambda col: np.interp(grid, f, tel[col].to_numpy(float)[keep])
    secs = (tel["Time"].dt.total_seconds().to_numpy(float))[keep]
    telemetry = {
        "driver": str(lap["Driver"]), "team": str(lap["Team"]), "lap_time": round(float(lap["LapTime"].total_seconds()), 3),
        "speed": np.round(ch("Speed")).astype(int).tolist(),
        "throttle": np.clip(np.round(ch("Throttle")), 0, 100).astype(int).tolist(),
        "brake": (ch("Brake") > 0.5).astype(int).tolist(),
        "gear": np.round(ch("nGear")).astype(int).tolist(),
        "rpm": np.round(ch("RPM") / 10).astype(int).tolist(),
        "drs": (ch("DRS") >= 10).astype(int).tolist(),
        "t": np.round(np.interp(grid, f, secs - secs[0]), 3).tolist(),
    }
    out = {"points": norm(pts).tolist(), "aspect": float((hi - lo)[1] / (hi - lo)[0]), "tel": telemetry, "drs_zone": drs_zone(s),
           "length_m": round(length / 10, 0), "race": f"{year}_{rnd:02d}",
           # FastF1 positions are in 1/10 m: one normalised unit is scale/10 metres
           "scale_m": round(float(scale) / 10, 1),
           "z": ((zr - zr.min()) / scale).round(5).tolist()}
    if corners:
        c = rotate(np.array([[k["X"], k["Y"]] for k in corners], float), rot)
        out["corners"] = [{"n": f"{k['Number']}{k['Letter'] or ''}", "x": float(v[0]), "y": float(v[1])}
                          for k, v in zip(corners, norm(c))]
    return out


def main():
    races = pd.read_parquet(PITWALL_DATA / "races.parquet").sort_values(["year", "round"])
    feats = pd.read_parquet(PITWALL_DATA / "laps_features.parquet", columns=["race_id", "dry_race"])
    dry = set(feats.loc[feats["dry_race"], "race_id"])
    tracks = {}
    for circ, g in races.groupby("circuit"):
        for _, r in g.iloc[::-1].iterrows():         # newest first, fall back to older
            if r["race_id"] not in dry:
                continue
            try:
                tracks[circ] = outline(int(r["year"]), int(r["round"]))
                print(f"{circ:<18} {r['race_id']} corners={len(tracks[circ].get('corners', []))}", flush=True)
                break
            except Exception as exc:
                print(f"{circ}: {r['race_id']} failed ({exc})", flush=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(tracks, separators=(",", ":")))
    print(f"wrote {len(tracks)} tracks, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
