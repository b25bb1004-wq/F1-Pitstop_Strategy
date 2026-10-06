"""Shared paths and constants for the Pitwall pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "cache"
PITWALL_DATA = ROOT / "data" / "pitwall"
MODEL_DIR = ROOT / "models"
REPORT_DIR = ROOT / "reports"
FIG_DIR = REPORT_DIR / "figures"

YEARS = range(2021, 2026)

# Temporal split by season: fit on the past, select on 2024, report on 2025.
TRAIN_YEARS = (2021, 2022, 2023)
DEV_YEARS = (2024,)
TEST_YEARS = (2025,)

DRY = ("SOFT", "MEDIUM", "HARD")

# FastF1 reports some venues under two names across seasons.
CIRCUIT_ALIASES = {
    "Monte Carlo": "Monaco",
    "Miami Gardens": "Miami",
    "Yas Marina": "Yas Island",
}

REF_LAP = 90.0          # effects are expressed per 90 s of lap time
START_FUEL_KG = 100.0   # race start fuel load (2022+ limit is 110 kg; ~100 typical)


def normalise_circuit(name):
    return CIRCUIT_ALIASES.get(name, name)
