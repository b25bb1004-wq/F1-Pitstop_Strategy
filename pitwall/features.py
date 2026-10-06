"""Stage 2: per-lap features and the representative-lap filter.

A "representative" lap is one whose time reflects car + driver + tyre + fuel,
not an incident: dry race, dry compound, green flag for the whole lap, not an
in/out lap, not lap 1, not deleted, no rain, and within 5% of the driver's own
race median. Only these laps are used to fit pace and degradation. In/out laps
feed the pit-loss model and SC/VSC laps feed the neutralisation model.
"""
import numpy as np
import pandas as pd

from pitwall.config import DRY, PITWALL_DATA, REF_LAP, START_FUEL_KG


def load():
    laps = pd.read_parquet(PITWALL_DATA / "laps.parquet")
    races = pd.read_parquet(PITWALL_DATA / "races.parquet")
    return prepare(laps), races


def prepare(laps):
    df = laps.sort_values(["race_id", "Driver", "LapNumber"]).reset_index(drop=True)
    drv = [df["race_id"], df["Driver"]]

    ts = df["TrackStatus"].fillna("").astype(str)
    df["green"] = ts.str.fullmatch(r"1+")
    df["sc"] = ts.str.contains("4")
    df["vsc"] = ts.str.contains("6|7") & ~df["sc"]
    df["red"] = ts.str.contains("5")

    df["pit_in"] = df["PitInTime"].notna()
    df["pit_out"] = df["PitOutTime"].notna() & (df["LapNumber"] > 1)
    df["Deleted"] = df["Deleted"].fillna(False).astype(bool)
    df["Rainfall"] = df["Rainfall"].fillna(False).astype(bool)

    wet_tyre = df["Compound"].isin(["INTERMEDIATE", "WET"])
    df["dry_race"] = wet_tyre.groupby(df["race_id"]).transform("mean") < 0.02

    df["Stint"] = df.groupby(drv)["Stint"].ffill().fillna(1)
    df["lap_in_stint"] = df.groupby(drv + [df["Stint"]], dropna=False).cumcount() + 1
    df["stops_before"] = df.groupby(drv)["pit_in"].transform(
        lambda s: s.shift(fill_value=False).cumsum())
    used = pd.concat([(df["Compound"] == c).groupby(drv).cummax() for c in DRY], axis=1)
    df["two_compounds"] = used.sum(axis=1) >= 2

    df["age"] = df["TyreLife"].fillna(df["lap_in_stint"]).clip(lower=1)
    df["fuel_kg"] = (START_FUEL_KG * (df["race_laps"] - df["LapNumber"] + 0.5)
                     / df["race_laps"]).clip(lower=0)
    df["lap_frac"] = df["LapNumber"] / df["race_laps"]
    df["laps_left"] = df["race_laps"] - df["LapNumber"]

    df["TrackTemp"] = (df["TrackTemp"].fillna(df.groupby("race_id")["TrackTemp"].transform("median"))
                       .fillna(35.0))
    df["AirTemp"] = df["AirTemp"].fillna(df.groupby("race_id")["AirTemp"].transform("median"))

    # gap to the car ahead, from the order cars crossed the line on each lap
    df = df.sort_values(["race_id", "LapNumber", "Time"])
    df["gap_ahead"] = df.groupby(["race_id", "LapNumber"])["Time"].diff().fillna(99.0)
    df["gap_behind"] = (-df.groupby(["race_id", "LapNumber"])["Time"].diff(-1)).fillna(99.0)
    df = df.sort_values(["race_id", "Driver", "LapNumber"]).reset_index(drop=True)
    df["gap1"] = (df["gap_ahead"] < 1.0).astype(float)
    df["gap2"] = ((df["gap_ahead"] >= 1.0) & (df["gap_ahead"] < 2.0)).astype(float)

    base_ok = (df["dry_race"] & df["Compound"].isin(DRY) & df["green"] & ~df["pit_in"]
               & ~df["pit_out"] & (df["LapNumber"] > 1) & ~df["Deleted"]
               & df["LapTime"].notna() & ~df["Rainfall"])
    drv_med = df["LapTime"].where(base_ok).groupby(drv).transform("median")
    ratio = df["LapTime"] / drv_med
    df["rep"] = base_ok & ratio.between(0.95, 1.05)

    # race scale: effects are fitted per 90 s of lap so they transfer across tracks
    race_ref = df["LapTime"].where(df["rep"]).groupby(df["race_id"]).transform("median")
    df["race_ref"] = race_ref
    df["L"] = (race_ref / REF_LAP).fillna(1.0)
    return df
