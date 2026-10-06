"""The structural model must recover known physics from synthetic races."""
import numpy as np
import pandas as pd

from pitwall.structural import Structural

TRUE = {"fuel": 0.03, "deg": {"SOFT": 0.09, "MEDIUM": 0.05, "HARD": 0.03},
        "off": {"SOFT": -0.5, "MEDIUM": 0.0, "HARD": 0.4}}


def synthetic(seed=0, races=16, drivers=12, laps=55):
    rng = np.random.default_rng(seed)
    rows = []
    for r in range(races):
        circuit = f"C{r % 4}"
        for d in range(drivers):
            base = 90 + rng.normal(0, 1)
            first, second = rng.choice([("SOFT", "HARD"), ("MEDIUM", "HARD"), ("HARD", "MEDIUM"),
                                        ("SOFT", "MEDIUM")])
            stop = rng.integers(14, 35)
            for n in range(2, laps + 1):
                stint = 1 if n <= stop else 2
                comp = first if stint == 1 else second
                age = n if stint == 1 else n - stop
                fuel = 100 * (laps - n + 0.5) / laps
                t = (base + TRUE["off"][comp] + TRUE["fuel"] * fuel + TRUE["deg"][comp] * age
                     + rng.normal(0, 0.3))
                rows.append(dict(race_id=f"R{r}", circuit=circuit, Driver=f"D{d}", LapNumber=n,
                                 Stint=stint, Compound=comp, age=age, lap_in_stint=age, fuel_kg=fuel,
                                 TrackTemp=35.0, gap1=0.0, gap2=0.0, L=1.0, LapTime=t))
    return pd.DataFrame(rows)


def test_recovers_fuel_degradation_and_offsets():
    m = Structural.fit(synthetic(), verbose=False)
    assert abs(m.get("fuel", "fuel") - TRUE["fuel"]) < 0.004
    for c, slope in TRUE["deg"].items():
        curve = m.deg_curve(c, [5, 25])
        assert abs((curve[1] - curve[0]) / 20 - slope) < 0.012, c
    gap = m.offset("HARD") - m.offset("SOFT")
    assert abs(gap - (TRUE["off"]["HARD"] - TRUE["off"]["SOFT"])) < 0.25


def test_in_race_refit_learns_a_new_base_pace():
    df = synthetic(seed=1)
    m = Structural.fit(df[df["race_id"] != "R0"], verbose=False)
    race = df[df["race_id"] == "R0"]
    local = m.fit_local(race[race["LapNumber"] <= 20])
    later = race[race["LapNumber"] > 20]
    err = np.abs(m.predict_with_local(later, local) - later["LapTime"]).mean()
    assert err < 0.6
