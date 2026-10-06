import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import gsap from "gsap";
import { decide } from "../core/pitwall-core.js";
import { Car } from "../three/Car";
import { CarModel, hasCar } from "../three/CarModel";
import { Studio } from "../three/Scenes";
import { Data, TYRE_COLOR, fmt, reducedMotion } from "../data";
import { Ring, Segmented, Slider, Tyre, useReveal, useVisible } from "../ui/kit";
import { DPR, FX, Safe3D } from "../ui/safety";
import { emit } from "../guide/bus";

const SPEC = [
  { p: [2.75, 0.32, 0.6], t: "Front wing", d: "4 elements · adjustable flap" },
  { p: [0.35, 1.05, 0], t: "Halo", d: "titanium · ~9 kg · 125 kN load" },
  { p: [0.4, 0.68, 0.72], t: "Sidepod inlet", d: "radiators · ground-effect feed" },
  { p: [-0.85, 1.05, 0], t: "Power unit", d: "1.6 L V6 turbo hybrid · ~1000 hp" },
  { p: [-0.6, 0.12, -0.85], t: "Floor", d: "venturi tunnels · most of the downforce" },
  { p: [-2.45, 1.22, 0], t: "Rear wing · DRS", d: "flap opens on straights · +10-12 km/h" },
];

const PRESETS = [
  ["Bahrain · softs · green", { circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "green", trackTemp: 30, twoCompounds: false }],
  ["Bahrain · Safety Car", { circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "sc", trackTemp: 30, twoCompounds: false }],
  ["Monaco · one-stop", { circuit: "Monaco", lap: 30, raceLaps: 78, compound: "MEDIUM", tyreAge: 29, status: "green", trackTemp: 45, twoCompounds: false }],
  ["Monza · VSC", { circuit: "Monza", lap: 22, raceLaps: 53, compound: "MEDIUM", tyreAge: 21, status: "vsc", trackTemp: 42, twoCompounds: false }],
  ["Silverstone · to the flag", { circuit: "Silverstone", lap: 38, raceLaps: 52, compound: "HARD", tyreAge: 15, status: "green", trackTemp: 40, twoCompounds: true }],
] as const;

/* Projects the spec points to screen space every frame and moves plain DOM nodes: one overlay,
 * no per-label React roots, and the active card can always sit on top. */
function Hotspots({ points, nodes }: { points: number[][]; nodes: React.MutableRefObject<(HTMLDivElement | null)[]> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    points.forEach((p, i) => {
      const el = nodes.current[i];
      if (!el) return;
      v.set(p[0] - 0.2, p[1], p[2]).project(camera);
      const hide = v.z > 1;
      el.style.visibility = hide ? "hidden" : "visible";
      el.style.transform = `translate3d(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px, 0)`;
    });
  });
  return null;
}

function Garage({ compound, circuit, lap, laps, age, shown }: any) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const spin = useRef(0);
  const [spec, setSpec] = useState(true);
  // one spec card at a time: the hovered hotspot, else a slow broadcast-style cycle through the car
  const [hot, setHot] = useState<number | null>(null);
  const [auto, setAuto] = useState(0);
  const items = [...SPEC, { p: [1.92, 0.95, 0.98], t: `Tyre · ${compound.toLowerCase()}`, d: shown ? "fresh set" : `${age} laps old` }];
  useEffect(() => {
    if (!spec || hot != null || !visible || reducedMotion()) return;
    const id = setInterval(() => setAuto((a) => (a + 1) % items.length), 3200);
    return () => clearInterval(id);
  }, [spec, hot, visible, items.length]);
  const active = hot ?? auto;
  const nodes = useRef<(HTMLDivElement | null)[]>([]);
  return (
    <div className="deck garage rv" ref={ref} data-explain="garage">
      <Safe3D label="Garage">{(key, onLost) => (
      <Canvas key={key} shadows={FX} dpr={DPR} frameloop={visible ? "always" : "never"} camera={{ position: [4.9, 1.8, 5.2], fov: 30 }}
        onCreated={({ gl }) => { gl.localClippingEnabled = true; onLost(gl); }}>
        <Studio hdri />
        <group position={[-0.2, 0, 0]}>
          {hasCar() ? <CarModel compound={compound} spin={spin} /> : <Car compound={compound} spin={spin} />}

        </group>
        {spec && <Hotspots points={items.map((c) => c.p)} nodes={nodes} />}
        <OrbitControls target={[0.1, 0.45, 0]} autoRotate={!reducedMotion()} autoRotateSpeed={0.45} enablePan={false} enableZoom={false}
          minPolarAngle={0.9} maxPolarAngle={1.45} />
        {FX && <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.6} intensity={0.6} radius={0.6} />
          <Vignette offset={0.25} darkness={0.7} />
        </EffectComposer>}
      </Canvas>)}</Safe3D>
      {spec && <div className="hots">{items.map((c, i) => (
        <div key={i} ref={(el) => { nodes.current[i] = el; }} className={`hot ${i === active ? "on" : ""}`}>
          <button className="dot" aria-label={`${c.t}: ${c.d}`} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)}
            onFocus={() => setHot(i)} onBlur={() => setHot(null)} onClick={() => setHot(i)}>{i + 1}</button>
          {i === active && <div className="card"><b>{c.t}</b><span>{c.d}</span></div>}
        </div>))}</div>}
      {spec && <ol className="speckey" aria-label="Car specification">{items.map((c, i) => (
        <li key={i} className={i === active ? "on" : ""} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)}>
          <span className="n">{String(i + 1).padStart(2, "0")}</span>{c.t}</li>))}</ol>}
      <button className="navbtn" onClick={() => setSpec(!spec)} aria-pressed={spec} style={{ position: "absolute", top: 14, right: 14, zIndex: 12 }}>{spec ? "Hide spec" : "Show spec"}</button>
      <div className="hud">
        <div><div className="label">{circuit}</div><div className="display" style={{ font: "700 34px/1 var(--display)" }}>LAP {lap}<span style={{ color: "var(--text-3)", fontSize: 18 }}> / {laps}</span></div></div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right" }}><div className="label">{shown ? "fitting" : "on car"}</div><div className="mono" style={{ fontSize: 15 }}>{shown ? "fresh set" : `${age} laps old`}</div></div>
          <Tyre c={compound} lg />
        </div>
      </div>
    </div>
  );
}

function Strip({ N, now, stints, stops }: any) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  const g = useRef<SVGGElement>(null);
  const key = stints.map((s: any) => `${s.from}-${s.to}-${s.compound}`).join("|");
  useLayoutEffect(() => {
    if (!g.current || reducedMotion()) return;
    gsap.fromTo(g.current.querySelectorAll(".st"), { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "expo.out", stagger: 0.09, transformOrigin: "left center" });
  }, [key]);
  const pad = 16, px = (l: number) => pad + (l / N) * (W - 2 * pad);
  return (
    <div ref={wrap}>
      <svg className="strip" viewBox={`0 0 ${W} 92`} role="img" aria-label="Optimal strategy from here">
        {Array.from({ length: Math.floor((N - 1) / 10) }, (_, i) => (i + 1) * 10).map((l) => (
          <g key={l}><line x1={px(l)} x2={px(l)} y1={62} y2={66} stroke="rgba(255,255,255,.2)" /><text x={px(l)} y={80} fontSize="10" fill="#848c9b" textAnchor="middle">{l}</text></g>
        ))}
        <rect x={px(0)} y={28} width={Math.max(px(now - 1) - px(0) - 2, 0)} height={30} rx={6} fill="rgba(255,255,255,.07)" />
        <g ref={g}>
          {stints.map((s: any, i: number) => {
            const x0 = px(s.from - 1), w = Math.max(px(s.to) - x0 - 3, 2), col = TYRE_COLOR[s.compound];
            return (
              <g key={i} className="st">
                <rect x={x0} y={28} width={w} height={30} rx={6} fill={col} opacity={0.92} />
                <rect x={x0} y={28} width={w} height={30} rx={6} fill="url(#sheen)" />
                {w > 52 && <><circle cx={x0 + 16} cy={43} r={9} fill="#0d0f15" stroke={col} strokeWidth={2.5} />
                  <text x={x0 + 16} y={46.5} fontSize="10" fontWeight="700" fill="#eef0f4" textAnchor="middle">{s.compound[0]}</text></>}
                {w > 96 && <text x={x0 + 32} y={47} fontSize="12" fontWeight="600" fill="#0a0b0f">{s.to - s.from + 1} laps</text>}
              </g>
            );
          })}
        </g>
        <defs><linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".35" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /></linearGradient></defs>
        <line x1={px(now - 1) - 1} x2={px(now - 1) - 1} y1={18} y2={62} stroke="#fff" strokeWidth={2} />
        <text x={px(now - 1) - 5} y={14} fontSize="10" fontWeight="600" fill="#fff" textAnchor="end">NOW</text>
        {stops.map((p: any) => (
          <g key={p.lap}><line x1={px(p.lap) - 1} x2={px(p.lap) - 1} y1={18} y2={62} stroke="#ff2a1f" strokeWidth={2.5} style={{ filter: "drop-shadow(0 0 6px #ff2a1f)" }} />
            <text x={Math.min(px(p.lap) + 4, W - 34)} y={14} fontSize="11" fontWeight="600" fill="#ff6a5c">L{p.lap}</text></g>
        ))}
      </svg>
    </div>
  );
}

function Radio({ r, st }: any) {
  const text = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const next = r.plan.stops[0];
  const line = r.pitNow
    ? `Box, box. ${r.fit.toLowerCase()}s are ready. Pitting now is worth ${fmt(r.gain, 2)} s.`
    : next ? `Stay out, stay out. Plan is lap ${next.lap} for ${next.fit.toLowerCase()}s. Box now costs ${fmt(-r.gain, 2)} s.`
      : `Stay out. Tyres go to the flag.`;
  useEffect(() => {
    if (!text.current) return;
    if (reducedMotion()) { text.current.textContent = line; return; }
    const o = { n: 0 };
    const tw = gsap.to(o, { n: line.length, duration: Math.min(1.6, line.length / 40), ease: "none",
      onUpdate: () => text.current && (text.current.textContent = line.slice(0, Math.round(o.n))) });
    const bars = wave.current ? Array.from(wave.current.children) : [];
    const tl = gsap.timeline();
    bars.forEach((b, i) => tl.to(b, { height: () => `${20 + Math.random() * 80}%`, duration: 0.12, repeat: 9, yoyo: true, ease: "sine.inOut" }, i * 0.012));
    tl.to(bars, { height: (i: number) => `${14 + 22 * Math.abs(Math.sin(i * 0.55)) * Math.abs(Math.cos(i * 0.21))}%`, duration: 0.5, ease: "power2.out" });
    return () => { tw.kill(); tl.kill(); };
  }, [line]);
  return (
    <div className="radio">
      <div className="radio-head"><span className="live" /><span className="label">Team radio · {st.circuit} · lap {st.lap}</span></div>
      <div className="verdict">{r.pitNow ? "Box, box" : "Stay out"}</div>
      <div className="transcript" ref={text} aria-live="polite">{line}</div>
      <div className="wave" ref={wave} aria-hidden="true">{Array.from({ length: 34 }, (_, i) => <i key={i} />)}</div>
    </div>
  );
}

export default function PitWall({ data }: { data: Data }) {
  const { model } = data;
  const [st, setSt] = useState<any>({ circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "green", trackTemp: 30, twoCompounds: false });
  const set = (k: string, v: any) => {
    setSt((s: any) => ({ ...s, [k]: v, lap: k === "raceLaps" ? Math.min(s.lap, v - 1) : k === "lap" ? v : s.lap }));
    if (k === "status") emit("wall:status", v);
    if (k === "compound") emit("wall:compound", v);
  };
  const r = useMemo(() => decide(model, st, { bootstrap: true }), [model, st]);
  const circuits = useMemo(() => Object.keys(model.circuits).sort(), [model]);
  const root = useReveal("wall");
  const agree = r.pitNow ? r.pPit : 1 - r.pPit;
  const regime = { green: 0, sc: 1, vsc: 2 }[st.status as "green"];
  const w = r.window, best = w.reduce((m: any, x: any) => (x.delta < m.delta ? x : m), w[0]);
  const maxD = Math.max(...w.map((x: any) => x.delta), 1);
  const near = w.filter((x: any) => x.delta <= 0.5).map((x: any) => x.lap);

  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">Pit wall · live strategy engine</div>
          <h1 className="title">Box, or <em>stay out?</em></h1>
          <p className="lede">Set the race state. A stochastic dynamic programme searches every remaining stop lap and compound, knows the circuit's Safety Car odds, and calls it, with 30 bootstrapped models voting on how sure it is.</p></div>
      </div>
      <div className="wall">
        <aside className="deck pad rv" aria-label="Race state">
          <div className="deck-head"><span className="label">Race state</span></div>
          <div className="ctl"><div className="ctl-row"><label htmlFor="c">Circuit</label></div>
            <select id="c" value={st.circuit} onChange={(e) => { const C = model.circuits[e.target.value]; setSt((s: any) => ({ ...s, circuit: e.target.value, raceLaps: C.laps, lap: Math.min(s.lap, C.laps - 1), trackTemp: Math.round(C.temp) })); }}>
              {circuits.map((c) => <option key={c}>{c}</option>)}
            </select></div>
          <Slider id="lap" label="Lap about to start" value={st.lap} min={2} max={st.raceLaps - 1} onChange={(v: number) => set("lap", v)} display={`${st.lap} / ${st.raceLaps}`} />
          <Segmented label="Tyre on the car" value={st.compound} onChange={(v) => set("compound", v)}
            options={[["SOFT", <><Tyre c="S" />Soft</>], ["MEDIUM", <><Tyre c="M" />Med</>], ["HARD", <><Tyre c="H" />Hard</>]]} />
          <Slider id="age" label="Laps on this set" value={st.tyreAge} min={0} max={60} onChange={(v: number) => set("tyreAge", v)} />
          <Segmented label="Track status" value={st.status} onChange={(v) => set("status", v)}
            options={[["green", <><span className="dot" style={{ background: "var(--green)" }} />Green</>], ["vsc", <><span className="dot" style={{ background: "var(--yellow)" }} />VSC</>], ["sc", <><span className="dot" style={{ background: "var(--amber-2)" }} />SC</>]]} />
          <Slider id="temp" label="Track temperature" value={st.trackTemp} min={15} max={60} onChange={(v: number) => set("trackTemp", v)} display={`${st.trackTemp}°C`} />
          <Slider id="laps" label="Race distance" value={st.raceLaps} min={40} max={80} onChange={(v: number) => set("raceLaps", v)} display={`${st.raceLaps} laps`} />
          <label className="switch">Two dry compounds already used<input type="checkbox" role="switch" checked={st.twoCompounds} onChange={(e) => set("twoCompounds", e.target.checked)} /></label>
          <div className="label" style={{ margin: "18px 0 10px" }}>Scenarios</div>
          <div className="chips">{PRESETS.map(([t, p]) => <button key={t} className="chip" onClick={() => setSt({ ...p })}>{t}</button>)}</div>
        </aside>

        <div className="wall-main">
          <Garage compound={r.pitNow ? r.fit : st.compound} shown={r.pitNow} circuit={st.circuit} lap={st.lap} laps={st.raceLaps} age={st.tyreAge} />
          <section className={`deck call rv ${r.pitNow ? "box" : ""}`} aria-label="Pit wall call" data-explain="call">
            <Radio r={r} st={st} />
            <div className="figs">
              <div className="ringfig" data-explain="ring"><Ring value={agree * 100} color={r.pitNow ? "#e10600" : "#19c26b"} label="Bootstrap agreement" />
                <div><div className="label">Model agreement</div><div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 4 }}>{Math.round(agree * 30)} of 30 refitted models make the same call</div></div></div>
              <div className="figrow">
                <div className="fig"><b className="mono">{fmt(Math.abs(r.gain), 2)}<small style={{ fontSize: 14, color: "var(--text-3)" }}> s</small></b><span>expected gain of the call</span></div>
                <div className="fig"><b className="mono">{fmt(r.pitLoss[regime], 1)}<small style={{ fontSize: 14, color: "var(--text-3)" }}> s</small></b><span>pit loss {st.status === "green" ? "under green" : st.status === "sc" ? "under SC" : "under VSC"}</span></div>
              </div>
            </div>
          </section>
          <section className="deck pad rv" aria-label="Optimal strategy" data-explain="strip">
            <div className="deck-head"><span className="label">Optimal strategy from here</span>
              <span className="meta mono">{r.plan.stops.map((p: any) => `L${p.lap} → ${p.fit[0]}`).join("  ·  ") || "no more stops"} · tyre cost {fmt(r.plan.tyreCost, 1)} s</span></div>
            <Strip N={st.raceLaps} now={st.lap} stints={r.plan.stints} stops={r.plan.stops} />
          </section>
          <section className="deck pad rv" aria-label="Pit window" data-explain="window">
            <div className="deck-head"><span className="label">Pit window · cost of committing to a stop</span>
              <span className="meta">optimal <b style={{ color: "var(--purple)" }}>L{best.lap}</b> · within 0.5 s: L{Math.min(...near)}-L{Math.max(...near)} · now +{fmt(w[0].delta, 2)} s</span></div>
            <div className="window-bars" role="img" aria-label={`Optimal lap to stop ${best.lap}`}>
              {w.map((x: any, i: number) => (
                <div key={x.lap} className={`b ${x === best ? "best" : x.delta <= 0.5 ? "ok" : x.delta <= 2 ? "meh" : ""} ${i === 0 ? "now" : ""}`}>
                  <em>+{fmt(x.delta, 1)}</em>
                  <i style={{ height: `${Math.max(2, (x.delta / maxD) * 100)}%`, transition: "height .45s cubic-bezier(.16,1,.3,1)" }} />
                  <small>L{x.lap}</small>
                </div>
              ))}
            </div>
            <div className="legend"><span><span className="sw" style={{ background: "var(--purple)" }} />Optimal (timing-screen purple)</span><span><span className="sw" style={{ background: "var(--green)" }} />Within 0.5 s</span><span><span className="sw" style={{ background: "var(--yellow)" }} />Within 2 s</span><span><span className="sw" style={{ background: "rgba(255,255,255,.14)" }} />Costly</span></div>
          </section>
        </div>
      </div>
    </div>
  );
}
