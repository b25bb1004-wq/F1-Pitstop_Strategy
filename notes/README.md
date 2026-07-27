# Notes

Written records of how the project was built and what each experiment found — including the
bugs. Suggested reading order:

1. [`project_summary.md`](project_summary.md) — build history: the data pipeline, the
   duplicate-lap and schema-corruption bugs and their fixes, the train/dev/test split design,
   and the feature-engineering decisions.
2. [`linear_regression_experiment.md`](linear_regression_experiment.md) — the first modeling
   pass (Ridge on absolute lap time): why R² ≈ 0.91 is mostly a circuit-baseline lookup, and
   the TyreLife-coefficient problem.
3. [`degradation_experiment_report.md`](degradation_experiment_report.md) — the follow-up
   experiment: real weather merged from the cache, traffic/stint features, and the pace-delta
   target that finally produced physically sensible degradation curves.
