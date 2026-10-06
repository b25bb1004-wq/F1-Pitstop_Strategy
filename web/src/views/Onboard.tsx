/* Onboard: each circuit's real fastest lap, replayed from telemetry. The car drives the true speed
 * profile (brakes glow where the driver brakes), the racing line is painted by speed, and the traces
 * below share one distance axis with a live playhead. */
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Data, TEAM_COLOR, fmt, reducedMotion } from "../data";
import { useReveal } from "../ui/kit";
import LineChart from "../charts/LineChart";
import { DPR, FX, Safe3D } from "../ui/safety";
import { emit } from "../guide/bus";
import CornerTag from "../ui/CornerTag";
import { Atmosphere, Cameras, CarState, Circuit, Feed, FollowCar, TrackMesh, useCircuit, wrap } from "../three/Circuit3D";

const MODES = [["tcam", "T-cam"], ["director", "Director"], ["chase", "Chase"], ["tv", "TV"]] as const;
const RATES = [0.25, 0.5, 1, 2];
// single-hue sequential ramp for speed (dark -> F1 red -> pale)
const ramp = (v: number) => {
  const t = Math.min(Math.max((v - 60) / 280, 0), 1);
  const a = new THREE.Color("#2a0402"), b = new THREE.Color("#e10600"), c = new THREE.Color("#ff5a48"); // top stays under the bloom threshold
  return t < 0.6 ? a.lerp(b, t / 0.6) : b.clone().lerp(c, (t - 0.6) / 0.4);
};

function SpeedLine({ c }: { c: Circuit }) {
  const geo = useMemo(() => {
    const sp: number[] = c.tel?.speed || [], M = sp.length || 2, up = new THREE.Vector3(0, 1, 0);
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const n = 1200;
    for (let i = 0; i <= n; i++) {
      const u = (i / n) % 1, p = c.curve.getPointAt(u), t = c.curve.getTangentAt(u), sd = new THREE.Vector3().crossVectors(t, up).normalize();
      const v = sp[Math.min(M - 1, Math.round(u * (M - 1)))] ?? 200, k = ramp(v);
      for (const o of [-0.22, 0.22]) { const q = p.clone().addScaledVector(sd, o); pos.push(q.x, q.y + 0.06, q.z); col.push(k.r, k.g, k.b); }
      if (i < n) { const j = i * 2; idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    return g;
  }, [c]);
  return <mesh geometry={geo}><meshBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} side={THREE.DoubleSide} /></mesh>;
}

function Scene({ track, feed, mode, livery }: any) {
  const c = useCircuit(track);
  const pick = (cars: CarState[]) => cars[0];
  return (
    <>
      <Atmosphere c={c} />
      <TrackMesh c={c} />
      {mode !== "tcam" && <SpeedLine c={c} />}{/* from the driver's eye the line runs under the lens and fills the view */}
      <FollowCar feed={feed} c={c} livery={livery} pick={pick} />
      <Cameras feed={feed} c={c} mode={mode} pick={pick} />
    </>
  );
}

export default function Onboard({ data }: { data: Data }) {
  const circuits = useMemo(() => Object.keys(data.tracks).filter((k) => (data.tracks[k] as any).tel).sort(), [data]);
  const [circ, setCirc] = useState(circuits.includes("Monza") ? "Monza" : circuits[0]);
  const track: any = data.tracks[circ];
  const tel = track.tel;
  const [mode, setMode] = useState<string>("tcam");
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(!reducedMotion());
  const [i, setI] = useState(0);
  const t = useRef(0);
  const live = useRef({ playing, rate });
  live.current = { playing, rate };
  const feed = useRef({ cars: [{ code: tel.driver, team: tel.team, frac: 0, lapDur: tel.lap_time, visible: true, pitting: false, selected: true }], compound: "SOFT", speed: 1 }) as Feed;
  const root = useReveal("onboard");
  const M = tel.speed.length, T = tel.lap_time, L = track.length_m;

  useEffect(() => { t.current = 0; setI(0); feed.current.cars[0] = { ...feed.current.cars[0], code: tel.driver, team: tel.team, lapDur: T }; }, [circ]);
  useEffect(() => {
    let raf = 0, last = performance.now(), lastSet = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (live.current.playing) t.current = (t.current + dt * live.current.rate) % T;
      feed.current.cars[0].frac = t.current / T;
      (feed.current as any).speed = live.current.playing ? live.current.rate : 0;
      if (now - lastSet > 33) {
        lastSet = now;
        // telemetry is sampled by distance; find the sample at this lap time
        const tt = t.current; let lo = 0, hi = M - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (tel.t[m] < tt) lo = m + 1; else hi = m; }
        setI(lo);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [circ]);

  const speed = tel.speed[i], gear = tel.gear[i], thr = tel.throttle[i], brk = tel.brake[i], rpm = tel.rpm[i] * 10, drs = tel.drs[i];
  const lit = Math.max(0, Math.min(15, Math.round(((rpm - 9000) / 3000) * 15)));
  const xs = (k: number) => (k / (M - 1)) * L;
  const traces = useMemo(() => ({
    speed: tel.speed.map((v: number, k: number) => [xs(k), v]),
    throttle: tel.throttle.map((v: number, k: number) => [xs(k), v]),
    brake: tel.brake.map((v: number, k: number) => [xs(k), v * 100]),
    gear: tel.gear.map((v: number, k: number) => [xs(k), v]),
  }), [circ]);
  const head = xs(i);
  const tclock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">Onboard · real telemetry</div>
          <h1 className="title">Ride the <em>fastest lap.</em></h1>
          <p className="lede">The quickest lap of each circuit's latest race, replayed from position and car telemetry: speed, throttle, brake, gear, revs and DRS, on the real track with real elevation.</p></div>
        <div style={{ minWidth: 260, flex: "0 1 320px" }}>
          <label className="label" htmlFor="oc" style={{ display: "block", marginBottom: 8 }}>Circuit</label>
          <select id="oc" value={circ} onChange={(e) => setCirc(e.target.value)}>{circuits.map((k) => <option key={k}>{k}</option>)}</select>
        </div>
      </div>
      <div className="deck onboard rv" data-explain="onboard">
        <Safe3D label="Onboard">{(k, onLost) => (
        <Canvas key={k} dpr={DPR} camera={{ fov: 50, near: 0.1, far: 12000, position: [0, 30, 30] }} onCreated={({ gl }) => { gl.localClippingEnabled = true; onLost(gl); }}>
          <Scene key={circ} track={track} feed={feed} mode={mode} livery={TEAM_COLOR[tel.team] || "#101014"} />
          {FX && <EffectComposer multisampling={0}><Bloom mipmapBlur luminanceThreshold={0.5} intensity={0.9} radius={0.7} /><Vignette offset={0.2} darkness={0.8} /></EffectComposer>}
        </Canvas>)}</Safe3D>
        <div className="hud hud-tl">
          <div className="follow" style={{ marginTop: 0 }}><span className="team" style={{ background: TEAM_COLOR[tel.team] || "#888" }} />{tel.driver} · {tel.team}</div>
          <div className="laptimer mono" style={{ marginTop: 10, fontFamily: "var(--display)" }}>{tclock(t.current)}</div>
          <div className="label" style={{ marginTop: 4 }}>fastest lap {tclock(T)} · {circ}</div>
          <div style={{ pointerEvents: "auto", marginTop: 12 }} className="seg modes" role="group" aria-label="Camera">
            {MODES.map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => { setMode(k); emit("onboard:mode", k); }}>{l}</button>)}
          </div>
          <CornerTag corner={feed.current.corner} />
        </div>
        <div className="hud hud-br" data-explain="hud">
          <div className="pedals" aria-label={`Throttle ${thr}%, brake ${brk ? "on" : "off"}`}>
            <div className="bar"><i style={{ height: `${thr}%`, background: "var(--green)" }} /></div>
            <div className="bar"><i style={{ height: `${brk * 100}%`, background: "var(--red)" }} /></div>
          </div>
          <div className="gearbox"><b>{gear || "N"}</b><span>GEAR</span></div>
          <div className="speedo">
            <div className="shift" aria-hidden="true">{Array.from({ length: 15 }, (_, k) => <i key={k} className={k < lit ? (k < 5 ? "g" : k < 10 ? "r" : "b") : ""} />)}</div>
            <b>{speed}</b><span>KM/H · {fmt(rpm / 1000, 1)}K RPM</span>
            <span className={`drs ${drs ? "on" : ""}`}>DRS</span>
          </div>
        </div>
      </div>
      <div className="deck timeline rv" style={{ gridTemplateColumns: "auto minmax(0,1fr) auto" }}>
        <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
          <svg className="icon" viewBox="0 0 24 24"><path d={playing ? "M7 4h4v16H7zM14 4h4v16h-4z" : "M7 4v16l13-8z"} /></svg>
        </button>
        <div className="scrub"><input type="range" min={0} max={M - 1} value={i} aria-label="Lap position" style={{ ["--fill" as any]: `${(i / (M - 1)) * 100}%` }}
          onChange={(e) => { const k = +e.target.value; t.current = tel.t[k]; setI(k); }} /></div>
        <div className="speed" role="group" aria-label="Playback rate">{RATES.map((r) => <button key={r} aria-pressed={rate === r} onClick={() => setRate(r)}>{r}×</button>)}</div>
      </div>
      <div className="deck pad rv" style={{ marginTop: 16 }} data-explain="traces">
        <div className="deck-head"><span className="label">Telemetry traces · {tel.driver} · {circ}</span><span className="meta">shared distance axis · hover for exact values</span></div>
        <LineChart ariaLabel="Speed trace" height={190} x={[0, L]} y={[0, 360]} yTicks={[0, 100, 200, 300]} playhead={head} fmtX={(v) => `${Math.round(v)}`} xLabel="metres" fmtY={(v) => `${Math.round(v)}`} yLabel="km/h" animateKey={circ}
          series={[{ id: "s", label: "Speed", color: "#e10600", kind: "area", points: traces.speed as any }]} />
        <LineChart ariaLabel="Throttle and brake" height={130} x={[0, L]} y={[0, 100]} yTicks={[0, 50, 100]} playhead={head} fmtX={(v) => `${Math.round(v)}`} fmtY={(v) => `${Math.round(v)}%`} animateKey={circ + "tb"}
          series={[{ id: "t", label: "Throttle", color: "#2ba84a", kind: "line", points: traces.throttle as any }, { id: "b", label: "Brake", color: "#e10600", kind: "step", points: traces.brake as any }]} />
        <LineChart ariaLabel="Gear" height={120} x={[0, L]} y={[0, 8.5]} yTicks={[2, 4, 6, 8]} playhead={head} fmtX={(v) => `${Math.round(v)}`} xLabel="metres" fmtY={(v) => `${Math.round(v)}`} yLabel="gear" animateKey={circ + "g"}
          series={[{ id: "g", label: "Gear", color: "#2a8bdb", kind: "step", points: traces.gear as any }]} />
      </div>
    </div>
  );
}
