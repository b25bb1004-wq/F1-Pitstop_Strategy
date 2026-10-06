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
| structural | 0.626 | 0.464 | 0.541 | 0.603 | 0.733 | 0.884 |
| structural+gbm | 0.622 | 0.471 | 0.543 | 0.601 | 0.723 | 0.880 |

**test (109,883 predictions), MAE in seconds**

| Model | all | 1-5 laps ahead | 6-10 laps ahead | 11-20 laps ahead | 21-99 laps ahead | RMSE |
|---|---|---|---|---|---|---|
| last_lap | 1.111 | 0.536 | 0.779 | 1.018 | 1.519 | 1.430 |
| mean_last5 | 1.148 | 0.581 | 0.796 | 1.040 | 1.570 | 1.444 |
| inrace_linear | 2.549 | 0.607 | 0.947 | 1.565 | 4.508 | 4.671 |
| structural | 0.616 | 0.446 | 0.534 | 0.599 | 0.723 | 0.858 |
| structural+gbm | 0.614 | 0.447 | 0.533 | 0.601 | 0.717 | 0.849 |

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
| ... model MAE (MAPE) | 32.4 s (0.76%) | 20.0 s (0.49%) |
| ... naive pace x laps + 22 s/stop | 64.6 s (1.54%) | 54.3 s (1.32%) |

## 4. Pit-stop decision backtest (every driver, every mid-stint lap, dry races)

**dev: 21,854 lap states, 630 real stops**

| Decision model | P | R | F1 (exact lap) | F1 +-1 lap | F1 +-2 laps | first call within 2 laps | median first-call error | SC/VSC balanced acc. | SC/VSC F1 | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|---|
| optimiser_in_race | 0.11 | 0.40 | 0.17 | 0.27 | 0.33 | 21.4% | n/a laps | 78.0% | 0.42 | nan |
| optimiser_pre_race_only | 0.09 | 0.28 | 0.14 | 0.21 | 0.25 | 14.0% | n/a laps | 80.2% | 0.51 | nan |
| imitation_basic | 0.14 | 0.43 | 0.22 | 0.33 | 0.40 | 19.0% | n/a laps | 81.6% | 0.51 | 0.846 |
| pit_call_model | 0.26 | 0.42 | 0.32 | 0.44 | 0.51 | 26.5% | 20.0 laps | 69.0% | 0.43 | 0.884 |
| hybrid_optimiser_features | 0.28 | 0.33 | 0.31 | 0.41 | 0.47 | 22.9% | n/a laps | 65.2% | 0.39 | 0.871 |
| leaky_current_lap_time | 0.90 | 0.81 | 0.85 | 0.86 | 0.86 | 77.8% | 0.0 laps | 68.8% | 0.53 | 0.992 |

**test: 22,331 lap states, 625 real stops**

| Decision model | P | R | F1 (exact lap) | F1 +-1 lap | F1 +-2 laps | first call within 2 laps | median first-call error | SC/VSC balanced acc. | SC/VSC F1 | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|---|
| optimiser_in_race | 0.10 | 0.48 | 0.16 | 0.25 | 0.33 | 19.9% | 22.0 laps | 66.9% | 0.33 | nan |
| optimiser_pre_race_only | 0.10 | 0.42 | 0.16 | 0.24 | 0.31 | 16.8% | n/a laps | 68.0% | 0.35 | nan |
| imitation_basic | 0.12 | 0.56 | 0.19 | 0.31 | 0.40 | 20.4% | 13.0 laps | 63.9% | 0.30 | 0.844 |
| pit_call_model | 0.21 | 0.41 | 0.27 | 0.38 | 0.45 | 24.0% | 28.5 laps | 70.5% | 0.47 | 0.876 |
| hybrid_optimiser_features | 0.22 | 0.37 | 0.27 | 0.38 | 0.43 | 22.9% | n/a laps | 71.0% | 0.49 | 0.872 |
| leaky_current_lap_time | 0.90 | 0.79 | 0.84 | 0.85 | 0.85 | 75.3% | 0.0 laps | 66.6% | 0.48 | 0.994 |

