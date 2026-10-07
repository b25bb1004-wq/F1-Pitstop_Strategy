import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import Intro from "./intro/Intro";
import { Data, loadAll, reducedMotion } from "./data";
import { Icon } from "./ui/kit";
import { Boundary } from "./ui/safety";
import Guide from "./guide/Guide";
import { emit } from "./guide/bus";

const PitWall = lazy(() => import("./views/PitWall"));
const Theatre = lazy(() => import("./views/Theatre"));
const TyreLab = lazy(() => import("./views/TyreLab"));
const Onboard = lazy(() => import("./views/Onboard"));
const WhatIfView = lazy(() => import("./views/WhatIf"));
const Proof = lazy(() => import("./views/Proof"));

const VIEWS = [
  { id: "wall", label: "Pit Wall", short: "Wall", icon: "wall" },
  { id: "theatre", label: "Race Theatre", short: "Races", icon: "theatre" },
  { id: "onboard", label: "Onboard", short: "Onboard", icon: "onboard" },
  { id: "whatif", label: "What If", short: "What if", icon: "whatif" },
  { id: "lab", label: "Tyre Lab", short: "Tyres", icon: "lab" },
  { id: "proof", label: "Proof", short: "Proof", icon: "proof" },
];
const fromHash = () => (VIEWS.some((v) => v.id === location.hash.slice(1)) ? location.hash.slice(1) : "wall");

function Nav({ view, go, explain, setExplain }: { view: string; go: (v: string) => void; explain: boolean; setExplain: (b: boolean) => void }) {
  const pill = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  const place = (animate: boolean) => {
    const btn = pill.current?.querySelector<HTMLButtonElement>(`[data-v="${view}"]`);
    if (!btn || !ink.current) return;
    const to = { left: btn.offsetLeft + 10, width: Math.max(10, btn.offsetWidth - 20) };
    animate && !reducedMotion() ? gsap.to(ink.current, { ...to, duration: 0.45, ease: "expo.out" }) : gsap.set(ink.current, to);
  };
  useLayoutEffect(() => place(true), [view]);
  useEffect(() => { const r = () => place(false); addEventListener("resize", r); document.fonts?.ready.then(r); return () => removeEventListener("resize", r); }, [view]);
  return (
    <header className="nav">
      <a className="logo" href="#wall" onClick={(e) => { e.preventDefault(); go("wall"); }} aria-label="Pitwall home">
        <span className="slash" aria-hidden="true"><i /><i /></span>Pitwall
      </a>
      <nav className="pill" ref={pill} aria-label="Views">
        <span className="ink" ref={ink} aria-hidden="true" />
        {VIEWS.map((v) => (
          <button key={v.id} data-v={v.id} aria-current={view === v.id ? "page" : undefined} onClick={() => go(v.id)}>
            <Icon name={v.icon} /><span className="lbl">{v.label}</span><span className="short">{v.short}</span>
          </button>
        ))}
      </nav>
      <div className="navright">
        <button className={`navbtn ${explain ? "on" : ""}`} aria-pressed={explain} onClick={() => setExplain(!explain)} title="Click anything outlined to have it explained">Explain</button>
        <a className="navlink" href="https://github.com/b25bb1004-wq/F1-Pitstop_Strategy" target="_blank" rel="noreferrer"><Icon name="github" /> Source</a>
      </div>
    </header>
  );
}

export default function App() {
  const [progress, setProgress] = useState([0, 0, 0, 0, 0]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const [view, setView] = useState(fromHash);
  const [explain, setExplain] = useState(false);
  useEffect(() => { emit("view", view); }, [view]);
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

  const View = { wall: PitWall, theatre: Theatre, onboard: Onboard, whatif: WhatIfView, lab: TyreLab, proof: Proof }[view] as any;
  return (
    <>
      <div className="backdrop" aria-hidden="true" />

      {introDone && data && (
        <>
          <Nav view={view} go={go} explain={explain} setExplain={setExplain} />
          <main ref={stage}>
            <Suspense fallback={<div style={{ height: "70vh" }} />}>
              <Boundary label={VIEWS.find((v) => v.id === view)?.label} resetKey={view}><View data={data} go={go} /></Boundary>
            </Suspense>
          </main>
          <footer>
            <span>Pitwall v2.5.1 · Arnav Yadav · FastF1 timing and telemetry 2021-2025 · fitted 2021-23, tuned 2024, tested once on 2025</span>
            <span>Not affiliated with Formula 1 · car model "Ferrari F1-75" by Sketcher (CC-BY-NC-4.0), de-branded · frontend built with Claude Code</span>
          </footer>
          <Guide go={go} view={view} explain={explain} setExplain={setExplain} />
        </>
      )}
      {!introDone && <Intro progress={progress} ready={!!data} error={error} onDone={() => setIntroDone(true)} onRetry={load} />}
    </>
  );
}
