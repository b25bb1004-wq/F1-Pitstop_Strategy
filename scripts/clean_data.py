#!/usr/bin/env python3
"""Clean train.csv/dev.csv into train_clean.csv/dev_clean.csv: drop columns
that carry zero information, remove laps whose recorded time doesn't
represent honest pace, drop rows missing the fields every downstream model
needs, and fix a unit/type inconsistency in the sector-time columns.

This is a new, explicit stage in the pipeline (data_pull.py -> split.py ->
clean_data.py -> enrich_data.py -> model_*.py), not folded silently into
enrich_data.py, so what got removed and why is auditable on its own rather
than buried inside a feature-engineering script.

Run from scripts/: `python clean_data.py`
"""
import pandas as pd

for name in ["train", "dev"]:
    df = pd.read_csv(f"../data/{name}.csv", low_memory=False)
    before = len(df)
    print(f"\n=== {name}.csv: {before} rows, {df.shape[1]} columns ===")

    # ---------------------------------------------------------------------
    # 1. Drop columns that carry zero information for every row in this
    #    dataset (verified, not assumed - see notes/data_cleaning_report.md
    #    for the audit that found these): PitOutTime/PitInTime are 100% null
    #    (data_pull.py's IsAccurate filter excludes in/out laps entirely, so
    #    these columns never get populated), IsAccurate is always True (the
    #    same filter means every remaining row already satisfies it) and
    #    FastF1Generated is always False (no synthetic laps survive the
    #    IsAccurate filter either).
    # ---------------------------------------------------------------------
    dead_cols = ["PitOutTime", "PitInTime", "IsAccurate", "FastF1Generated"]
    dead_cols = [c for c in dead_cols if c in df.columns]
    df = df.drop(columns=dead_cols)
    print(f"dropped {len(dead_cols)} dead columns: {dead_cols}")

    # ---------------------------------------------------------------------
    # 2. Remove laps FastF1 marks Deleted (track-limits violations, almost
    #    entirely). A deleted lap's recorded LapTime doesn't represent
    #    honest pace - it's frequently unrealistically fast because it's
    #    exactly the laps that gained time by leaving the track that get
    #    deleted. Left in, these contaminate degradation curves with laps
    #    that are fast for a reason that has nothing to do with tyres.
    #    IsAccurate being True for these rows doesn't already exclude them -
    #    that flag and Deleted measure different things.
    # ---------------------------------------------------------------------
    deleted_mask = df["Deleted"].astype(bool)
    n_deleted = deleted_mask.sum()
    df = df[~deleted_mask].drop(columns=["Deleted", "DeletedReason"])
    print(f"removed {n_deleted} laps deleted for track-limits violations "
          f"({n_deleted/before:.2%} of rows)")

    # ---------------------------------------------------------------------
    # 3. Drop rows missing Compound or TyreLife - every model in this
    #    project, per-compound modeling especially, needs both. dev.csv has
    #    a much higher Compound-missing rate (2.7%) than train (0.1%) - a
    #    real, pre-existing gap between the splits, not introduced by this
    #    cleaning step; flagged here rather than silently absorbed.
    # ---------------------------------------------------------------------
    before_na_drop = len(df)
    n_missing_compound = df["Compound"].isna().sum()
    n_missing_tyrelife = df["TyreLife"].isna().sum()
    df = df.dropna(subset=["Compound", "TyreLife"])
    print(f"dropped {n_missing_compound} rows missing Compound, "
          f"{n_missing_tyrelife} missing TyreLife "
          f"({before_na_drop - len(df)} rows total, some overlap)")

    # ---------------------------------------------------------------------
    # 4. Sector times are stored as timedelta strings ("0 days 00:01:23...")
    #    while LapTime was already converted to numeric seconds by
    #    data_pull.py - an inconsistency nothing currently depends on, but
    #    worth fixing so these columns are actually usable later instead of
    #    silently useless.
    # ---------------------------------------------------------------------
    for col in ["Sector1Time", "Sector2Time", "Sector3Time"]:
        df[col] = pd.to_timedelta(df[col]).dt.total_seconds()

    df.to_csv(f"../data/{name}_clean.csv", index=False)
    print(f"wrote data/{name}_clean.csv: {len(df)} rows "
          f"({before - len(df)} removed total: {n_deleted} track-limits laps, "
          f"{before_na_drop - len(df)} missing Compound/TyreLife), "
          f"{df.shape[1]} columns")
