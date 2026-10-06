#!/usr/bin/env python3
"""Stage 1: rebuild a complete race-lap table from the local FastF1 cache.

The original data_pull.py kept only IsAccurate laps, which throws away exactly
the laps a pit-stop model needs: in-laps, out-laps and Safety Car laps. This
stage reloads every 2021-2025 race (and its qualifying session) from the
cache in offline mode, so it needs no network and cannot hit rate limits.

Writes data/pitwall/laps.parquet (one row per driver-lap, every lap) and
data/pitwall/races.parquet (one row per race).
"""
import logging
import sys

import fastf1
import numpy as np
import pandas as pd

from pitwall.config import CACHE_DIR, PITWALL_DATA, YEARS, normalise_circuit

fastf1.set_log_level("ERROR")
logging.getLogger("fastf1").setLevel(logging.ERROR)
fastf1.Cache.enable_cache(str(CACHE_DIR))
fastf1.Cache.offline_mode(True)


def secs(series):
    return series.dt.total_seconds()


def quali_best(year, rnd):
    """Each driver's best qualifying lap in seconds (empty dict if not cached)."""
    try:
        q = fastf1.get_session(year, rnd, "Q")
        q.load(laps=True, telemetry=False, weather=False, messages=False)
        best = q.laps.groupby("Driver")["LapTime"].min().dt.total_seconds()
        return best.dropna().to_dict()
    except Exception as exc:  # session missing from cache
        print(f"  no qualifying for {year} R{rnd}: {exc}")
        return {}


def load_race(year, rnd):
    s = fastf1.get_session(year, rnd, "R")
    s.load(laps=True, telemetry=False, weather=True, messages=False)
    laps = s.laps
    df = pd.DataFrame({
        "Driver": laps["Driver"].values,
        "Team": laps["Team"].values,
        "LapNumber": laps["LapNumber"].values,
        "Stint": laps["Stint"].values,
        "LapTime": secs(laps["LapTime"]).values,
        "Time": secs(laps["Time"]).values,
        "LapStartTime": secs(laps["LapStartTime"]).values,
        "PitInTime": secs(laps["PitInTime"]).values,
        "PitOutTime": secs(laps["PitOutTime"]).values,
        "Compound": laps["Compound"].values,
        "TyreLife": laps["TyreLife"].values,
        "FreshTyre": laps["FreshTyre"].values,
        "TrackStatus": laps["TrackStatus"].astype(str).values,
        "Position": laps["Position"].values,
        "IsAccurate": laps["IsAccurate"].values,
        "Deleted": laps["Deleted"].values,
    })

    # weather: latest reading at or before the start of each lap
    w = s.weather_data.copy()
    w["wt"] = secs(w["Time"])
    w = w[["wt", "AirTemp", "TrackTemp", "Humidity", "WindSpeed", "Rainfall"]].sort_values("wt")
    df = df.sort_values("LapStartTime")
    df = pd.merge_asof(df, w, left_on="LapStartTime", right_on="wt", direction="backward")
    df = df.drop(columns="wt")

    res = s.results
    status = dict(zip(res["Abbreviation"], res["Status"]))
    finish = dict(zip(res["Abbreviation"], res["ClassifiedPosition"]))
    grid = dict(zip(res["Abbreviation"], res["GridPosition"]))
    df["FinishStatus"] = df["Driver"].map(status)
    df["ClassifiedPosition"] = df["Driver"].map(finish).astype(str)
    df["GridPosition"] = df["Driver"].map(grid)

    q = quali_best(year, rnd)
    df["QualiBest"] = df["Driver"].map(q)

    event = s.event
    race = {
        "race_id": f"{year}_{rnd:02d}",
        "year": year,
        "round": rnd,
        "circuit": normalise_circuit(event["Location"]),
        "event_name": event["EventName"],
        "race_laps": int(np.nanmax(df["LapNumber"])),
        "pole_time": min(q.values()) if q else np.nan,
    }
    for k in ("race_id", "year", "round", "circuit"):
        df[k] = race[k]
    df["race_laps"] = race["race_laps"]
    return df, race


def main():
    PITWALL_DATA.mkdir(parents=True, exist_ok=True)
    frames, races = [], []
    for year in YEARS:
        schedule = fastf1.get_event_schedule(year, include_testing=False)
        for rnd in schedule["RoundNumber"]:
            try:
                df, race = load_race(year, int(rnd))
            except Exception as exc:
                print(f"skip {year} R{rnd}: {exc}")
                continue
            frames.append(df)
            races.append(race)
            print(f"{race['race_id']} {race['circuit']:<18} laps={len(df):5d} "
                  f"quali={'y' if not np.isnan(race['pole_time']) else 'n'}")
            sys.stdout.flush()
    laps = pd.concat(frames, ignore_index=True)
    laps.to_parquet(PITWALL_DATA / "laps.parquet", index=False)
    (PITWALL_DATA / "laps_features.parquet").unlink(missing_ok=True)   # rebuilt on next load
    pd.DataFrame(races).to_parquet(PITWALL_DATA / "races.parquet", index=False)
    print(f"wrote {len(laps)} laps from {len(races)} races")


if __name__ == "__main__":
    main()
