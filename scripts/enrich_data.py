#!/usr/bin/env python3
"""Build the enriched feature set for tyre-degradation modeling: real
weather (merged from the FastF1 cache, not the WeatherBucket race-quarter
proxy), traffic, stint/fuel context, and a team-pace feature that replaces
35 Driver dummies. Writes data/train_enriched.csv and data/dev_enriched.csv.

This makes permanent (and reproducible from the existing cache, no new API
pulls) the feature set that notes/degradation_experiment_report.md first
tried as session-temporary scratch scripts in July. Every enrichment step
here mirrors that report's methodology; see the report for the reasoning
behind each choice.

Run `python clean_data.py` first (this reads its output, not the raw
train.csv/dev.csv). Run from scripts/: `python enrich_data.py`. Takes a
few minutes — it loads weather for every race in train+dev from the local
FastF1 cache (no network calls; the cache is already fully populated).
"""
import fastf1
import pandas as pd
import numpy as np
import warnings

warnings.filterwarnings("ignore")
fastf1.Cache.enable_cache("../cache")
fastf1.logger.set_log_level("ERROR")

# Reads the cleaned files (run clean_data.py first) - not the raw
# train.csv/dev.csv, which still carry dead columns, track-limits-deleted
# laps with dishonest times, and rows missing Compound/TyreLife.
train_df = pd.read_csv("../data/train_clean.csv", low_memory=False)
dev_df = pd.read_csv("../data/dev_clean.csv", low_memory=False)
print(f"train {train_df.shape}, dev {dev_df.shape}")


def track_status_bucket(status):
    status = str(status)
    if "5" in status:
        return "red"
    elif any(code in status for code in ("2", "4", "6", "7")):
        return "yellow"
    else:
        return "green"


for df in (train_df, dev_df):
    df["TrackStatusBucket"] = df["TrackStatus"].apply(track_status_bucket)
    # 'Time' is a session-relative Timedelta string once round-tripped through
    # CSV (e.g. "0 days 01:23:45.678000") - parse it back for merge_asof and
    # for the traffic/gap calculation below, both of which need it numeric.
    df["Time"] = pd.to_timedelta(df["Time"])


# ---------------------------------------------------------------------------
# 1. Weather, merged from the FastF1 cache by session time (asof-join, so
#    each lap gets the most recent weather reading at or before it ended).
#    The cache is already fully populated by data_pull.py, so this is a
#    pure local read — no network calls, no rate-limit risk.
# ---------------------------------------------------------------------------
def load_weather(year, round_number):
    try:
        session = fastf1.get_session(year, round_number, "R")
        session.load(laps=False, telemetry=False, weather=True, messages=False)
        w = session.weather_data[["Time", "TrackTemp", "AirTemp", "Humidity", "Rainfall", "WindSpeed"]].copy()
        w["year"] = year
        w["round_number"] = round_number
        return w
    except Exception as e:
        print(f"  weather load failed for {year} round {round_number}: {e}")
        return None


def merge_weather(df):
    races = df[["year", "round_number"]].drop_duplicates().values
    print(f"  loading weather for {len(races)} races...")
    enriched_parts = []
    for i, (year, round_number) in enumerate(races):
        weather = load_weather(int(year), int(round_number))
        race_laps = df[(df["year"] == year) & (df["round_number"] == round_number)].copy()
        if weather is None or weather.empty:
            for col in ["TrackTemp", "AirTemp", "Humidity", "Rainfall", "WindSpeed"]:
                race_laps[col] = np.nan
        else:
            race_laps = race_laps.sort_values("Time")
            weather = weather.sort_values("Time")
            race_laps = pd.merge_asof(race_laps, weather.drop(columns=["year", "round_number"]),
                                       on="Time", direction="nearest")
        enriched_parts.append(race_laps)
        if (i + 1) % 20 == 0:
            print(f"    {i + 1}/{len(races)} races done")
    return pd.concat(enriched_parts, ignore_index=False).sort_index()


print("Merging weather into train...")
train_df = merge_weather(train_df)
print("Merging weather into dev...")
dev_df = merge_weather(dev_df)

weather_cols = ["TrackTemp", "AirTemp", "Humidity", "Rainfall", "WindSpeed"]
print(f"weather coverage: train {train_df[weather_cols].notna().all(axis=1).mean():.1%}, "
      f"dev {dev_df[weather_cols].notna().all(axis=1).mean():.1%}")


# ---------------------------------------------------------------------------
# 2. Traffic: gap to the car that completed the same lap number just ahead.
#    Approximate but data-available: within (year, round_number, LapNumber),
#    sort by completion Time and take the gap to the previous car in that
#    order. `clean_air` flags a >2s gap (no direct aero/tow effect from a
#    car ahead).
# ---------------------------------------------------------------------------
def add_traffic(df):
    df = df.sort_values(["year", "round_number", "LapNumber", "Time"])
    df["gap_ahead"] = df.groupby(["year", "round_number", "LapNumber"])["Time"].diff().dt.total_seconds()
    df["clean_air"] = (df["gap_ahead"].isna()) | (df["gap_ahead"] > 2.0)
    return df


train_df = add_traffic(train_df)
dev_df = add_traffic(dev_df)

# ---------------------------------------------------------------------------
# 3. Stint & fuel context: lap-within-stint, tyre age at stint start,
#    laps_remaining (race-length-aware fuel proxy, better than raw LapNumber
#    since race distance varies by circuit).
# ---------------------------------------------------------------------------
def add_stint_context(df):
    df = df.sort_values(["year", "round_number", "Driver", "Stint", "LapNumber"])
    df["lap_in_stint"] = df.groupby(["year", "round_number", "Driver", "Stint"]).cumcount() + 1
    df["stint_start_tyre_age"] = df["TyreLife"] - df["lap_in_stint"] + 1
    race_total_laps = df.groupby(["year", "round_number"])["LapNumber"].transform("max")
    df["laps_remaining"] = race_total_laps - df["LapNumber"]
    return df


train_df = add_stint_context(train_df)
dev_df = add_stint_context(dev_df)

# ---------------------------------------------------------------------------
# 4. team_pace: each (year, Team)'s average deficit of its best race lap vs
#    the weekend's best, computed from TRAIN races only (fit-on-train,
#    apply-to-dev — the same discipline as every other train/dev split in
#    this project) and reused for dev via a lookup, so it replaces the 35
#    Driver dummy columns with one continuous number without leaking dev
#    information into it.
# ---------------------------------------------------------------------------
def race_best_by_team(df):
    green = df[df["TrackStatusBucket"] == "green"]
    race_best_overall = green.groupby(["year", "round_number"])["LapTime"].transform("min")
    team_best = green.groupby(["year", "round_number", "Team"])["LapTime"].min().reset_index()
    race_best_overall_lookup = green.groupby(["year", "round_number"])["LapTime"].min().reset_index()
    race_best_overall_lookup = race_best_overall_lookup.rename(columns={"LapTime": "race_best"})
    team_best = team_best.merge(race_best_overall_lookup, on=["year", "round_number"])
    team_best["deficit"] = team_best["LapTime"] - team_best["race_best"]
    return team_best


team_best_train = race_best_by_team(train_df)
team_pace_lookup = team_best_train.groupby(["year", "Team"])["deficit"].mean().reset_index()
team_pace_lookup = team_pace_lookup.rename(columns={"deficit": "team_pace"})
overall_mean_team_pace = team_pace_lookup["team_pace"].mean()

train_df = train_df.merge(team_pace_lookup, on=["year", "Team"], how="left")
dev_df = dev_df.merge(team_pace_lookup, on=["year", "Team"], how="left")
# a (year, Team) combo in dev with zero appearances in train (shouldn't
# happen given the split is by race not by team, but guard anyway) falls
# back to the average team_pace rather than becoming NaN
train_df["team_pace"] = train_df["team_pace"].fillna(overall_mean_team_pace)
dev_df["team_pace"] = dev_df["team_pace"].fillna(overall_mean_team_pace)
print(f"team_pace: {train_df['team_pace'].isna().sum()} NaN in train, "
      f"{dev_df['team_pace'].isna().sum()} NaN in dev after fallback")

# ---------------------------------------------------------------------------
# 5. Pace-delta target — identical definition to the notebook's section 6.
# ---------------------------------------------------------------------------
def add_delta_target(df):
    green = df[df["TrackStatusBucket"] == "green"]
    df["PersonalBest"] = green.groupby(["Driver", "year", "location"])["LapTime"].transform("min")
    df["PersonalBest"] = df.groupby(["Driver", "year", "location"])["PersonalBest"].transform("min")
    df["LapTimeDelta"] = df["LapTime"] - df["PersonalBest"]
    return df


train_df = add_delta_target(train_df)
dev_df = add_delta_target(dev_df)

# ---------------------------------------------------------------------------
# 6. Save. Same gitignore pattern as data/train.csv, data/dev.csv.
# ---------------------------------------------------------------------------
train_df.to_csv("../data/train_enriched.csv", index=False)
dev_df.to_csv("../data/dev_enriched.csv", index=False)
print(f"Wrote data/train_enriched.csv {train_df.shape}, data/dev_enriched.csv {dev_df.shape}")
