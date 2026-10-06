/* Race Theatre: every 2025 race replayed on its real circuit outline at recorded pace, with a live
 * timing tower showing the pit-call model's probability and the team's actual stops. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Data, Driver, TEAM_COLOR, TYRE_COLOR, fmt, reducedMotion, timeToDistFn } from "../data";
import LineChart from "../charts/LineChart";
import { Icon, Tyre, useReveal } from "../ui/kit";
import { CircuitScene, Feed } from "../three/Circuit3D";
import { DPR, FX, Safe3D } from "../ui/safety";
import { emit } from "../guide/bus";
import CornerTag from "../ui/CornerTag";

const TYRE_NAME: Record<string, string> = { S: "SOFT", M: "MEDIUM", H: "HARD", I: "MEDIUM", W: "MEDIUM" };
const MODES = [["director", "Director"], ["chase", "Chase"], ["tv", "TV"], ["heli", "Heli"], ["overview", "Overview"]] as const;

type RDriver = Driver & { tEnd: number[]; last: number; finished: boolean; rank: number };
type State = { d: RDriver; D: number; frac: number; lapIdx: number; out: boolean; done: boolean; lapDur: number };
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128];

function prepare(race: Data["races"][0]) {
  const drivers = race.drivers.map((d) => {
    const laps = d.laps.filter((l) => l.t != null);
    return { ...d, laps, tEnd: laps.map((l) => l.t as number), last: laps.length ? (laps[laps.length - 1].t as number) : 0,
      finished: /^\d+$/.test(d.finish), rank: /^\d+$/.test(d.finish) ? +d.finish : 99 };
  }).filter((d) => d.laps.length);
  const maxT = Math.max(...drivers.map((d) => d.last));
  // race-level status per lap from the leader's clock
  const spans: { from: number; to: number; s: string }[] = [];
  for (let n = 1; n <= race.laps; n++) {
    let tEnd = Infinity, tStart = 0, s = "G";
    for (const d of drivers) {
      const i = d.laps.findIndex((l) => l.lap === n);
      if (i < 0) continue;
      if (d.tEnd[i] < tEnd) { tEnd = d.tEnd[i]; tStart = i ? d.tEnd[i - 1] : 0; }
      if (d.laps[i].status === "S") s = "S"; else if (d.laps[i].status === "V" && s !== "S") s = "V";
    }
    if (s !== "G" && isFinite(tEnd)) spans.push({ from: tStart, to: tEnd, s });
  }
  return { drivers, maxT, spans };
}

function stateAt(d: ReturnType<typeof prepare>["drivers"][0], T: number): State {
  if (T >= d.last) {
    return { d, D: d.finished ? 1000 - d.rank : d.laps[d.laps.length - 1].lap - 1 + 0.999, frac: 0, lapIdx: d.laps.length - 1, out: !d.finished, done: true, lapDur: 90 };
  }
  let lo = 0, hi = d.tEnd.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d.tEnd[m] > T) hi = m; else lo = m + 1; }
  const tPrev = lo ? d.tEnd[lo - 1] : 0, dur = d.tEnd[lo] - tPrev;
  const frac = dur > 0 && isFinite(dur) ? Math.min(Math.max((T - tPrev) / dur, 0), 1) : 0;
  return { d, D: d.laps[lo].lap - 1 + frac, frac, lapIdx: lo, out: false, done: false, lapDur: dur };
}

function useTrackPath(points: [number, number][]) {
  return useMemo(() => {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const total = cum[cum.length - 1];
    const at = (f: number) => {
      const s = (((f % 1) + 1) % 1) * total;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
      const i = Math.max(1, lo), t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    };
    return at;
  }, [points]);
}

export default function Theatre({ data }: { data: Data }) {
  const races = data.races.filter((r) => data.tracks[r.circuit]);
  const defaultRace = useMemo(() => {
    let best = 0, score = -1;
    races.forEach((r, i) => { const s = r.drivers[0]?.laps.filter((l) => l.status === "S").length ?? 0; if (s > score) { score = s; best = i; } });
    return best;
  }, [races]);
  const [ri, setRi] = useState(defaultRace);
  const race = races[ri];
  const track = data.tracks[race.circuit];
  const prep = useMemo(() => prepare(race), [race]);
  const at = useTrackPath(track.points);
  const ttd = useMemo(() => timeToDistFn((track as any).tel), [track]);
  const [sel, setSel] = useState(prep.drivers[0]?.driver);
  const [playing, setPlaying] = useState(!reducedMotion());
  const [speed, setSpeed] = useState(4);
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<string>("director");
  const T = useRef(0);
  const feed = useRef({ cars: [], compound: "MEDIUM", speed: 32 }) as Feed;
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLCanvasElement | null>(null);
  const geom = useRef({ W: 0, H: 0, s: 1, ox: 0, oy: 0, dpr: 1 });
  const root = useReveal("theatre");
  const live = useRef({ playing, speed, sel });
  live.current = { playing, speed, sel };

  useEffect(() => { T.current = 0; setTick(0); setSel(prep.drivers[0]?.driver); }, [prep]);

  // static track layer (re-rendered on resize / race change)
  useEffect(() => {
    const cv = canvas.current!, host = stage.current!;
    const build = () => {
      const dpr = Math.min(devicePixelRatio, 2), W = host.clientWidth, H = host.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      const pad = 14, asp = track.aspect;
      const s = Math.min((W - 2 * pad), (H - 2 * pad) / asp);
      const ox = (W - s) / 2, oy = (H - s * asp) / 2;
      geom.current = { W, H, s, ox, oy, dpr };
      const L = document.createElement("canvas"); L.width = cv.width; L.height = cv.height;
      const g = L.getContext("2d")!; g.scale(dpr, dpr);
      const P = (p: number[]) => [ox + p[0] * s, oy + (asp - p[1]) * s];
      const path = () => { g.beginPath(); track.points.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
      g.lineJoin = "round"; g.lineCap = "round";
      g.shadowColor = "rgba(255,138,0,.55)"; g.shadowBlur = 16; g.strokeStyle = "rgba(255,150,40,.10)"; g.lineWidth = 10; path(); g.stroke();
      g.shadowBlur = 0; g.strokeStyle = "#151821"; g.lineWidth = 5; path(); g.stroke();
      const grad = g.createLinearGradient(ox, oy, ox + s, oy + s * asp);
      grad.addColorStop(0, "rgba(255,181,71,.65)"); grad.addColorStop(0.5, "rgba(255,255,255,.35)"); grad.addColorStop(1, "rgba(255,138,0,.65)");
      g.strokeStyle = grad; g.lineWidth = 1.4; path(); g.stroke();
      // start / finish
      const [x0, y0] = P(track.points[0]), [x1, y1] = P(track.points[2]);
      const nx = -(y1 - y0), ny = x1 - x0, n = Math.hypot(nx, ny) || 1;
      g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.moveTo(x0 + (nx / n) * 10, y0 + (ny / n) * 10); g.lineTo(x0 - (nx / n) * 10, y0 - (ny / n) * 10); g.stroke();
      g.fillStyle = "#aab1be"; g.font = "600 10px JetBrains Mono"; g.fillText("S/F", x0 + 12, y0 - 8);
      layer.current = L;
    };
    build();
    const ro = new ResizeObserver(build); ro.observe(host);
    return () => ro.disconnect();
  }, [track]);

  // animation loop
  useEffect(() => {
    let raf = 0, last = performance.now(), lastTick = 0;
    const g = canvas.current!.getContext("2d")!;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);       // schedule first: one bad frame must never stop the race
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (live.current.playing) {
        T.current = Math.min(prep.maxT, T.current + dt * live.current.speed);
        if (T.current >= prep.maxT) setPlaying(false);
      }
      const { s, ox, oy, dpr } = geom.current, asp = track.aspect;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      if (layer.current && layer.current.width > 0 && layer.current.height > 0) g.drawImage(layer.current, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const P = (f: number) => { const p = at(ttd(f)); return [ox + p[0] * s, oy + (asp - p[1]) * s]; };
      const all = prep.drivers.map((d) => stateAt(d, T.current));
      feed.current.cars = all.map((x) => ({
        code: x.d.driver, team: x.d.team, frac: x.done ? 0 : x.frac, lapDur: x.lapDur, visible: !x.out && !x.done,
        pitting: Boolean(x.d.laps[x.lapIdx]?.pit && x.frac > 0.75), selected: x.d.driver === live.current.sel,
      }));
      const me = all.find((x) => x.d.driver === live.current.sel);
      feed.current.compound = TYRE_NAME[me?.d.laps[me.lapIdx]?.tyre || "M"] || "MEDIUM";
      (feed.current as any).speed = live.current.playing ? live.current.speed : 0;
      feed.current.sc = prep.spans.some((sp) => T.current >= sp.from && T.current < sp.to);
      const states = all.filter((x) => !x.out && !(x.done && T.current > x.d.last + 30));
      states.sort((a, b) => a.D - b.D);
      for (const st of states) {
        const isSel = st.d.driver === live.current.sel;
        const col = TEAM_COLOR[st.d.team] || "#ccc";
        const [x, y] = P(st.done ? 0 : st.frac);
        if (isSel && !st.done) {
          for (let k = 24; k > 0; k--) {
            const [tx, ty] = P(st.frac - k * 0.0025), [ux, uy] = P(st.frac - (k - 1) * 0.0025);
            g.strokeStyle = `rgba(255,181,71,${(1 - k / 24) * 0.8})`; g.lineWidth = 2; g.beginPath(); g.moveTo(tx, ty); g.lineTo(ux, uy); g.stroke();
          }
        }
        const lap = st.d.laps[st.lapIdx];
        const pitting = Boolean(lap && lap.pit && st.frac > 0.75);
        g.fillStyle = pitting ? "rgba(255,255,255,.35)" : col;
        g.beginPath(); g.arc(x, y, isSel ? 4.5 : 3, 0, Math.PI * 2); g.fill();
        if (isSel) { g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
          g.font = "700 11px Jost"; g.fillStyle = "#fff"; g.fillText(st.d.driver, x + 9, y - 6); }
      }
      if (now - lastTick > 140) { lastTick = now; setTick(T.current); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [prep, at, track, ttd]);

  // timing tower (React, ~7 Hz)
  const states = prep.drivers.map((d) => stateAt(d, tick)).sort((a, b) => b.D - a.D);
  const leader = states[0];
  const leaderLap = leader ? Math.min(race.laps, Math.floor(leader.D) + 1) : 1;
  const flag = prep.spans.find((sp) => tick >= sp.from && tick < sp.to);
  const selD = prep.drivers.find((d) => d.driver === sel) || prep.drivers[0];
  const selState = stateAt(selD, tick);
  const calls = selD.laps.filter((l) => l.call === 1);
  const stops = selD.laps.filter((l) => l.pit);
  const clean = selD.laps.filter((l) => l.rep && l.time && l.pred);
  const mae = clean.reduce((a, l) => a + Math.abs((l.time as number) - (l.pred as number)), 0) / Math.max(clean.length, 1);
  const firstCalls = (() => { const out: string[] = []; let seg: typeof selD.laps = []; selD.laps.forEach((l) => { seg.push(l); if (l.pit) { const c = seg.find((x) => x.call === 1); out.push(c ? (c.lap === l.lap ? "same lap" : `${c.lap - l.lap > 0 ? "+" : ""}${c.lap - l.lap}`) : "missed"); seg = []; } }); return out; })();

  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">Race theatre · 2025, never seen in training</div>
          <h1 className="title">Every race, <em>replayed.</em></h1>
          <p className="lede">Real circuit outlines from position telemetry, all 20 cars at their recorded pace. The tower shows how strongly the model expects each team to box this lap, against the stops they actually made.</p></div>
        <div style={{ minWidth: 280, flex: "0 1 360px" }}>
          <label className="label" htmlFor="race" style={{ display: "block", marginBottom: 8 }}>Race</label>
          <select id="race" value={ri} onChange={(e) => { setRi(+e.target.value); setPlaying(!reducedMotion()); }}>
            {races.map((r, i) => <option key={r.race_id} value={i}>R{r.race_id.slice(5)} · {r.event}</option>)}
          </select>
        </div>
      </div>
      <div className="deck stage3d rv">
        <Safe3D label="Race replay">{(k, onLost) => (
        <Canvas key={k} dpr={DPR} camera={{ fov: 42, near: 0.5, far: 12000, position: [0, 60, 60] }} gl={{ antialias: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => { gl.localClippingEnabled = true; onLost(gl); }}>
          <CircuitScene track={track} feed={feed} mode={mode} livery={TEAM_COLOR[selD.team] || "#14161b"} />
          {FX && <EffectComposer multisampling={0}>
            <Bloom mipmapBlur luminanceThreshold={0.4} intensity={1.2} radius={0.75} />
            <Vignette offset={0.2} darkness={0.8} />
          </EffectComposer>}
        </Canvas>)}</Safe3D>
        <div className="overlay">
          <div className="lapcount">LAP {leaderLap}<small>/ {race.laps}</small><div className="label" style={{ marginTop: 8 }}>{race.event}</div>
            <div className="follow"><span className="team" style={{ background: TEAM_COLOR[selD.team] || "#888" }} />{selD.driver} · {selD.team}</div><CornerTag corner={feed.current.corner} /></div>
          <div style={{ display: "grid", gap: 10, justifyItems: "end" }}>
            <div className="seg modes" role="group" aria-label="Camera">
              {MODES.map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => { setMode(k); emit("theatre:mode", k); }}>{l}</button>)}
            </div>
            {flag && <div className={`flag ${flag.s === "S" ? "sc" : ""}`}>{flag.s === "S" ? "Safety car" : "Virtual safety car"}</div>}
          </div>
        </div>
        <div className="minimap" ref={stage}><canvas ref={canvas} role="img" aria-label={`${race.event} track map, lap ${leaderLap} of ${race.laps}`} /></div>
        <div className="deck tower tower-float" aria-label="Timing tower" data-explain="tower">
          <div className="deck-head" style={{ padding: "6px 8px 0" }}><span className="label">Timing tower</span><span className="meta">bar = P(box this lap)</span></div>
          {states.map((st, i) => {
            const lap = st.d.laps[st.lapIdx];
            const p = st.done ? 0 : lap?.p ?? 0;
            const pitting = Boolean(!st.done && lap?.pit && st.frac > 0.6);
            const gap = st.out ? "OUT" : st.done ? (st.d.finished ? `P${st.d.rank}` : "–") : i === 0 ? "Leader"
              : leader.done ? "last lap" : leader.D - st.D >= 1 ? `+${Math.floor(leader.D - st.D)}L` : `+${fmt((leader.D - st.D) * leader.lapDur, 1)}`;
            return (
              <button key={st.d.driver} className={`tower-row ${st.d.driver === sel ? "sel" : ""} ${lap?.call === 1 && !st.done ? "calling" : ""}`} onClick={() => { setSel(st.d.driver); emit("theatre:follow", st.d.driver); }}
                aria-label={`P${i + 1} ${st.d.driver}, ${st.d.team}`} aria-pressed={st.d.driver === sel}>
                <span className="pos">{i + 1}</span>
                <span className="team" style={{ background: TEAM_COLOR[st.d.team] || "#888" }} />
                <span className="code">{st.d.driver}</span>
                <Tyre c={lap?.tyre || "?"} />
                <span className="callbar"><i style={{ width: `${Math.round(p * 100)}%` }} /></span>
                <span className="gap">{gap}</span>
                {pitting && <span className="tag">PIT</span>}
                {!pitting && lap?.call === 1 && !st.done && <span className="tag call">BOX?</span>}
                {st.out && <span className="tag out">OUT</span>}
              </button>
            );
          })}
                </div>
      </div>
      <div className="deck timeline rv">
        <button className="play" onClick={() => { if (T.current >= prep.maxT) T.current = 0; setPlaying(!playing); }} aria-label={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} fill />
        </button>
        <div className="mono" style={{ minWidth: 92, color: "var(--text-2)", fontSize: 13 }}>{`${Math.floor(tick / 60)}:${String(Math.floor(tick % 60)).padStart(2, "0")}`}<br /><span style={{ color: "var(--text-3)" }}>race clock</span></div>
        <div className="scrub">
          <div className="bands">{prep.spans.map((sp, i) => <i key={i} style={{ left: `${(sp.from / prep.maxT) * 100}%`, width: `${((sp.to - sp.from) / prep.maxT) * 100}%`, background: sp.s === "S" ? "#ff8a00" : "var(--yellow)", opacity: 0.6 }} />)}</div>
          <input type="range" min={0} max={Math.round(prep.maxT)} value={Math.round(tick)} aria-label="Race time"
            style={{ ["--fill" as any]: `${(tick / prep.maxT) * 100}%` }}
            onChange={(e) => { T.current = +e.target.value; setTick(T.current); }} />
          <div className="marks">
            {stops.map((l) => <i key={"s" + l.lap} style={{ left: `${((l.t as number) / prep.maxT) * 100}%`, background: "var(--green)" }} title={`${selD.driver} stop lap ${l.lap}`} />)}
            {calls.map((l) => <i key={"c" + l.lap} style={{ left: `${((l.t as number) / prep.maxT) * 100}%`, background: "var(--text)", opacity: 0.8 }} />)}
          </div>
        </div>
        <div className="speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
      </div>
      <div className="below">
        <LapChart driver={selD} lapNow={selState.d.laps[selState.lapIdx]?.lap ?? 1} raceLaps={race.laps} />
        <div className="deck rv" style={{ overflow: "hidden" }}>
          <div className="deck-head" style={{ padding: "18px 18px 0" }}><span className="label">{selD.driver} · {selD.team}</span><span className="meta">click a car in the tower to follow it</span></div>
          <dl className="facts" style={{ borderTop: "1px solid var(--hair)", marginTop: 12 }}>
            <div><dt>Finish</dt><dd>{selD.finished ? `P${selD.rank}` : selD.finish || "DNF"}</dd></div>
            <div><dt>Stops</dt><dd>{stops.map((l) => "L" + l.lap).join(" ") || "none"}</dd></div>
            <div><dt>Lap MAE</dt><dd>{fmt(mae, 3)} s</dd></div>
            <div><dt>Model vs stop</dt><dd style={{ fontSize: 14 }}>{firstCalls.join(", ") || "–"}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function LapChart({ driver, lapNow, raceLaps }: { driver: Driver; lapNow: number; raceLaps: number }) {
  const laps = driver.laps.filter((l) => l.time);
  const reps = laps.filter((l) => l.rep).map((l) => l.time as number).sort((a, b) => a - b);
  const med = reps[Math.floor(reps.length / 2)] || 90;
  const clamp = (t: number) => Math.min(Math.max(t, med - 2.5), med + 5);
  const stops = driver.laps.filter((l) => l.pit).map((l) => ({ x: l.lap + 0.5, label: "BOX", color: "#f5f5f7" }));
  return (
    <div className="deck pad rv">
      <div className="deck-head"><span className="label">Lap time · {driver.driver}</span><span className="meta">grows with the replay · dots coloured by tyre, letter in tooltip</span></div>
      <LineChart ariaLabel={`Lap times for ${driver.driver}`} height={250} x={[1, raceLaps]} y={[med - 2.5, med + 5]} reveal={lapNow} playhead={lapNow}
        xLabel="lap" fmtY={(v) => v.toFixed(1)} markers={stops} animateKey={driver.driver}
        series={[
          { id: "act", label: "Actual", color: "#f5f5f7", kind: "dots", points: laps.filter((l) => l.rep).map((l) => [l.lap, clamp(l.time as number)]), dotColor: (_d, i) => TYRE_COLOR[laps.filter((l) => l.rep)[i]?.tyre] || "#aaa" },
          { id: "pred", label: "Predicted (laps already driven)", color: "#2a8bdb", kind: "line", points: driver.laps.filter((l) => l.pred).map((l) => [l.lap, clamp(l.pred as number)]) },
        ]} />
      <div className="deck-head" style={{ marginTop: 14 }}><span className="label">P(team boxes this lap)</span><span className="meta">pit-call model · threshold frozen from 2024</span></div>
      <LineChart ariaLabel={`Pit-call probability for ${driver.driver}`} height={150} x={[1, raceLaps]} y={[0, 1]} yTicks={[0, 0.5, 1]} reveal={lapNow} playhead={lapNow}
        fmtY={(v) => `${Math.round(v * 100)}%`} xLabel="lap" markers={stops} animateKey={driver.driver + "p"}
        series={[{ id: "p", label: "P(box)", color: "#e10600", kind: "area", points: driver.laps.filter((l) => l.p != null).map((l) => [l.lap, l.p as number]) }]} />
    </div>
  );
}
