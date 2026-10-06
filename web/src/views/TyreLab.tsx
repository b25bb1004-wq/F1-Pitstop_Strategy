import { useLayoutEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { degCurve } from "../core/pitwall-core.js";
import { Data, TYRE_COLOR, fmt, reducedMotion } from "../data";
import { Slider, Tyre, useReveal } from "../ui/kit";
import LineChart, { Series } from "../charts/LineChart";

const poly = (pts: [number, number][], w: number, h: number, pad: number, aspect: number) => {
  const s = Math.min(w - 2 * pad, (h - 2 * pad) / aspect);
  const ox = (w - s) / 2, oy = (h - s * aspect) / 2;
  return pts.map(([x, y]) => `${(ox + x * s).toFixed(1)},${(oy + (aspect - y) * s).toFixed(1)}`).join(" ");
};

export default function TyreLab({ data }: { data: Data }) {
  const { model, tracks } = data;
  const circuits = useMemo(() => Object.keys(model.circuits).filter((c) => tracks[c]).sort(), [model, tracks]);
  const [circ, setCirc] = useState("Sakhir");
  const C = model.circuits[circ];
  const [temp, setTemp] = useState(Math.round(C.temp));
  const root = useReveal("lab");
  const big = useRef<SVGPolylineElement>(null);

  const maxA = 50;
  const series = model.compounds.map((c: string) => ({ c, y: degCurve(model, circ, c, temp, maxA), lim: Math.round(C.max_age[c]) }));
  const yMax = Math.max(3, ...series.map((s: any) => s.y[Math.min(maxA, s.lim + 6)]));
  const yMin = Math.min(-0.6, ...series.map((s: any) => Math.min(...s.y.slice(1, s.lim))));
  const pts = (y: number[], a0: number, a1: number) => Array.from({ length: Math.max(0, a1 - a0 + 1) }, (_, i) => [a0 + i, Math.min(y[a0 + i], yMax)] as [number, number]);
  const name = (c: string) => c[0] + c.slice(1).toLowerCase();
  const deg: Series[] = series.flatMap((s: any) => [
    { id: s.c, label: name(s.c), color: TYRE_COLOR[s.c], points: pts(s.y, 1, Math.min(s.lim, maxA)), endLabel: true, width: 2.5 },
    { id: s.c + "-x", label: `${name(s.c)} (beyond data)`, color: TYRE_COLOR[s.c], points: pts(s.y, Math.min(s.lim, maxA), Math.min(s.lim + 6, maxA)), dashed: true, aux: true, width: 1.5 },
  ]);

  useLayoutEffect(() => {
    if (reducedMotion()) return;
    const els = [big.current].filter(Boolean) as SVGGeometryElement[];
    els.forEach((el) => {
      const len = el.getTotalLength();
      gsap.fromTo(el, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.4, ease: "expo.out", clearProps: "strokeDasharray,strokeDashoffset" });
    });
  }, [circ]);

  const ranking = circuits.slice().sort((a, b) => model.circuits[b].pit_green - model.circuits[a].pit_green);
  const pick = (c: string) => { setCirc(c); setTemp(Math.round(model.circuits[c].temp)); };
  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">Tyre lab · fuel-corrected physics</div>
          <h1 className="title">What a lap of <em>tyre</em> costs.</h1>
          <p className="lede">Degradation learned only from within-race variation, with fuel burn removed: each curve is the lap time a set costs relative to a fresh medium, at this circuit and track temperature.</p></div>
      </div>
      <div className="lab">
        <div className="deck pad rv">
          <div className="deck-head"><span className="label">{circ}</span><span className="meta mono">{C.laps} laps · {fmt(C.pit_green, 1)} s pit loss</span></div>
          <svg className="bigtrack" viewBox="0 0 600 260" role="img" aria-label={`${circ} circuit outline`}>
            <defs><filter id="glow"><feGaussianBlur stdDeviation="6" /></filter>
              <linearGradient id="tg" x1="0" x2="1"><stop offset="0" stopColor="#e10600" /><stop offset=".5" stopColor="#ffffff" /><stop offset="1" stopColor="#e10600" /></linearGradient></defs>
            <polyline points={poly(tracks[circ].points, 600, 260, 20, tracks[circ].aspect)} fill="none" stroke="#e10600" strokeWidth="10" opacity=".35" filter="url(#glow)" />
            <polyline ref={big} points={poly(tracks[circ].points, 600, 260, 20, tracks[circ].aspect)} fill="none" stroke="url(#tg)" strokeWidth="3" strokeLinejoin="round" />
          </svg>
          <dl className="facts" style={{ margin: "8px -20px 16px", borderTop: "1px solid var(--hair)", borderBottom: "1px solid var(--hair)" }}>
            <div><dt>SCs / race</dt><dd>{(C.p_sc * (C.laps - 1)).toFixed(2)}</dd></div>
            <div><dt>VSCs / race</dt><dd>{(C.p_vsc * (C.laps - 1)).toFixed(2)}</dd></div>
            <div><dt>Stops measured</dt><dd>{C.n_stops}</dd></div>
          </dl>
          <div className="label" style={{ marginBottom: 10 }}>Pick a circuit</div>
          <div className="trackgrid">
            {circuits.map((c) => (
              <button key={c} className="tcard" aria-pressed={c === circ} onClick={() => pick(c)}>
                <svg viewBox="0 0 120 54" aria-hidden="true"><polyline points={poly(tracks[c].points, 120, 54, 4, tracks[c].aspect)} fill="none" stroke={c === circ ? "#e10600" : "#8c8c99"} strokeWidth="1.6" strokeLinejoin="round" /></svg>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          <div className="deck pad rv">
            <div className="deck-head"><span className="label">Degradation · {circ} · {temp}°C</span>
              <span className="meta" style={{ display: "flex", gap: 14 }}>{series.map((s: any) => <span key={s.c} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Tyre c={s.c} />{s.c[0] + s.c.slice(1).toLowerCase()}</span>)}</span></div>
            <LineChart ariaLabel={`Degradation curves at ${circ}, ${temp} degrees`} height={300} animateKey={circ} legend={false}
              series={deg} x={[1, maxA]} y={[yMin, yMax]} zero xLabel="tyre age (laps)" yLabel="s vs fresh medium"
              fmtY={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`} xTicks={[1, 10, 20, 30, 40, 50]} />
            <Slider id="ttemp" label="Track temperature" value={temp} min={15} max={60} onChange={setTemp} display={`${temp}°C`} />
            <p className="note" style={{ marginTop: 0 }}>Dashed: beyond the 95th-percentile stint length here. The optimiser adds a cliff penalty instead of trusting the extrapolation.</p>
          </div>
          <div className="deck pad rv">
            <div className="deck-head"><span className="label">Measured green-flag pit loss</span><span className="meta">in-lap + out-lap vs expected clean laps</span></div>
            <div className="versus">
              {ranking.map((c) => (
                <div key={c} className={`vs-row ${c === circ ? "us" : ""}`} style={{ gridTemplateColumns: "130px minmax(0,1fr) 54px", cursor: "pointer" }} onClick={() => pick(c)}>
                  <span style={{ fontSize: 13 }}>{c}</span>
                  <span className="track-bar"><i style={{ width: `${((model.circuits[c].pit_green - 14) / 18) * 100}%` }} /></span>
                  <b>{fmt(model.circuits[c].pit_green, 1)}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
