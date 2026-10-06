# Pitwall v2: results

Generated from `reports/metrics.json` by `python -m pitwall.report`. Protocol: fit on [2021, 2022, 2023], tune on [2024] (dev), refit on train+dev and report [2025] (test) once. Splits are whole seasons, so no lap, stint or race of an evaluation season is ever seen in fitting.

## 1. What the structural model learned (fit on 2021-2024)

| Quantity | Value |
|---|---|
| Fuel effect | 0.0334 s per kg per 90 s lap (~0.058 s per lap of fuel burned) |
| SOFT: offset vs fresh MEDIUM / loss at age 10, 20, 30 | +0.517 s / +0.26, +0.87, +1.72 s |
| MEDIUM: offset vs fresh MEDIUM / loss at age 10, 20, 30 | +0.000 s / +0.73, +1.34, +2.00 s |
| HARD: offset vs fresh MEDIUM / loss at age 10, 20, 30 | +0.087 s / +0.55, +1.08, +1.59 s |
| Traffic: gap < 1 s / 1-2 s | +0.412 s / +0.199 s |
| Lap-to-lap noise (robust sigma) | 0.409 s |

## 2. Lap-time prediction

### 2a. In-race (laps up to k seen, every later lap predicted; k = 5, 10, 15, ...)

**dev (110,814 predictions), MAE in seconds**

| Model | all | 1-5 laps ahead | 6-10 laps ahead | 11-20 laps ahead | 21-99 laps ahead | RMSE |
|---|---|---|---|---|---|---|
| last_lap | 1.166 | 0.590 | 0.841 | 1.082 | 1.559 | 1.517 |
| mean_last5 | 1.171 | 0.603 | 0.825 | 1.072 | 1.576 | 1.479 |
| inrace_linear | 2.747 | 0.587 | 0.925 | 1.610 | 4.927 | 5.315 |
| structural | 0.777 | 0.501 | 0.590 | 0.703 | 0.996 | 1.203 |
| structural+gbm | 0.776 | 0.518 | 0.600 | 0.701 | 0.985 | 1.149 |

**test (109,883 predictions), MAE in seconds**

| Model | all | 1-5 laps ahead | 6-10 laps ahead | 11-20 laps ahead | 21-99 laps ahead | RMSE |
|---|---|---|---|---|---|---|
| last_lap | 1.111 | 0.536 | 0.779 | 1.018 | 1.519 | 1.430 |
| mean_last5 | 1.148 | 0.581 | 0.796 | 1.040 | 1.570 | 1.444 |
| inrace_linear | 2.549 | 0.607 | 0.947 | 1.565 | 4.508 | 4.671 |
| structural | 0.748 | 0.491 | 0.594 | 0.707 | 0.931 | 1.087 |
| structural+gbm | 0.749 | 0.495 | 0.592 | 0.707 | 0.933 | 1.070 |

Residual booster kept: False (chosen on dev).

### 2b. Pre-race (no laps of the race seen; conditions + form from earlier races)

| Model | dev MAE | dev RMSE | dev R2 | test MAE | test RMSE | test R2 |
|---|---|---|---|---|---|---|
| old_pitwall_ridge | 2.307 | 3.498 | 0.888 | 1.708 | 2.145 | 0.951 |
| prerace_gbm | 2.292 | 4.050 | 0.850 | 1.995 | 2.632 | 0.926 |
| prerace_structural | 2.115 | 3.332 | 0.899 | 1.556 | 2.055 | 0.955 |

## 3. Pit loss and race-time simulation

| | dev | test |
|---|---|---|
| Green stops scored | 514 | 465 |
| Pit-loss MAE, per-circuit model | 1.58 s | 1.53 s |
| Pit-loss MAE, constant 22 s | 2.46 s | 2.16 s |
| Remaining-race time from lap 10, drivers | 170 | 190 |
| ... model MAE (MAPE) | 40.4 s (0.96%) | 25.8 s (0.62%) |
| ... naive pace x laps + 22 s/stop | 64.6 s (1.54%) | 54.3 s (1.32%) |

## 4. Pit-stop decision backtest (every driver, every mid-stint lap, dry races)

**dev: 21,854 lap states, 630 real stops**

| Decision model | P | R | F1 (exact lap) | F1 +-1 lap | F1 +-2 laps | first call within 2 laps | median first-call error | SC/VSC balanced acc. | SC/VSC F1 | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|---|
| optimiser_in_race | 0.10 | 0.50 | 0.16 | 0.26 | 0.33 | 22.9% | 15.0 laps | 77.4% | 0.40 | nan |
| optimiser_pre_race_only | 0.09 | 0.28 | 0.14 | 0.21 | 0.25 | 14.0% | inf laps | 80.2% | 0.51 | nan |
| imitation_basic | 0.17 | 0.40 | 0.24 | 0.35 | 0.41 | 21.7% | inf laps | 76.2% | 0.50 | 0.868 |
| imitation_rivals | 0.26 | 0.45 | 0.33 | 0.46 | 0.53 | 31.0% | 11.0 laps | 75.5% | 0.53 | 0.900 |
| hybrid_optimiser_features | 0.34 | 0.36 | 0.35 | 0.45 | 0.50 | 28.4% | inf laps | 73.3% | 0.54 | 0.892 |
| leaky_current_lap_time | 0.89 | 0.81 | 0.85 | 0.86 | 0.87 | 78.3% | 0.0 laps | 70.4% | 0.54 | 0.993 |

**test: 22,331 lap states, 625 real stops**

| Decision model | P | R | F1 (exact lap) | F1 +-1 lap | F1 +-2 laps | first call within 2 laps | median first-call error | SC/VSC balanced acc. | SC/VSC F1 | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|---|
| optimiser_in_race | 0.09 | 0.52 | 0.15 | 0.24 | 0.31 | 19.4% | 17.5 laps | 68.7% | 0.34 | nan |
| optimiser_pre_race_only | 0.10 | 0.42 | 0.16 | 0.24 | 0.31 | 16.8% | inf laps | 68.0% | 0.35 | nan |
| imitation_basic | 0.15 | 0.58 | 0.23 | 0.35 | 0.42 | 25.6% | 11.0 laps | 67.4% | 0.39 | 0.864 |
| imitation_rivals | 0.19 | 0.57 | 0.29 | 0.40 | 0.48 | 30.4% | 8.0 laps | 74.6% | 0.51 | 0.892 |
| hybrid_optimiser_features | 0.24 | 0.47 | 0.32 | 0.41 | 0.47 | 29.8% | 15.5 laps | 71.2% | 0.49 | 0.889 |
| leaky_current_lap_time | 0.88 | 0.81 | 0.84 | 0.85 | 0.86 | 78.0% | 0.0 laps | 70.9% | 0.56 | 0.995 |

