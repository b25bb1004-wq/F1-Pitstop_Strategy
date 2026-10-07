/* Race Theatre: every 2025 race replayed on its real circuit outline at recorded pace, with a live
 * timing tower showing the pit-call model's probability and the team's actual stops. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Data, Driver, TEAM_COLOR, TYRE_COLOR, fmt, reducedMotion, timeToDistFn } from "../data";
import LineChart from "../charts/LineChart";
import { Icon, Tyre, useReveal } from "../ui/kit";
import { CircuitScene, Feed, newView } from "../three/Circuit3D";
import ViewSphere from "../three/ViewSphere";
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
  const [lbOpen, setLbOpen] = useState(false);
  const [labelsOn, setLabelsOn] = useState(true);
  const [drsOn, setDrsOn] = useState(true);
  const [keysOpen, setKeysOpen] = useState(false);
  const view = useRef(newView()).current;
  const labelHost = useRef<HTMLDivElement>(null);
  const lbRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const T = useRef(0);
  const feed = useRef({ cars: [], compound: "MEDIUM", speed: 32 }) as Feed;
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLCanvasElement | null>(null);
  const geom = useRef({ W: 0, H: 0, s: 1, ox: 0, oy: 0, dpr: 1 });
  const root = useReveal("theatre");
  const live = useRef({ playing, speed, sel, labels: labelsOn });
  live.current = { playing, speed, sel, labels: labelsOn };

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
      // double-outline road (grey edges, black asphalt), DRS zones in green
      g.strokeStyle = "#9a9aa0"; g.lineWidth = 7; path(); g.stroke();
      const drs = (track as any).drs_zone as number[] | undefined;
      if (drs && drsOn) {
        const n = track.points.length;
        g.strokeStyle = "#22d65a";
        for (let i = 0; i < n - 1; i++) {
          if (drs[Math.round((i / (n - 1)) * (drs.length - 1))] !== 1) continue;
          const [ax, ay] = P(track.points[i]), [bx, by] = P(track.points[i + 1]);
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        }
      }
      g.strokeStyle = "#000"; g.lineWidth = 4.2; path(); g.stroke();
      // start / finish
      const [x0, y0] = P(track.points[0]), [x1, y1] = P(track.points[2]);
      const nx = -(y1 - y0), ny = x1 - x0, n = Math.hypot(nx, ny) || 1;
      g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.moveTo(x0 + (nx / n) * 10, y0 + (ny / n) * 10); g.lineTo(x0 - (nx / n) * 10, y0 - (ny / n) * 10); g.stroke();
      g.fillStyle = "#9a9aa0"; g.font = "600 10px JetBrains Mono"; g.fillText("S/F", x0 + 12, y0 - 8);
      layer.current = L;
    };
    build();
    const ro = new ResizeObserver(build); ro.observe(host);
    return () => ro.disconnect();
  }, [track, drsOn]);

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
        const lap = st.d.laps[st.lapIdx];
        const pitting = Boolean(lap && lap.pit && st.frac > 0.75);
        g.fillStyle = pitting ? "rgba(255,255,255,.35)" : col;
        g.strokeStyle = "#000"; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, isSel ? 4.2 : 3.2, 0, Math.PI * 2); g.fill(); g.stroke();
        if (isSel) { g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke(); }
        if (isSel || live.current.labels) { g.font = `${isSel ? 700 : 600} 10px Barlow`; g.fillStyle = isSel ? "#fff" : col; g.fillText(st.d.driver, x + 7, y - 5); }
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
  const selPos = Math.max(1, states.findIndex((x) => x.d.driver === selD.driver) + 1);
  const ahead = states[selPos - 2], behind = states[selPos];
  const gapTo = (a: typeof selState, b: typeof selState) => (a.D - b.D >= 1 ? `${Math.floor(a.D - b.D)}L` : `${fmt((a.D - b.D) * b.lapDur, 2)}s`);
  const selLap = selState.d.laps[selState.lapIdx];
  const lapStarts = useMemo(() => { const w = prep.drivers.find((d) => d.rank === 1) || prep.drivers[0]; return [0, ...(w?.tEnd || [])]; }, [prep]);
  const seek = (t: number) => { T.current = Math.max(0, Math.min(prep.maxT, t)); setTick(T.current); };
  const jumpLap = (dir: number) => {
    const t = T.current; let idx = lapStarts.findIndex((x) => x > t); if (idx < 0) idx = lapStarts.length;
    const k = idx - 1;
    seek(dir > 0 ? lapStarts[k + 1] ?? prep.maxT : t - lapStarts[k] > 3 ? lapStarts[k] : lapStarts[Math.max(0, k - 1)]);
  };
  const stepSpeed = (d: number) => setSpeed((v) => SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(v) + d))]);
  const togglePlay = () => { if (T.current >= prep.maxT) T.current = 0; setPlaying((p) => !p); };
  // keyboard, like a video player, only while the replay is on screen and no field has focus
  useEffect(() => {
    let visible = false;
    const io = new IntersectionObserver(([e]) => { visible = e.intersectionRatio > 0.4; }, { threshold: [0, 0.4, 1] });
    if (stageRef.current) io.observe(stageRef.current);
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!visible || e.metaKey || e.ctrlKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.closest(".vs-globe")) return;
      const map: Record<string, () => void> = {
        " ": togglePlay, ArrowLeft: () => jumpLap(-1), ArrowRight: () => jumpLap(1), ArrowUp: () => stepSpeed(1), ArrowDown: () => stepSpeed(-1),
        "1": () => setSpeed(1), "2": () => setSpeed(2), "3": () => setSpeed(4), "4": () => setSpeed(8),
        r: () => { seek(0); setPlaying(true); }, l: () => setLabelsOn((v) => !v), d: () => setDrsOn((v) => !v), g: () => setLbOpen((v) => !v),
        Escape: () => { setLbOpen(false); setKeysOpen(false); },
      };
      const f = map[e.key] || map[e.key.toLowerCase()];
      if (f) { e.preventDefault(); f(); }
    };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); io.disconnect(); };
  }, [prep, lapStarts]);
  useEffect(() => {
    if (!lbOpen) return;
    const close = (e: PointerEvent) => { if (!lbRef.current?.contains(e.target as Node)) setLbOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [lbOpen]);
  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = (e.currentTarget.querySelector(".lt") as HTMLElement).getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * prep.maxT);
  };
  const pct = (t: number) => `${(t / prep.maxT) * 100}%`;
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
      <div className="deck stage3d rv" ref={stageRef}>
        <Safe3D label="Race replay">{(k, onLost) => (
        <Canvas key={k} dpr={DPR} camera={{ fov: 42, near: 0.5, far: 12000, position: [0, 60, 60] }} gl={{ antialias: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => { gl.localClippingEnabled = true; onLost(gl); }}>
          <CircuitScene track={track} feed={feed} mode={mode} livery={TEAM_COLOR[selD.team] || "#14161b"} view={view} labels={{ host: labelHost, on: labelsOn }} />
          {FX && <EffectComposer multisampling={0}>
            <Bloom mipmapBlur luminanceThreshold={0.5} intensity={0.9} radius={0.7} />
            <Vignette offset={0.25} darkness={0.7} />
          </EffectComposer>}
        </Canvas>)}</Safe3D>
        <div className="clabels" ref={labelHost} aria-hidden="true" />
        <div className="overlay">
          <div className="lapcount">LAP {leaderLap}<small>/ {race.laps}</small><div className="label" style={{ marginTop: 8 }}>{race.event}</div>
            <div className="dcard" style={{ ["--team" as any]: TEAM_COLOR[selD.team] || "#888" }}>
              <div className="dcard-h"><span>Driver: {selD.driver}</span><small>{selD.team}</small></div>
              <div className="dcard-b">
                <dl>
                  <div><dt>Position</dt><dd>P{selPos}</dd></div>
                  <div><dt>Lap</dt><dd>{selLap?.lap ?? "–"} / {race.laps}</dd></div>
                  <div><dt>Tyre</dt><dd><Tyre c={selLap?.tyre || "?"} /> {selLap?.age != null ? `${selLap.age} laps` : ""}</dd></div>
                  <div><dt>Ahead{ahead ? ` (${ahead.d.driver})` : ""}</dt><dd>{ahead ? `+${gapTo(ahead, selState)}` : "leader"}</dd></div>
                  <div><dt>Behind{behind ? ` (${behind.d.driver})` : ""}</dt><dd>{behind ? `−${gapTo(selState, behind)}` : "–"}</dd></div>
                </dl>
                <div className="vbars" title="Pit-call model: probability the team boxes this lap">
                  <div className="vbar"><i style={{ height: `${Math.round((selState.done ? 0 : selLap?.p ?? 0) * 100)}%` }} /></div>
                  <span>BOX</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gap: 10, justifyItems: "end", alignContent: "start" }}>
            <div className="seg modes" role="group" aria-label="Camera">
              {MODES.map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => { setMode(k); emit("theatre:mode", k); }}>{l}</button>)}
            </div>
            <div className={`lb ${lbOpen ? "open" : ""}`} ref={lbRef} data-explain="tower">
              <button className="lb-head" onClick={() => setLbOpen((o) => !o)} aria-expanded={lbOpen} aria-controls="lb-list">
                <span className="lb-t">Leaderboard</span>
                <span className="lb-s"><b style={{ color: TEAM_COLOR[leader?.d.team] || "#ccc" }}>1. {leader?.d.driver}</b>
                  <em>following</em><b style={{ color: TEAM_COLOR[selD.team] || "#ccc" }}>{selPos}. {selD.driver}</b></span>
                <Icon name="chevron" />
              </button>
              {lbOpen && (
                <div className="lb-list" id="lb-list" role="listbox" aria-label="Leaderboard: pick a driver to follow">
                  {states.map((st, i) => {
                    const lap = st.d.laps[st.lapIdx];
                    const p = st.done ? 0 : lap?.p ?? 0;
                    const pitting = Boolean(!st.done && lap?.pit && st.frac > 0.6);
                    const gap = st.out ? "" : st.done ? (st.d.finished ? `P${st.d.rank}` : "–") : i === 0 ? "Leader"
                      : leader.done ? "last lap" : leader.D - st.D >= 1 ? `+${Math.floor(leader.D - st.D)}L` : `+${fmt((leader.D - st.D) * leader.lapDur, 1)}`;
                    const isSel = st.d.driver === sel;
                    return (
                      <button key={st.d.driver} role="option" aria-selected={isSel} className={`lb-row ${isSel ? "sel" : ""} ${lap?.call === 1 && !st.done ? "calling" : ""}`}
                        onClick={() => { setSel(st.d.driver); emit("theatre:follow", st.d.driver); setLbOpen(false); }}>
                        <span className="pos">{i + 1}.</span>
                        <span className="code" style={{ color: isSel ? undefined : TEAM_COLOR[st.d.team] || "#ccc" }}>{st.d.driver}</span>
                        <span className="gap">{gap}</span>
                        <span className="pb" title={`P(box) ${Math.round(p * 100)}%`}><i style={{ width: `${Math.round(p * 100)}%` }} /></span>
                        {st.out ? <span className="tag out">OUT</span> : pitting ? <span className="tag">PIT</span> : <Tyre c={lap?.tyre || "?"} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {flag && <div className={`flag ${flag.s === "S" ? "sc" : ""}`}>{flag.s === "S" ? "Safety car" : "Virtual safety car"}</div>}
          </div>
        </div>
        <div className="corner-slot"><CornerTag corner={feed.current.corner} /></div>
        <div className="minimap" ref={stage}><canvas ref={canvas} role="img" aria-label={`${race.event} track map, lap ${leaderLap} of ${race.laps}`} /></div>
        {mode === "overview" && <ViewSphere view={view} track={track} feed={feed} pointAt={(f) => at(ttd(f))} />}
      </div>
      <div className="deck timeline rr rv">
        <div className="transport">
          <button className="rbtn" onClick={() => jumpLap(-1)} aria-label="Back one lap" title="Back one lap (←)"><Icon name="rew" fill /></button>
          <button className="rbtn play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title="Play / pause (space)"><Icon name={playing ? "pause" : "play"} fill /></button>
          <button className="rbtn" onClick={() => jumpLap(1)} aria-label="Forward one lap" title="Forward one lap (→)"><Icon name="ffw" fill /></button>
        </div>
        <div className="clock mono"><b>LAP {leaderLap}/{race.laps}</b><span>{`${Math.floor(tick / 3600)}:${String(Math.floor((tick % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(tick % 60)).padStart(2, "0")}`}</span></div>
        <div className="lapbar" role="slider" tabIndex={0} aria-label="Race position" aria-valuemin={0} aria-valuemax={Math.round(prep.maxT)} aria-valuenow={Math.round(tick)}
          aria-valuetext={`Lap ${leaderLap} of ${race.laps}`}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekAt(e); }}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e); }}
          onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); jumpLap(e.key === "ArrowLeft" ? -1 : 1); } }}>
          <div className="lflags">{prep.spans.map((sp, i) => <i key={i} className={sp.s === "S" ? "sc" : "vsc"} style={{ left: pct(sp.from), width: pct(sp.to - sp.from) }} title={sp.s === "S" ? "Safety Car" : "VSC"} />)}</div>
          <div className="lt">
            <div className="lfill" style={{ width: pct(tick) }} />
            {lapStarts.slice(1, -1).map((t, k) => <i key={k} className="tick" style={{ left: pct(t) }} />)}
            {stops.map((l) => <i key={"s" + l.lap} className="stop" style={{ left: pct(l.t as number) }} title={`${selD.driver} pits, lap ${l.lap}`} />)}
            <div className="lhead" style={{ left: pct(tick) }} />
          </div>
          <div className="lnums">{lapStarts.slice(0, -1).map((t, k) => (k === 0 || (k + 1) % 10 === 0) ? <span key={k} style={{ left: pct(t) }}>{k + 1}</span> : null)}<span style={{ left: "100%" }}>{race.laps}</span></div>
        </div>
        <div className="speedpill" role="group" aria-label="Playback speed">
          <button onClick={() => stepSpeed(-1)} aria-label="Slower" disabled={speed === SPEEDS[0]}><Icon name="minus" /></button>
          <label className="sp-v mono"><span>{speed}.0×</span>
            <select value={speed} onChange={(e) => setSpeed(+e.target.value)} aria-label="Playback speed">{SPEEDS.map((v) => <option key={v} value={v}>{v}×</option>)}</select></label>
          <button onClick={() => stepSpeed(1)} aria-label="Faster" disabled={speed === SPEEDS[SPEEDS.length - 1]}><Icon name="plus" /></button>
        </div>
        <div className="toggles">
          <button aria-pressed={labelsOn} onClick={() => setLabelsOn((v) => !v)} title="Driver labels (L)">Labels</button>
          <button aria-pressed={drsOn} onClick={() => setDrsOn((v) => !v)} title="DRS zones on the map (D)">DRS</button>
          <button className="rbtn sm" aria-expanded={keysOpen} onClick={() => setKeysOpen((v) => !v)} aria-label="Keyboard controls"><Icon name="keys" /></button>
        </div>
        <div className="legend-mini" aria-hidden="true"><span><i className="sc" />SC</span><span><i className="vsc" />VSC</span><span><i className="stop" />{selD.driver} stop</span></div>
        {keysOpen && (
          <div className="keys-pop" role="dialog" aria-label="Keyboard controls">
            <b>Controls</b>
            {[["Space", "Pause / resume"], ["← →", "Back / forward one lap"], ["↑ ↓", "Speed up / down"], ["1-4", "1×, 2×, 4×, 8×"],
              ["R", "Restart"], ["L", "Driver labels"], ["D", "DRS zones"], ["G", "Leaderboard"], ["Esc", "Close menus"]].map(([k, v]) => <div key={k}><kbd>{k}</kbd><span>{v}</span></div>)}
          </div>
        )}
      </div>
      <div className="below">
        <LapChart driver={selD} lapNow={selState.d.laps[selState.lapIdx]?.lap ?? 1} raceLaps={race.laps} />
        <div className="deck rv" style={{ overflow: "hidden" }}>
          <div className="deck-head" style={{ padding: "18px 18px 0" }}><span className="label">{selD.driver} · {selD.team}</span><span className="meta">pick a driver from the leaderboard to follow</span></div>
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
