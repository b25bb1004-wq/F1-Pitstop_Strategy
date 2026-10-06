/* Pitwall strategy core: a line-for-line port of pitwall/strategy.py.
 * Works in the browser (window.PitwallCore) and in Node (module.exports),
 * so tests/test_web_core.py can check it against the Python optimiser. */
(function (root) {
  "use strict";
  const BIG = 1e5;
  const GREEN = 0, SC = 1, VSC = 2;

  function lapCostTable(model, circ, temp, maxAge, boot) {
    const C = model.circuits[circ];
    const phys = boot ? boot.physics : model.physics;
    const T = [];
    model.compounds.forEach((c) => {
      const p = phys[c];
      const dc = boot ? (boot.deg_circ[circ + "|" + c] || 0) : (C.deg_circ[c] || 0);
      const oc = boot ? (boot.off_circ[circ + "|" + c] || 0) : (C.off_circ[c] || 0);
      const slope = p.temp * (temp - 35) / 10 + dc;
      const off = p.offset + oc;
      const limit = C.max_age[c];
      const row = new Float64Array(maxAge + 1);
      for (let a = 0; a <= maxAge; a++) {
        let curve = 0;
        for (let j = 0; j < p.knots.length; j++) curve += Math.max(a - p.knots[j], 0) * p.spline[j];
        const cold = a === 2 ? p.cold : 0;
        const cliff = model.cliff * Math.pow(Math.max(a - limit, 0), 2);
        row[a] = C.L * (off + curve + slope * a + cold + cliff);
      }
      T.push(row);
    });
    return T;
  }

  function pitLosses(model, circ) {
    const C = model.circuits[circ];
    return [C.pit_green, C.pit_green * model.sc_ratio_eff, C.pit_green * C.pit_vsc_ratio];
  }

  function solve(T, PL, P, nFrom, N) {
    const nc = T.length, A1 = T[0].length, A = A1 - 1;
    const size = nc * A1 * 6;
    const id = (c, a, f, s) => ((c * A1 + a) * 2 + f) * 3 + s;
    let V = new Float64Array(size).fill(BIG);
    for (let c = 0; c < nc; c++) for (let a = 0; a < A1; a++) for (let s = 0; s < 3; s++) V[id(c, a, 1, s)] = 0;
    const policy = {};
    const EV = new Float64Array(size);
    for (let n = N; n >= nFrom; n--) {
      for (let base = 0; base < size; base += 3) {
        for (let s = 0; s < 3; s++) {
          EV[base + s] = P[s][0] * V[base] + P[s][1] * V[base + 1] + P[s][2] * V[base + 2];
        }
      }
      const action = new Int8Array(size), stay = new Float64Array(size), pit = new Float64Array(size);
      const Vn = new Float64Array(size);
      for (let c = 0; c < nc; c++) {
        for (let a = 0; a < A1; a++) {
          const an = Math.min(a + 1, A);
          const lap = T[c][an];
          for (let f = 0; f < 2; f++) {
            for (let s = 0; s < 3; s++) {
              const k = id(c, a, f, s);
              const st = lap + EV[id(c, an, f, s)];
              let best = Infinity, bestC = -1;
              for (let c2 = 0; c2 < nc; c2++) {
                const fn = Math.max(f, c2 !== c ? 1 : 0);
                const v = PL[s] + EV[id(c2, 0, fn, s)];
                if (v < best) { best = v; bestC = c2; }
              }
              const pt = lap + best;
              stay[k] = st; pit[k] = pt;
              action[k] = pt < st ? bestC : -1;
              Vn[k] = Math.min(st, pt);
            }
          }
        }
      }
      policy[n] = { action, stay, pit };
      V = Vn;
    }
    return { policy, id, A };
  }

  function decide(model, st, opts) {
    opts = opts || {};
    const C = model.circuits[st.circuit];
    const N = st.raceLaps, maxAge = N + 45;
    const c = model.compounds.indexOf(st.compound);
    const a = Math.min(Math.max(st.tyreAge, 0), maxAge);
    const f = st.twoCompounds ? 1 : 0;
    const s = { green: GREEN, sc: SC, vsc: VSC }[st.status];
    const temp = st.trackTemp == null ? C.temp : st.trackTemp;
    const PL = pitLosses(model, st.circuit);
    const T = lapCostTable(model, st.circuit, temp, maxAge, null);
    const { policy, id, A } = solve(T, PL, C.P, st.lap, N);
    const k = id(c, a, f, s);
    const pol = policy[st.lap];
    const act = pol.action[k];
    const result = {
      pitNow: act >= 0, fit: act >= 0 ? model.compounds[act] : null,
      gain: pol.stay[k] - pol.pit[k], pitLoss: PL, T,
      plan: plan(policy, id, T, PL, st.lap, N, c, a, f, s, model.compounds, A),
      window: windowCurve(policy, id, T, st.lap, N, c, a, f, s, A),
    };
    if (opts.bootstrap && model.boots.length) {
      result.pPit = bootstrapVote(model, st, temp, maxAge, PL, C.P, c, a, f, s);
    }
    return result;
  }

  function bootstrapVote(model, st, temp, maxAge, PL, P, c, a, f, s) {
    let votes = 0;
    model.boots.forEach((b) => {
      const Tb = lapCostTable(model, st.circuit, temp, maxAge, b);
      const r = solve(Tb, PL, P, st.lap, st.raceLaps);
      if (r.policy[st.lap].action[r.id(c, a, f, s)] >= 0) votes++;
    });
    return votes / model.boots.length;
  }

  function plan(policy, id, T, PL, n0, N, c, a, f, s, compounds, A) {
    const stops = [], stints = [];
    let total = 0, start = n0, startAge = a;
    for (let n = n0; n <= N; n++) {
      const act = policy[n].action[id(c, a, f, s)];
      total += T[c][Math.min(a + 1, A)];
      if (act >= 0) {
        total += PL[s];
        stints.push({ from: start, to: n, compound: compounds[c], startAge });
        stops.push({ lap: n, fit: compounds[act] });
        f = (f || act !== c) ? 1 : 0; c = act; a = 0; start = n + 1; startAge = 0;
      } else {
        a = Math.min(a + 1, A);
      }
      s = GREEN;
    }
    stints.push({ from: start, to: N, compound: compounds[c], startAge });
    return { stops, stints, tyreCost: total };
  }

  function windowCurve(policy, id, T, lap, N, c, a, f, s, A, horizon) {
    horizon = horizon || 15;
    const rows = [];
    for (let k = 0; k <= Math.min(horizon, N - lap); k++) {
      const n = lap + k;
      let drive = 0;
      for (let j = 0; j < k; j++) drive += T[c][Math.min(a + j + 1, A)];
      const ss = k === 0 ? s : GREEN;
      rows.push([n, drive + policy[n].pit[id(c, Math.min(a + k, A), f, ss)]]);
    }
    const best = Math.min(...rows.map((r) => r[1]));
    return rows.map(([n, v]) => ({ lap: n, delta: v - best }));
  }

  function degCurve(model, circ, compound, temp, maxAge) {
    const T = lapCostTable(model, circ, temp, maxAge, null);
    const i = model.compounds.indexOf(compound);
    return Array.from(T[i]).map((v) => v / model.circuits[circ].L);
  }

  const api = { decide, solve, lapCostTable, pitLosses, degCurve, GREEN, SC, VSC };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PitwallCore = api;
})(typeof window !== "undefined" ? window : this);
