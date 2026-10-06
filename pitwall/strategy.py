"""Stage 5: the race-strategy optimiser and the "pit now?" decision.

The decision is not a classifier. At the start of lap n the car is in state

    (compound c, laps already on this set a, two-compound rule met f, track state s)

with s in {green, SC, VSC}. A backward dynamic program over the remaining laps
finds the strategy with the lowest *expected* remaining race time:

    V_n(c, a, f, s) = min(  stay:   T(c, a+1) + E[V_{n+1}(c, a+1, f, s')]
                            pit c': T(c, a+1) + PitLoss(s) + E[V_{n+1}(c', 0, f or c' != c, s')] )

T(c, age) is the structural model's lap time cost of compound c at that tyre
age (compound offset + degradation curve + cold-tyre lap, scaled to the
track); fuel and base pace are identical for every strategy so they cancel.
s' follows the circuit's green/SC/VSC Markov chain, so the optimiser knows a
Safety Car may arrive and make a stop nearly free, and values "staying out
for a possible SC" correctly. Finishing a dry race without two compounds costs
a prohibitive penalty (the regulations require it).

"Pit now" = the optimal action at the current state is to pit this lap. The
time gain (V_stay - V_pit) is reported, and a bootstrap over refitted
degradation models gives the probability that pitting now is right.
"""
from dataclasses import dataclass

import numpy as np

from pitwall.config import DRY
from pitwall.pitstops import GREEN, SC, VSC, transition_matrix

BIG = 1e5
CLIFF = 0.05          # s per 90 s lap per (lap beyond observed stint length)^2
STATUS = {"green": GREEN, "sc": SC, "vsc": VSC}

# Chosen on the 2024 dev season only (reports/decision_tuning_dev.csv):
# - the *time* an SC stop costs is ~10% of a green stop once the queue closes
#   up, but teams behave as if it costs ~50%: track position given away under
#   the SC is hard to win back on track. The optimiser uses the effective value.
# - in-race wear-rate updates are shrunk harder than in the historical fit,
#   so a few noisy early laps cannot trigger an early stop.
DECISION = {"sc_ratio_eff": 0.5}


@dataclass
class RaceState:
    circuit: str
    lap: int                 # lap about to be driven; "pit now" = box at the end of it
    race_laps: int
    compound: str
    tyre_age: int            # laps already completed on the current set
    two_compounds: bool      # already used two dry compounds?
    status: str = "green"    # "green" | "sc" | "vsc" during this lap
    track_temp: float = 35.0
    L: float = None          # typical lap / 90 s; defaults to the circuit's history
    race_id: str = None
    local: dict = None       # race-local coefficients from Structural.fit_local


def lap_cost_table(model, tables, st, max_age):
    """T[c, age] for age 0..max_age, seconds relative to a fresh MEDIUM."""
    L = st.L or tables["circuit_L"].get(st.circuit, 1.0)
    ages = np.arange(max_age + 1)
    T = np.zeros((len(DRY), max_age + 1))
    for i, c in enumerate(DRY):
        curve = model.deg_curve(c, ages, circuit=st.circuit, track_temp=st.track_temp,
                                race_id=st.race_id, local=st.local)
        off = model.offset(c, circuit=st.circuit, race_id=st.race_id, local=st.local)
        cold = np.where(ages == 2, model.get("cold", c), 0.0)
        limit = tables["max_age"].get(f"{st.circuit}|{c}", tables["max_age"][f"_global|{c}"])
        cliff = CLIFF * np.maximum(ages - limit, 0) ** 2
        T[i] = L * (off + curve + cold + cliff)
    return T


def pit_losses(tables, circuit):
    p = tables["pit_loss"].get(circuit, tables["pit_loss"]["_global"])
    g = p["green"]
    return np.array([g, g * DECISION["sc_ratio_eff"], g * p["vsc_ratio"]])


def solve(T, pit_loss, P, n_from, N):
    """Backward induction. Returns (value at n_from, policy dict lap -> action array).
    action[c, a, f, s] = -1 to stay out, else the index of the compound to fit."""
    nc, A1 = T.shape
    A = A1 - 1
    V = np.full((nc, A1, 2, 3), BIG)
    V[:, :, 1, :] = 0.0                      # finished with two compounds
    policy = {}
    a_next = np.minimum(np.arange(A1) + 1, A)
    switch = np.array([[0 if c2 == c else 1 for c2 in range(nc)] for c in range(nc)])
    for n in range(N, n_from - 1, -1):
        EV = V @ P.T                          # expectation over next lap state
        lap = T[:, a_next]                    # cost of driving lap n on age a+1
        stay = lap[:, :, None, None] + EV[:, a_next, :, :]
        # pit: arrive on a fresh set of c2; rule met if f or c2 != c
        fresh = EV[:, 0, :, :]                # [c2, f, s]
        pit_vals = np.empty((nc, nc, 2, 3))
        for f in (0, 1):
            f_new = np.maximum(f, switch)     # [c, c2]
            pit_vals[:, :, f, :] = fresh[np.arange(nc)[None, :], f_new, :]
        pit_vals += pit_loss[None, None, None, :]
        best_c2 = pit_vals.argmin(axis=1)     # [c, f, s]
        best_pit = pit_vals.min(axis=1)
        pit = lap[:, :, None, None] + best_pit[:, None, :, :]
        action = np.where(pit < stay, best_c2[:, None, :, :], -1)
        V = np.minimum(stay, pit)
        policy[n] = (action, stay, pit)
    return V, policy


def decide(model, tables, st, samples=None):
    """Recommendation for one race state. `samples` are bootstrap models used
    for P(pit now is optimal)."""
    N = st.race_laps
    max_age = N + 45
    c = DRY.index(st.compound)
    a = int(min(max(st.tyre_age, 0), max_age))
    f = int(st.two_compounds)
    s = STATUS[st.status]
    PL = pit_losses(tables, st.circuit)
    P = transition_matrix(tables["neutral"].get(st.circuit, tables["neutral"]["_global"]))

    T = lap_cost_table(model, tables, st, max_age)
    _, policy = solve(T, PL, P, st.lap, N)
    action, stay, pit = policy[st.lap]
    gain = float(stay[c, a, f, s] - pit[c, a, f, s])
    act = int(action[c, a, f, s])

    p_pit = None
    if samples:
        votes = []
        for m in samples:
            Tm = lap_cost_table(m, tables, st, max_age)
            _, pol = solve(Tm, PL, P, st.lap, N)
            votes.append(pol[st.lap][0][c, a, f, s] >= 0)
        p_pit = float(np.mean(votes))

    return {
        "pit_now": act >= 0,
        "fit_compound": DRY[act] if act >= 0 else None,
        "gain_if_pit_now_s": round(gain, 2),
        "p_pit_now_optimal": p_pit,
        "pit_loss_s": dict(zip(("green", "sc", "vsc"), np.round(PL, 1).tolist())),
        "plan": plan(policy, T, PL, st.lap, N, c, a, f, s),
        "window": window(policy, st, T),
    }


def plan(policy, T, PL, n0, N, c, a, f, s):
    """Follow the optimal policy forward assuming green running after now."""
    stops, total = [], 0.0
    A = T.shape[1] - 1
    for n in range(n0, N + 1):
        act = int(policy[n][0][c, a, f, s])
        total += T[c, min(a + 1, A)]
        if act >= 0:
            total += PL[s]
            stops.append({"lap": n, "fit": DRY[act]})
            f = int(f or act != c)
            c, a = act, 0
        else:
            a = min(a + 1, A)
        s = GREEN
    return {"stops": stops, "remaining_tyre_cost_s": round(float(total), 1)}


def window(policy, st, T, horizon=12):
    """Expected remaining time if the stop happens k laps from now (k=0..horizon),
    relative to the best option: the classic pit-window curve."""
    N = st.race_laps
    c, a, f = DRY.index(st.compound), int(st.tyre_age), int(st.two_compounds)
    s = STATUS[st.status]
    rows = []
    A = T.shape[1] - 1
    for k in range(0, min(horizon, N - st.lap) + 1):
        n = st.lap + k
        drive = sum(T[c, min(a + j + 1, A)] for j in range(k))   # laps before the in-lap
        _, stay, pit = policy[n]
        ss = s if k == 0 else GREEN
        rows.append((n, drive + pit[c, min(a + k, A), f, ss]))
    best = min(v for _, v in rows)
    return [{"lap": n, "delta_s": round(float(v - best), 2)} for n, v in rows]
