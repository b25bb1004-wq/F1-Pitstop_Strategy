"""Behavioural checks on the pit-stop optimiser with the shipped model."""
from pitwall.strategy import RaceState, decide


def run(bundle, **kw):
    base = dict(circuit="Sakhir", lap=20, race_laps=57, compound="MEDIUM", tyre_age=19,
                two_compounds=False, status="green", track_temp=35.0)
    base.update(kw)
    return decide(bundle["model"], bundle["tables"], RaceState(**base))


def test_safety_car_makes_stopping_more_attractive(bundle):
    # worn tyres, early in the window: green says wait, an SC says box now
    green = run(bundle, lap=12, tyre_age=11)
    sc = run(bundle, lap=12, tyre_age=11, status="sc")
    assert not green["pit_now"] and sc["pit_now"]
    assert sc["gain_if_pit_now_s"] > green["gain_if_pit_now_s"]


def test_two_compound_rule_forces_a_switch(bundle):
    r = run(bundle, lap=40, tyre_age=39, two_compounds=False)
    fits = [s["fit"] for s in r["plan"]["stops"]]
    assert fits and any(f != "MEDIUM" for f in fits)


def test_no_stop_near_the_flag_when_rule_met(bundle):
    r = run(bundle, lap=55, tyre_age=20, two_compounds=True, compound="HARD")
    assert not r["pit_now"] and r["plan"]["stops"] == []


def test_tyres_far_past_the_cliff_come_in(bundle):
    r = run(bundle, lap=30, tyre_age=60, compound="SOFT", two_compounds=True)
    assert r["pit_now"]


def test_window_is_relative_to_its_best_lap(bundle):
    r = run(bundle)
    deltas = [w["delta_s"] for w in r["window"]]
    assert min(deltas) == 0 and all(d >= 0 for d in deltas)


def test_fresh_tyres_do_not_pit_under_green(bundle):
    r = run(bundle, lap=10, tyre_age=1, compound="HARD", two_compounds=True)
    assert not r["pit_now"]
