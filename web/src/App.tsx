import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import Intro from "./intro/Intro";
import { Data, loadAll, reducedMotion } from "./data";
import { Icon } from "./ui/kit";

const PitWall = lazy(() => import("./views/PitWall"));
const Theatre = lazy(() => import("./views/Theatre"));
const TyreLab = lazy(() => import("./views/TyreLab"));
const Proof = lazy(() => import("./views/Proof"));

const VIEWS = [
  { id: "wall", label: "Pit Wall", short: "Wall", icon: "wall" },
  { id: "theatre", label: "Race Theatre", short: "Races", icon: "theatre" },
  { id: "lab", label: "Tyre Lab", short: "Tyres", icon: "lab" },
  { id: "proof", label: "Proof", short: "Proof", icon: "proof" },
];
const fromHash = () => (VIEWS.some((v) => v.id === location.hash.slice(1)) ? location.hash.slice(1) : "wall");

function Stars() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const draw = () => {
      const dpr = Math.min(devicePixelRatio, 2);
      c.width = innerWidth * dpr; c.height = innerHeight * dpr;
      const g = c.getContext("2d")!;
      g.scale(dpr, dpr);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 260; i++) {
        const x = rnd() * innerWidth, y = rnd() * innerHeight, r = rnd() * 1.1 + 0.15, a = rnd() * 0.55 + 0.1;
        g.fillStyle = rnd() > 0.92 ? `rgba(255,190,110,${a})` : `rgba(220,226,240,${a})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    };
    draw();
    addEventListener("resize", draw);
    return () => removeEventListener("resize", draw);
  }, []);
  return <canvas className="stars" ref={ref} aria-hidden="true" />;
}

function Nav({ view, go }: { view: string; go: (v: string) => void }) {
  const pill = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const btn = pill.current?.querySelector<HTMLButtonElement>(`[data-v="${view}"]`);
    if (!btn || !ink.current) return;
    const to = { left: btn.offsetLeft, width: btn.offsetWidth };
    reducedMotion() ? gsap.set(ink.current, to) : gsap.to(ink.current, { ...to, duration: 0.55, ease: "expo.out" });
  }, [view]);
  useEffect(() => {
    const r = () => {
      const btn = pill.current?.querySelector<HTMLButtonElement>(`[data-v="${view}"]`);
      if (btn && ink.current) gsap.set(ink.current, { left: btn.offsetLeft, width: btn.offsetWidth });
    };
    addEventListener("resize", r);
    return () => removeEventListener("resize", r);
  }, [view]);
  return (
    <header className="nav">
      <a className="logo" href="#wall" onClick={(e) => { e.preventDefault(); go("wall"); }} aria-label="Pitwall home">
        <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="17" fill="none" stroke="#ffb547" strokeWidth="7" />
          <circle cx="32" cy="32" r="17" fill="none" stroke="#ff2a1f" strokeWidth="7" strokeDasharray="26 81" transform="rotate(-90 32 32)" />
          <circle cx="32" cy="32" r="5" fill="#eef0f4" /></svg>
        Pitwall
      </a>
      <nav className="pill" ref={pill} aria-label="Views">
        <span className="ink" ref={ink} aria-hidden="true" />
        {VIEWS.map((v) => (
          <button key={v.id} data-v={v.id} aria-current={view === v.id ? "page" : undefined} onClick={() => go(v.id)}>
            <Icon name={v.icon} /><span className="lbl">{v.label}</span><span className="short">{v.short}</span>
          </button>
        ))}
      </nav>
      <a className="navlink" href="https://github.com/b25bb1004-wq/F1-Pitstop_Strategy" target="_blank" rel="noreferrer">
        <Icon name="github" /> Source
      </a>
    </header>
  );
}

export default function App() {
  const [progress, setProgress] = useState([0, 0, 0, 0, 0]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const [view, setView] = useState(fromHash);
  const stage = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    setProgress([0, 0, 0, 0, 0]);
    loadAll((i, f) => setProgress((p) => { const n = [...p]; n[i] = Math.max(n[i], f); return n; }))
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const h = () => setView(fromHash());
    addEventListener("hashchange", h);
    return () => removeEventListener("hashchange", h);
  }, []);

  const go = (v: string) => {
    if (v === view) return;
    history.pushState(null, "", "#" + v);
    if (reducedMotion() || !stage.current) { setView(v); scrollTo(0, 0); return; }
    gsap.to(stage.current, { opacity: 0, y: -12, filter: "blur(6px)", duration: 0.22, ease: "power2.in", onComplete: () => { setView(v); scrollTo(0, 0); } });
  };
  useLayoutEffect(() => {
    if (!stage.current || reducedMotion()) return;
    gsap.fromTo(stage.current, { opacity: 0, y: 18, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6, ease: "expo.out", clearProps: "filter,transform" });
  }, [view, introDone]);

  const View = { wall: PitWall, theatre: Theatre, lab: TyreLab, proof: Proof }[view] as any;
  return (
    <>
      <div className="backdrop" aria-hidden="true" />
      <Stars />
      <div className="grain" aria-hidden="true" />
      {introDone && data && (
        <>
          <Nav view={view} go={go} />
          <main ref={stage}>
            <Suspense fallback={<div style={{ height: "70vh" }} />}>
              <View data={data} go={go} />
            </Suspense>
          </main>
          <footer>
            <span>Pitwall v2.2 · Arnav Yadav · FastF1 timing data 2021-2025 · fitted 2021-23, tuned 2024, tested once on 2025</span>
            <span>Not affiliated with Formula 1. Procedural car model; circuit outlines from position telemetry.</span>
          </footer>
        </>
      )}
      {!introDone && <Intro progress={progress} ready={!!data} error={error} onDone={() => setIntroDone(true)} onRetry={load} />}
    </>
  );
}
