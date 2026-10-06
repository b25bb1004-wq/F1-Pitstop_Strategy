"""Stage 3: the structural lap-time model.

    LapTime = base[driver, race]                           (car + driver + track on the day)
            + L * offset[compound]   (global + circuit + race deviations)
            + L * b_fuel * fuel_kg                          (lighter car + track evolution)
            + L * deg_c(age)                                (piecewise-linear tyre curve per compound)
            + L * age * (b_temp_c * (TrackTemp - 35) / 10)   (hotter track, faster wear)
            + L * age * (d_circuit_c + d_race_c)            (track- and race-specific wear rate)
            + L * (cold tyre, traffic, opening-lap terms)

L is the race's typical lap divided by 90 s, so every coefficient is "seconds
per 90 s lap" and transfers between Monaco and Spa. The per-driver-race base
removes the circuit/driver confound that made the old absolute-time Ridge look
good (R2 0.91) while learning almost no tyre physics: degradation and fuel are
identified only from variation *within* each driver's race. Fuel and tyre age
both grow linearly inside a stint, so they are separated by the stint
boundaries (tyre age resets, fuel keeps falling).

It is one penalised least-squares problem. Each block has a Gaussian prior
(ridge penalty = sigma^2 / prior_sd^2); hierarchical deviations (circuit,
race) shrink toward the global curve when data are thin. The race-level
blocks are re-solved during a live race from the laps seen so far
(`fit_local`), which is how the model adapts to the day's degradation.
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import scipy.sparse as sp

from pitwall.config import DRY

KNOTS = (0, 4, 10, 18, 28, 40)          # piecewise-linear tyre-age basis
OFF_COMPOUNDS = ("SOFT", "HARD")         # MEDIUM is the reference compound

# prior standard deviations (seconds per 90 s lap units)
PRIOR_SD = {
    "fe": 1e3, "off_g": 1e3, "fuel": 1e3,
    "off_circ": 0.35, "off_race": 0.35,
    "deg0": 1.0, "deg": 0.08, "temp": 0.02,
    "deg_circ": 0.03, "deg_race": 0.03,
    "cold": 1.0, "traffic": 1.0, "early": 1.0,
}
LOCAL_BLOCKS = ("fe", "off_race", "deg_race")


def age_basis(age):
    age = np.asarray(age, dtype=float)
    return np.column_stack([np.maximum(age - k, 0.0) for k in KNOTS])


def _groups(*arrays):
    """Yield (key, row positions) per distinct key. (pandas groupby on a
    Series of tuples segfaults on this pandas build, so group by hand.)"""
    if len(arrays[0]) == 0:
        return
    joined = ["\x1f".join(map(str, t)) for t in zip(*arrays)]
    codes, _ = pd.factorize(pd.Series(joined))
    order = np.argsort(codes, kind="stable")
    for chunk in np.split(order, np.flatnonzero(np.diff(codes[order])) + 1):
        first = chunk[0]
        key = tuple(a[first] for a in arrays) if len(arrays) > 1 else arrays[0][first]
        yield key, chunk


def _columns(df):
    """Yield (block, key, row_index, values) for every non-zero design entry."""
    n = len(df)
    idx = np.arange(n)
    L = df["L"].to_numpy(float)
    age = df["age"].to_numpy(float)
    comp = df["Compound"].to_numpy()
    circ = df["circuit"].to_numpy()
    race = df["race_id"].to_numpy()
    drv = df["Driver"].to_numpy()
    temp = (df["TrackTemp"].to_numpy(float) - 35.0) / 10.0

    for key, rows in _groups(race, drv):
        yield "fe", key, rows, np.ones(len(rows))
    yield "fuel", "fuel", idx, df["fuel_kg"].to_numpy(float) * L
    basis = age_basis(age)
    for c in DRY:
        m = comp == c
        rows = idx[m]
        if c in OFF_COMPOUNDS:
            yield "off_g", c, rows, L[m]
            for k_name, k_arr in (("off_circ", circ), ("off_race", race)):
                for key, sub in _groups(k_arr[m]):
                    r = rows[sub]
                    yield k_name, (key, c), r, L[r]
        for j in range(len(KNOTS)):
            yield ("deg0" if j == 0 else "deg"), (c, j), rows, basis[m, j] * L[m]
        yield "temp", c, rows, age[m] * temp[m] * L[m]
        for k_name, k_arr in (("deg_circ", circ), ("deg_race", race)):
            for key, sub in _groups(k_arr[m]):
                r = rows[sub]
                yield k_name, (key, c), r, age[r] * L[r]
        cold = m & (df["lap_in_stint"].to_numpy() == 2)
        yield "cold", c, idx[cold], L[cold]
    for g in ("gap1", "gap2"):
        v = df[g].to_numpy(float)
        yield "traffic", g, idx[v > 0], (v * L)[v > 0]
    lapn = df["LapNumber"].to_numpy()
    for k in (2, 3):
        m = lapn == k
        yield "early", f"lap{k}", idx[m], L[m]
    # opening stint: pack running and tyre management that is not tyre wear
    m = df["Stint"].to_numpy() == 1
    yield "early", "stint1", idx[m], L[m]


def design(df, registry=None, blocks=None):
    """Sparse design matrix. With a registry, unknown keys are dropped (= 0)."""
    build = registry is None
    registry = {} if build else registry
    rows, cols, vals = [], [], []
    for block, key, r, v in _columns(df):
        if blocks is not None and block not in blocks:
            continue
        if len(r) == 0:
            continue
        name = (block, key)
        if name not in registry:
            if not build:
                continue
            registry[name] = len(registry)
        rows.append(r)
        cols.append(np.full(len(r), registry[name]))
        vals.append(v)
    if not vals:
        return sp.csr_matrix((len(df), len(registry))), registry
    X = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))),
                      shape=(len(df), len(registry)))
    return X, registry


def _penalty(registry, sigma):
    lam = np.empty(len(registry))
    for (block, _), j in registry.items():
        lam[j] = sigma ** 2 / PRIOR_SD[block] ** 2
    return lam


def _solve(X, y, lam):
    A = (X.T @ X).toarray()
    A[np.diag_indices_from(A)] += lam
    # numpy, not scipy.linalg.solve(assume_a="pos"): the latter corrupts memory
    # after a few calls on scipy 1.17 / numpy 2.4 (reproducible segfault)
    return np.linalg.solve(A, X.T @ y)


@dataclass
class Structural:
    coef: dict = field(default_factory=dict)   # (block, key) -> value
    sigma: float = 0.5
    n_laps: int = 0

    # ---------- fitting ----------
    @classmethod
    def fit(cls, rep, sigma=0.6, passes=2, verbose=True):
        data = rep
        for p in range(passes):
            X, reg = design(data)
            lam = _penalty(reg, sigma)
            b = _solve(X, data["LapTime"].to_numpy(float), lam)
            resid = data["LapTime"].to_numpy(float) - X @ b
            mad = 1.4826 * np.median(np.abs(resid - np.median(resid)))
            sigma = float(mad)
            if verbose:
                print(f"  structural pass {p + 1}: {len(data)} laps, {len(reg)} params, "
                      f"robust sigma {sigma:.3f}s")
            if p < passes - 1:   # drop gross outliers (mistakes, traffic jams) and refit
                data = data[np.abs(resid) < 4 * sigma]
        model = cls({name: b[j] for name, j in reg.items()}, sigma, len(data))
        return model

    # ---------- prediction ----------
    def predict(self, df, blocks=None):
        names = [n for n in self.coef if blocks is None or n[0] in blocks]
        reg = {n: i for i, n in enumerate(names)}
        X, _ = design(df, reg, blocks)
        return X @ np.array([self.coef[n] for n in names])

    def predict_global(self, df):
        return self.predict(df, blocks=[b for b in PRIOR_SD if b not in LOCAL_BLOCKS])

    def fit_local(self, obs, deg_sd=None):
        """Re-solve base pace, race compound offsets and race wear rates from
        laps already seen in a race, holding everything else fixed. `deg_sd`
        overrides the prior on the race wear-rate deviation (smaller = trust
        the historical curve more)."""
        if len(obs) == 0:
            return {}
        r = obs["LapTime"].to_numpy(float) - self.predict_global(obs)
        X, reg = design(obs, blocks=LOCAL_BLOCKS)
        lam = _penalty(reg, self.sigma)
        if deg_sd is not None:
            for (block, _), j in reg.items():
                if block == "deg_race":
                    lam[j] = self.sigma ** 2 / max(deg_sd, 1e-6) ** 2
        b = _solve(X, r, lam)
        return {name: b[j] for name, j in reg.items()}

    def predict_with_local(self, df, local):
        """Global prediction + race-local terms. Drivers with no base yet get
        the median base of the field seen so far."""
        pred = self.predict_global(df)
        merged = Structural(dict(local), self.sigma)
        pred = pred + merged.predict(df, blocks=["off_race", "deg_race"])
        fe = {k[1]: v for k, v in local.items() if k[0] == "fe"}
        default = np.median(list(fe.values())) if fe else np.nan
        base = np.array([fe.get((r, d), default) for r, d in zip(df["race_id"], df["Driver"])])
        return pred + base

    # ---------- reading the physics back out ----------
    def get(self, block, key, default=0.0):
        return self.coef.get((block, key), default)

    def deg_curve(self, compound, ages, circuit=None, track_temp=35.0, race_id=None, local=None):
        """Seconds lost vs a fresh tyre at each age, per 90 s lap (excl. offset)."""
        ages = np.asarray(ages, float)
        b = age_basis(ages)
        curve = sum(b[:, j] * self.get("deg0" if j == 0 else "deg", (compound, j))
                    for j in range(len(KNOTS)))
        slope = self.get("temp", compound) * (track_temp - 35.0) / 10.0
        if circuit is not None:
            slope += self.get("deg_circ", (circuit, compound))
        if race_id is not None:
            slope += (local or self.coef).get(("deg_race", (race_id, compound)), 0.0)
        return curve + slope * ages

    def offset(self, compound, circuit=None, race_id=None, local=None):
        if compound not in OFF_COMPOUNDS:
            return 0.0
        v = self.get("off_g", compound)
        if circuit is not None:
            v += self.get("off_circ", (circuit, compound))
        if race_id is not None:
            v += (local or self.coef).get(("off_race", (race_id, compound)), 0.0)
        return v

    def summary(self):
        out = {"fuel_s_per_kg_per_90s": self.get("fuel", "fuel"), "sigma": self.sigma,
               "n_laps": self.n_laps}
        for c in DRY:
            out[f"offset_{c}"] = self.offset(c)
            out[f"cold_{c}"] = self.get("cold", c)
            out[f"temp_slope_{c}_per10C"] = self.get("temp", c)
            curve = self.deg_curve(c, [1, 10, 20, 30])
            out[f"deg_{c}_lap10_20_30"] = [round(float(x - curve[0]), 3) for x in curve[1:]]
        out["traffic_gap<1s"] = self.get("traffic", "gap1")
        out["traffic_gap1-2s"] = self.get("traffic", "gap2")
        return out
