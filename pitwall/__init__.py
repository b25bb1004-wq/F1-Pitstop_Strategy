"""Pitwall: F1 lap-time, tyre-degradation and pit-stop decision pipeline."""
import warnings

import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=pd.errors.PerformanceWarning)
pd.set_option("future.no_silent_downcasting", True)
