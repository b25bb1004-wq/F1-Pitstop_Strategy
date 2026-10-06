#!/usr/bin/env bash
# Full Pitwall v2 pipeline, end to end. Needs the FastF1 cache in ./cache
# (offline; no API calls). Roughly 20 minutes on a laptop.
set -euo pipefail
cd "$(dirname "$0")"

python -m pitwall.build      # cache -> data/pitwall/laps.parquet (every lap, 2021-2025)
python -m pitwall.tune       # decision parameters on 2024 only -> reports/decision_tuning_dev.csv
python -m pitwall.evaluate   # held-out evaluation -> reports/metrics.json
python -m pitwall.train      # final fit on all seasons -> models/pitwall.pkl
python -m pitwall.figures    # reports/figures/*.png
python -m pitwall.report     # reports/RESULTS.md
python -m pitwall.export_web # app data -> web/public/data/*.json
python -m pitwall.export_tracks # circuit outlines -> web/public/data/tracks.json (needs the cache)
