import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { Data, fmt, reducedMotion } from "../data";
import { CountUp, useReveal } from "../ui/kit";

function Bars({ rows, max, unit }: { rows: { name: string; v: number; us?: boolean }[]; max: number; unit: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || reducedMotion()) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      gsap.fromTo(ref.current!.querySelectorAll(".track-bar i"), { scaleX: 0 }, { scaleX: 1, duration: 1.3, ease: "expo.out", stagger: 0.08 });
      io.disconnect();
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <div className="versus" ref={ref}>
      {rows.map((r) => (
        <div key={r.name} className={`vs-row ${r.us ? "us" : ""}`}>
          <span>{r.name}</span>
          <span className="track-bar"><i style={{ width: `${Math.min(100, (r.v / max) * 100)}%` }} /></span>
          <b>{fmt(r.v, 3)}{unit}</b>
        </div>
      ))}
    </div>
  );
}

function Table({ head, rows, us, best }: { head: string[]; rows: (string | number)[][]; us?: (r: any[]) => boolean; best?: number[] }) {
  const bestVal: Record<number, number> = {};
  (best || []).forEach((j) => { bestVal[j] = Math.min(...rows.map((r) => parseFloat(String(r[j]))).filter(isFinite)); });
  return (
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i} className={us && us(r) ? "us" : ""}>{r.map((c, j) => <td key={j} className={bestVal[j] != null && parseFloat(String(c)) === bestVal[j] ? "best" : ""}>{c}</td>)}</tr>
      ))}</tbody>
    </table></div>
  );
}

export default function Proof({ data }: { data: Data }) {
  const m = data.metrics, T = m.inrace.test, D = m.decisions.test, pr = m.prerace.test, rt = m.race_time.test, pl = m.pit_loss.test;
  const root = useReveal("proof");
  const dn: Record<string, string> = { optimiser_in_race: "Optimiser alone (time-minimising)", optimiser_pre_race_only: "Optimiser, no in-race updates",
    imitation_basic: "Classifier on tyre + race state", pit_call_model: "Pitwall pit-call model", hybrid_optimiser_features: "Pit-call model + optimiser outputs",
    leaky_current_lap_time: "Leaky: sees the lap's own time" };
  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">Proof · scored once on 2025</div>
          <h1 className="title">Tested on a season <em>it never saw.</em></h1>
          <p className="lede">Fitted on 2021-2023, every knob tuned on 2024, then all 24 races of 2025 scored once. Whole seasons are held out, so no lap, stint or race of the test year leaks into fitting.</p></div>
      </div>
      <div className="hero-stats">
        <div className="deck stat rv"><CountUp to={T.structural.all} decimals={3} suffix=" s" className="p" /><span>lap-time error during a race</span><small>repeating the last lap: {fmt(T.last_lap.all, 3)} s</small></div>
        <div className="deck stat rv"><CountUp to={T.structural["h1-5"]} decimals={3} suffix=" s" /><span>forecasting 1-5 laps ahead</span><small>{T.n_predictions.toLocaleString()} predictions</small></div>
        <div className="deck stat rv"><CountUp to={rt.mape_pct} decimals={2} suffix="%" /><span>remaining-race time error from lap 10</span><small>naive: {fmt(rt.naive_mape_pct, 2)}%</small></div>
        <div className="deck stat rv"><CountUp to={D.pit_call_model.roc_auc} decimals={3} /><span>pit-call ROC-AUC vs real teams</span><small>{D.real_stops} stops · {D.states.toLocaleString()} lap states</small></div>
      </div>
      <div className="cols" style={{ marginTop: 18 }}>
        <section className="deck pad rv">
          <div className="deck-head"><span className="label">In-race lap-time error (MAE, s) · lower is better</span></div>
          <Bars unit=" s" max={2.6} rows={[
            { name: "Linear fit on the race's own laps", v: T.inrace_linear.all }, { name: "Mean of last 5 laps", v: T.mean_last5.all },
            { name: "Repeat the last lap", v: T.last_lap.all }, { name: "Pitwall structural model", v: T.structural.all, us: true }]} />
          <p className="note">The linear row is how most public FastF1 projects model lap time; asked to forecast the rest of a race instead of interpolating within it, it falls apart.</p>
        </section>
        <section className="deck pad rv">
          <div className="deck-head"><span className="label">Before the race (MAE, s)</span></div>
          <Bars unit=" s" max={2.2} rows={[{ name: "Gradient boosting on conditions", v: pr.prerace_gbm.mae }, { name: "Pitwall v1 Ridge", v: pr.old_pitwall_ridge.mae },
            { name: "Pitwall structural + base pace", v: pr.prerace_structural.mae, us: true }]} />
          <div className="deck-head" style={{ marginTop: 22 }}><span className="label">Pit loss per stop (MAE, s)</span></div>
          <Bars unit=" s" max={2.6} rows={[{ name: "Fixed 22 s", v: pl.mae_constant_22s }, { name: "Measured per circuit", v: pl.mae_circuit_model, us: true }]} />
        </section>
      </div>
      <section className="deck pad rv" style={{ marginTop: 18 }}>
        <div className="deck-head"><span className="label">Lap time during a race · by horizon (MAE, s)</span><span className="meta">purple = best in column</span></div>
        <Table head={["Model", "All", "1-5 laps", "6-10", "11-20", "21+"]} best={[1, 2, 3, 4, 5]}
          us={(r) => r[0] === "Pitwall structural model"}
          rows={[["Repeat the last lap", "last_lap"], ["Mean of last 5 laps", "mean_last5"], ["Linear fit on this race", "inrace_linear"], ["Pitwall structural model", "structural"]].map(([n, k]) =>
            [n, fmt(T[k].all, 3), fmt(T[k]["h1-5"], 3), fmt(T[k]["h6-10"], 3), fmt(T[k]["h11-20"], 3), fmt(T[k]["h21-99"], 3)])} />
      </section>
      <section className="deck pad rv" style={{ marginTop: 18 }}>
        <div className="deck-head"><span className="label">Pit calls vs what the teams did</span><span className="meta">thresholds frozen from 2024</span></div>
        <Table head={["Model", "Precision", "Recall", "F1", "F1 ±2 laps", "PR-AUC", "ROC-AUC"]} us={(r) => r[0] === dn.pit_call_model}
          rows={Object.keys(dn).filter((k) => D[k]).map((k) => [dn[k], fmt(D[k].precision), fmt(D[k].recall), fmt(D[k].f1), fmt(D[k].tol2.f1),
            D[k].average_precision ? fmt(D[k].average_precision, 3) : "–", D[k].roc_auc ? fmt(D[k].roc_auc, 3) : "–"])} />
        <p className="note">Every model uses only what a pit wall knows before the lap, except the last row. A lap that ends in the pit lane is slow because of the stop, so a model given that lap's time scores like published per-lap predictors (Bi-LSTM, Frontiers in AI 2025: F1 0.81, ROC-AUC 0.988). Without it the honest ceiling on this data is far lower; Pitwall reports both.</p>
      </section>
      <section className="steps" style={{ marginTop: 18 }}>
        {[["Every lap", "114 races rebuilt offline from the FastF1 cache, keeping the in-laps, out-laps and Safety Car laps that most pipelines throw away."],
          ["Physics", `Base pace per driver per race, fuel at ${fmt(data.model.fuel, 4)} s/kg, a tyre curve per compound, wear by circuit and race, traffic. Re-fitted live from laps already driven.`],
          ["Pit loss & SC", "Stops measured from in/out laps; Safety Car stops measured by gap to the leader, because the queue gives most of the loss back."],
          ["The call", "A stochastic dynamic programme over the remaining laps, with the circuit's Safety Car odds and the two-compound rule. 30 bootstrapped refits vote."]].map(([h, p], i) => (
          <div className="deck pad rv" key={h}><div className="n">0{i + 1}</div><h3>{h}</h3><p>{p}</p></div>
        ))}
      </section>
    </div>
  );
}
