/* What If: ask in plain English, see exactly what was understood, then watch the real car race its
 * what-if twin on the real circuit while the result builds lap by lap. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Data, TEAM_COLOR, TYRE_COLOR, fmt, reducedMotion, signed } from "../data";
import { Tyre, useReveal } from "../ui/kit";
import LineChart from "../charts/LineChart";
import { Atmosphere, Cameras, CarState, Feed, FollowCar, Pods, TrackMesh, useCircuit } from "../three/Circuit3D";
import { Change, Result, Stint, runWhatIf } from "../whatif/engine";
import { describe, parse } from "../whatif/parser";
import { emit } from "../guide/bus";
import { DPR, FX, Safe3D } from "../ui/safety";

const EXAMPLES = [
  "What if Leclerc had followed Pitwall's strategy at Monza?",
  "What if Verstappen pitted 5 laps later at Zandvoort?",
  "What if there was no safety car in the Dutch GP for Verstappen?",
  "What if a safety car came out on lap 30 in Bahrain for Norris?",
  "What if Norris had two-stopped in Hungary?",
  "What if the track was 10°C hotter in Hungary for Norris?",
];
const CHANGE_TYPES: [Change["type"], string][] = [
  ["pitShift", "Move a stop by N laps"], ["pitLap", "Stop on a given lap"], ["compound", "Different tyre for a stint"],
  ["dropStop", "Skip a stop"], ["addStop", "Add a stop"], ["optimal", "Follow Pitwall's strategy"],
  ["noSC", "Remove Safety Cars"], ["addSC", "Add a Safety Car"], ["trackTemp", "Change track temperature"], ["pitLoss", "Faster / slower stops"],
];
const SPEEDS = [4, 8, 16, 32, 64];

const clockState = (cum: (number | null)[], T: number) => {
  const laps: number[] = [], ts: number[] = [];
  cum.forEach((v, n) => { if (v != null) { laps.push(n); ts.push(v); } });
  if (!ts.length) return { frac: 0, lap: 1, done: true, visible: false, dur: 90 };
  if (T >= ts[ts.length - 1]) return { frac: 0, lap: laps[laps.length - 1], done: true, visible: false, dur: 90 };
  let i = 0; while (i < ts.length - 1 && ts[i] <= T) i++;
  const t0 = i ? ts[i - 1] : ts[0] - (ts[1] - ts[0] || 90), dur = ts[i] - t0;
  return { frac: dur > 0 ? Math.min(Math.max((T - t0) / dur, 0), 1) : 0, lap: laps[i], done: false, visible: true, dur };
};

function StintBar({ stints, laps, label }: { stints: Stint[]; laps: number; label: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, alignItems: "center" }}>
      <span className="label">{label}</span>
      <div style={{ position: "relative", height: 26 }}>
        {stints.map((s, i) => (
          <div key={i} title={`${s.compound} laps ${s.from}-${s.to}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${((s.from - 1) / laps) * 100}%`, width: `calc(${((s.to - s.from + 1) / laps) * 100}% - 2px)`,
            background: TYRE_COLOR[s.compound], display: "flex", alignItems: "center", paddingLeft: 6, color: "#111", font: "700 12px var(--display)", letterSpacing: ".06em", overflow: "hidden", whiteSpace: "nowrap" }}>
            {s.to - s.from >= 4 ? `${s.compound[0]} · ${s.to - s.from + 1}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stage({ res, feed, mode }: { res: Result; feed: Feed; mode: string }) {
  const track = res ? (window as any).__pwTracks?.[res.race.circuit] : null;
  if (!track) return null;
  return <StageInner track={track} feed={feed} mode={mode} team={res.team} driver={res.driver} />;
}
function StageInner({ track, feed, mode, team, driver }: any) {
  const c = useCircuit(track);
  const ghost = (cars: CarState[]) => cars.find((x) => x.ghost);
  const real = (cars: CarState[]) => cars.find((x) => x.selected);
  return (
    <>
      <Atmosphere c={c} far={mode === "overview"} />
      <TrackMesh c={c} />
      <Pods feed={feed} c={c} />
      <FollowCar feed={feed} c={c} livery={TEAM_COLOR[team] || "#101014"} pick={real} label={`${driver} · REAL`} />
      <FollowCar feed={feed} c={c} livery="#ececf0" accent="#e10600" pick={ghost} ghost label={`${driver} · WHAT IF`} />
      <Cameras feed={feed} c={c} mode={mode} pick={ghost} />
    </>
  );
}

export default function WhatIf({ data }: { data: Data }) {
  (window as any).__pwTracks = data.tracks;
  const races = useMemo(() => data.races.filter((r) => data.tracks[r.circuit]), [data]);
  const [text, setText] = useState(EXAMPLES[0]);
  const [raceIdx, setRaceIdx] = useState(0);
  const [driver, setDriver] = useState("");
  const [changes, setChanges] = useState<Change[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [res, setRes] = useState<Result | null>(null);
  const [mode, setMode] = useState("chase");
  const [speed, setSpeed] = useState(16);
  const [playing, setPlaying] = useState(false);
  const [tick, setTick] = useState(0);
  const T = useRef(0);
  const live = useRef({ playing, speed });
  live.current = { playing, speed };
  const feed = useRef({ cars: [], compound: "MEDIUM", speed: 0 }) as Feed;
  const root = useReveal("whatif");
  const race = races[raceIdx];

  const understand = (q: string) => {
    const p = parse(q, races);
    if (p.raceIdx != null) setRaceIdx(p.raceIdx);
    const r = races[p.raceIdx ?? raceIdx];
    const d = p.driver && r.drivers.some((x) => x.driver === p.driver) ? p.driver : (r.drivers[0]?.driver ?? "");
    setDriver(d);
    setChanges(p.changes);
    setMissing(p.missing.concat(p.driver && !r.drivers.some((x) => x.driver === p.driver) ? [`${p.driver} has no laps in ${r.event}`] : []));
    return { ok: p.raceIdx != null && p.changes.length > 0, r, d, ch: p.changes };
  };
  const run = (r = race, d = driver, ch = changes) => {
    const out = runWhatIf(data.model, r as any, d, ch);
    setRes(out);
    const start = Math.min(...out.field.map((f) => (f.cum.find((v) => v != null) as number) ?? 0));
    T.current = Math.max(0, start - 5); setTick(T.current);
    setPlaying(!reducedMotion());
    emit("whatif:run");
  };
  const ask = () => { const u = understand(text); if (u.ok) run(u.r, u.d, u.ch); else setRes(null); };
  useEffect(() => { understand(EXAMPLES[0]); }, []);

  // race clock
  useEffect(() => {
    if (!res?.ok) return;
    const end = Math.max(...res.field.map((f) => Math.max(...f.cum.filter((v): v is number => v != null))), (res.cf.cum[res.lastLap] as number) || 0);
    let raf = 0, last = performance.now(), lastTick = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (live.current.playing) { T.current = Math.min(end, T.current + dt * live.current.speed); if (T.current >= end) setPlaying(false); }
      const cars: CarState[] = res.field.filter((f) => f.driver !== res.driver).map((f) => {
        const s = clockState(f.cum, T.current);
        return { code: f.driver, team: f.team, frac: s.frac, lapDur: s.dur, visible: s.visible, pitting: false, selected: false };
      });
      const a = clockState(res.actual.cum, T.current), g = clockState(res.cf.cum, T.current);
      cars.push({ code: res.driver, team: res.team, frac: a.frac, lapDur: a.dur, visible: a.visible, pitting: false, selected: true });
      cars.push({ code: res.driver, team: res.team, frac: g.frac, lapDur: g.dur, visible: g.visible, pitting: false, selected: false, ghost: true });
      feed.current.cars = cars;
      const st = res.cf.stints.find((x) => g.lap >= x.from && g.lap <= x.to);
      feed.current.compound = st?.compound || "MEDIUM";
      feed.current.speed = live.current.playing ? live.current.speed : 0;
      if (now - lastTick > 120) { lastTick = now; setTick(T.current); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [res]);

  const ok = res?.ok;
  const gLap = ok ? clockState(res!.cf.cum, tick).lap : 1;
  const aLap = ok ? clockState(res!.actual.cum, tick).lap : 1;
  const lapNow = ok ? Math.min(gLap, aLap) : 1;
  const done = ok && tick >= ((res!.cf.cum[res!.lastLap] as number) || 0) && tick >= ((res!.actual.cum[res!.lastLap] as number) || 0);
  // live gap: what-if minus real at the last lap both have completed
  const gapNow = ok ? (() => { const n = lapNow - 1; const a = res!.actual.cum[n], c = res!.cf.cum[n]; return a != null && c != null ? (c as number) - (a as number) : 0; })() : 0;
  const series = ok ? {
    posA: res!.actual.pos.map((p, n) => [n, p]).filter((d) => d[1] != null) as [number, number][],
    posC: res!.cf.pos.map((p, n) => [n, p]).filter((d) => d[1] != null) as [number, number][],
    gap: res!.cf.cum.map((v, n) => [n, v != null && res!.actual.cum[n] != null ? (v as number) - (res!.actual.cum[n] as number) : null]).filter((d) => d[1] != null) as [number, number][],
  } : null;
  const nDrivers = race?.drivers.length || 20;
  const setChange = (i: number, c: Change | null) => setChanges((cs) => (c ? cs.map((x, k) => (k === i ? c : x)) : cs.filter((_, k) => k !== i)));
  const addChange = (type: Change["type"]) => {
    const def: Record<string, Change> = {
      pitShift: { type: "pitShift", stop: 1, delta: -3 }, pitLap: { type: "pitLap", stop: 1, lap: 20 }, compound: { type: "compound", stint: 1, compound: "HARD" },
      dropStop: { type: "dropStop", stop: -1 }, addStop: { type: "addStop", lap: 0 }, optimal: { type: "optimal" }, noSC: { type: "noSC" },
      addSC: { type: "addSC", lap: 20, laps: 4 }, trackTemp: { type: "trackTemp", delta: 10 }, pitLoss: { type: "pitLoss", delta: -2 },
    };
    setChanges((cs) => [...cs, def[type]]);
  };

  return (
    <div ref={root}>
      <div className="view-head rv">
        <div><div className="kicker">What if · counterfactual race engine</div>
          <h1 className="title">Change one thing. <em>Rerun the race.</em></h1>
          <p className="lede">Ask about any driver in any 2025 dry race. Pitwall rebuilds that race lap by lap with the change applied, from the driver's real pace, the tyre model and measured pit losses, then races the real car against its what-if twin.</p></div>
      </div>

      <section className="deck pad rv" data-explain="whatif-ask">
        <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Ask a what-if question" placeholder="What if Verstappen pitted 3 laps earlier at Monza?" />
          <button className="btn" type="submit">Run it</button>
        </form>
        <div className="chips" style={{ marginTop: 12 }}>
          {EXAMPLES.map((q) => <button key={q} className="chip" onClick={() => { setText(q); const u = understand(q); if (u.ok) run(u.r, u.d, u.ch); }}>{q}</button>)}
        </div>
      </section>

      <section className="deck pad rv" style={{ marginTop: 16 }} data-explain="whatif-understood">
        <div className="deck-head"><span className="label">Understood as</span><span className="meta">edit anything, then run</span></div>
        <div className="builder">
          <div className="row">
            <div><div className="ctl-row"><span>Race</span></div>
              <select value={raceIdx} onChange={(e) => { const i = +e.target.value; setRaceIdx(i); setDriver(races[i].drivers[0]?.driver ?? ""); }}>
                {races.map((r, i) => <option key={r.race_id} value={i}>R{r.race_id.slice(5)} · {r.event}</option>)}</select></div>
            <div><div className="ctl-row"><span>Driver</span></div>
              <select value={driver} onChange={(e) => setDriver(e.target.value)}>
                {race?.drivers.map((d) => <option key={d.driver} value={d.driver}>{d.driver} · {d.team} · finished {/^\d+$/.test(d.finish) ? "P" + d.finish : d.finish || "DNF"}</option>)}</select></div>
          </div>
          <div className="change-list">
            {changes.map((c, i) => (
              <div className="change" key={i}>
                <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <b style={{ fontFamily: "var(--display)", letterSpacing: ".06em", textTransform: "uppercase" }}>{describe(c)}</b>
                  {"delta" in c && <input aria-label="amount" type="number" value={(c as any).delta} onChange={(e) => setChange(i, { ...(c as any), delta: +e.target.value })} style={{ width: 70, height: 32, background: "var(--bg)", border: "1px solid var(--line-2)", padding: "0 6px" }} />}
                  {"lap" in c && <input aria-label="lap" type="number" value={(c as any).lap} onChange={(e) => setChange(i, { ...(c as any), lap: +e.target.value })} style={{ width: 70, height: 32, background: "var(--bg)", border: "1px solid var(--line-2)", padding: "0 6px" }} />}
                  {"compound" in c && <select value={(c as any).compound || "HARD"} onChange={(e) => setChange(i, { ...(c as any), compound: e.target.value })} style={{ width: 120, height: 32 }}>
                    {["SOFT", "MEDIUM", "HARD"].map((k) => <option key={k}>{k}</option>)}</select>}
                </span>
                <button aria-label="Remove change" onClick={() => setChange(i, null)}>×</button>
              </div>
            ))}
            {!changes.length && <div className="note" style={{ marginTop: 0 }}>No change understood yet. Pick one below or rephrase the question.</div>}
          </div>
          {missing.length > 0 && <div className="chips">{missing.map((m) => <span key={m} className="chip warn">Could not place: {m}</span>)}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select aria-label="Add a change" defaultValue="" onChange={(e) => { if (e.target.value) addChange(e.target.value as Change["type"]); e.target.value = ""; }} style={{ maxWidth: 280 }}>
              <option value="">+ Add a change…</option>{CHANGE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <button className="btn" onClick={() => run()} disabled={!changes.length || !driver}>Rerun the race</button>
          </div>
        </div>
      </section>

      {res && !res.ok && <div className="deck pad" style={{ marginTop: 16 }}><b>Can't run that one:</b> <span className="muted">{res.error}</span></div>}
      {ok && (
        <>
          <div className="wi-grid">
            <div className="deck wi-stage rv" data-explain="whatif-stage">
              <Safe3D label="What-if rerun">{(k, onLost) => (
              <Canvas key={k} dpr={DPR} camera={{ fov: 44, near: 0.5, far: 12000, position: [0, 50, 50] }} onCreated={({ gl }) => { gl.localClippingEnabled = true; onLost(gl); }}>
                <Stage res={res!} feed={feed} mode={mode} />
                {FX && <EffectComposer multisampling={0}><Bloom mipmapBlur luminanceThreshold={0.45} intensity={1} radius={0.7} /><Vignette offset={0.2} darkness={0.8} /></EffectComposer>}
              </Canvas>)}</Safe3D>
              <div className="stage3d" style={{ position: "absolute", inset: 0, pointerEvents: "none", height: "auto", minHeight: 0, overflow: "visible", background: "none" }}>
                <div className="overlay" style={{ right: 22 }}>
                  <div className="lapcount">LAP {lapNow}<small>/ {res!.race.laps}</small><div className="label" style={{ marginTop: 6 }}>{res!.race.event}</div></div>
                  <div style={{ display: "grid", gap: 10, justifyItems: "end" }}>
                    <div className="seg modes" role="group" aria-label="Camera">
                      {[["chase", "Chase"], ["tv", "TV"], ["heli", "Heli"]].map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}
                    </div>
                    <div className="tag-skew" style={{ background: gapNow > 0.05 ? "#e10600" : gapNow < -0.05 ? "#2a8bdb" : "#363642", height: 32, padding: "0 14px" }}>
                      <span className="mono" style={{ fontSize: 15 }}>{gapNow === 0 ? "level" : `${signed(gapNow, 1)} s vs real`}</span></div>
                  </div>
                </div>
              </div>
            </div>
            <div className="deck pad verdict-card rv" data-explain="whatif-verdict">
              <div className="deck-head" style={{ marginBottom: 0 }}><span className="label">{done ? "Result" : "Live run"} · {res!.driver} · {res!.race.event}</span></div>
              <div className="poschange">
                <span className="p">P{res!.actual.finish ?? "–"}</span><span className="arrow">→</span>
                <span className="p cf">{done ? `P${res!.cf.finish ?? "–"}` : `P${res!.cf.pos[lapNow - 1] ?? "–"}`}</span>
              </div>
              <div className="delta-big" style={{ color: ((done ? res!.delta : gapNow) ?? 0) <= 0 ? "#2a8bdb" : "#ff4d45" }}>
                {done ? `${signed(res!.delta, 1)} s ${res!.deltaKind}` : `${signed(gapNow, 1)} s so far`}</div>
              <div className="label">Official result: {/^\d+$/.test(res!.actual.official) ? "P" + res!.actual.official : res!.actual.official}</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)" }}>{res!.applied.map((a) => <li key={a}>{a}</li>)}</ul>
              <div style={{ display: "grid", gap: 6 }}>
                <StintBar stints={res!.actual.stints} laps={res!.race.laps} label="Real" />
                <StintBar stints={res!.cf.stints} laps={res!.race.laps} label="What if" />
              </div>
              {res!.notes.map((n) => <p key={n} className="note" style={{ margin: 0 }}>{n}</p>)}
              <div className="timeline" style={{ margin: 0, padding: 0, gridTemplateColumns: "auto minmax(0,1fr)" }}>
                <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
                  <svg className="icon" viewBox="0 0 24 24"><path d={playing ? "M7 4h4v16H7zM14 4h4v16h-4z" : "M7 4v16l13-8z"} /></svg></button>
                <div className="speed" role="group" aria-label="Playback speed">
                  {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
                  <button onClick={() => { T.current = 1e9; setPlaying(false); }}>End</button>
                </div>
              </div>
            </div>
          </div>
          <div className="cols" style={{ marginTop: 16 }}>
            <section className="deck pad rv" data-explain="whatif-positions">
              <div className="deck-head"><span className="label">Position by lap</span><span className="meta">grows with the live run</span></div>
              <LineChart ariaLabel="Position by lap, real vs what-if" height={240} x={[1, res!.race.laps]} y={[0.5, nDrivers + 0.5]} yInvert yTicks={[1, 5, 10, 15, 20].filter((v) => v <= nDrivers)}
                reveal={lapNow} playhead={lapNow} xLabel="lap" fmtY={(v) => `P${Math.round(v)}`} animateKey={res!.driver + res!.applied.join()}
                series={[{ id: "a", label: "Real", color: "#2a8bdb", kind: "step", points: series!.posA, endLabel: true }, { id: "c", label: "What if", color: "#e10600", kind: "step", points: series!.posC, endLabel: true }]} />
            </section>
            <section className="deck pad rv" data-explain="whatif-gap">
              <div className="deck-head"><span className="label">What-if minus real, seconds</span><span className="meta">below zero = ahead of the real race</span></div>
              <LineChart ariaLabel="Time difference what-if minus real by lap" height={240} x={[1, res!.race.laps]} zero reveal={lapNow} playhead={lapNow} xLabel="lap" fmtY={(v) => signed(v, 0)}
                animateKey={"g" + res!.driver + res!.applied.join()} series={[{ id: "g", label: "Δ time", color: "#e10600", kind: "area", points: series!.gap }]} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
