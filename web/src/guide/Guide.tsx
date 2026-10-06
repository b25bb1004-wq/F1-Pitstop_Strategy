/* Race-engineer guide: a personal onboarder (pick who you are, then a spotlight tour whose "try it"
 * tasks only complete when you actually do them) plus Explain mode (click anything marked to have it
 * explained at your level). State is remembered per browser. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EXPLAIN, GOALS, PROFILES, Profile, STEPS } from "./content";
import { on } from "./bus";

const KEY = "pitwall-guide";
type Saved = { profile?: Profile; goal?: string; step?: number; done?: string[]; dismissed?: boolean };
const load = (): Saved => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const save = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

export default function Guide({ go, view, explain, setExplain }: { go: (v: string) => void; view: string; explain: boolean; setExplain: (b: boolean) => void }) {
  const [st, setSt] = useState<Saved>(load);
  const [open, setOpen] = useState(() => !load().dismissed && !load().profile);
  const [touring, setTouring] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [taskDone, setTaskDone] = useState(false);
  const [pop, setPop] = useState<{ key: string; x: number; y: number } | null>(null);
  const update = (p: Partial<Saved>) => setSt((s) => { const n = { ...s, ...p }; save(n); return n; });
  const profile: Profile = st.profile || "fan";

  // order the tour around the chosen goal
  const steps = (() => {
    const order = st.goal === "races" ? ["tower", "cams", "onboard", "call", "garage", "whatif", "proof"]
      : st.goal === "whatif" ? ["whatif", "call", "garage", "tower", "cams", "onboard", "proof"] : STEPS.map((s) => s.id);
    return order.map((id) => STEPS.find((s) => s.id === id)!);
  })();
  const idx = Math.min(st.step ?? 0, steps.length - 1);
  const step = steps[idx];

  // navigate to the step's view and track the target's box
  useEffect(() => { if (touring && step && view !== step.view) go(step.view); }, [touring, idx]);
  useLayoutEffect(() => {
    if (!touring || !step?.target) { setRect(null); return; }
    let raf = 0, tries = 0;
    const find = () => {
      const el = document.querySelector(step.target!) as HTMLElement | null;
      if (el) {
        if (tries === 0 || tries === 20) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        setRect(el.getBoundingClientRect());
      }
      tries++;
      raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [touring, idx, view]);

  // tasks complete only when the user actually does them
  useEffect(() => {
    setTaskDone(false);
    if (!touring || !step?.task) return;
    return on((e) => {
      if (e.name === step.task!.event && (!step.task!.value || e.value === step.task!.value)) {
        setTaskDone(true);
        update({ done: Array.from(new Set([...(st.done || []), step.id])) });
        setTimeout(() => next(), 1100);
      }
    });
  }, [touring, idx]);

  const next = () => {
    if (idx >= steps.length - 1) { setTouring(false); update({ step: 0 }); setOpen(false); return; }
    update({ step: idx + 1 });
  };
  const start = () => { setOpen(false); setTouring(true); update({ step: st.step ?? 0, dismissed: true }); };

  // Explain mode: click any [data-explain] element
  useEffect(() => {
    document.body.classList.toggle("explain-on", explain);
    if (!explain) { setPop(null); return; }
    const click = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-explain]") as HTMLElement | null;
      if (!el) { setPop(null); return; }
      e.preventDefault(); e.stopPropagation();
      setPop({ key: el.dataset.explain!, x: e.clientX, y: e.clientY });
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setPop(null); setExplain(false); } };
    document.addEventListener("click", click, true);
    addEventListener("keydown", key);
    return () => { document.removeEventListener("click", click, true); removeEventListener("keydown", key); };
  }, [explain]);

  // coach card placement: beside the spotlight, else bottom-left
  const coachStyle = (() => {
    if (!rect) return { left: 18, bottom: 78 } as React.CSSProperties;
    const below = rect.bottom + 220 < innerHeight, w = Math.min(380, innerWidth - 32);
    const left = Math.min(Math.max(16, rect.left), innerWidth - w - 16);
    return below ? { left, top: rect.bottom + 14 } : { left, top: Math.max(76, rect.top - 250) };
  })();
  const ex = pop ? EXPLAIN[pop.key] : null;

  return (
    <>
      {!touring && !open && (
        <button className="guide-fab" onClick={() => setOpen(true)} aria-label="Open your race engineer">
          <span className="av"><svg className="icon" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}><path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" /></svg></span>
          <span className="fab-lbl">Race engineer</span>
        </button>
      )}

      {open && !touring && (
        <div className="coach" role="dialog" aria-label="Your race engineer" style={{ left: 18, bottom: 78 }}>
          <header><span className="label">Race engineer · radio check</span></header>
          <h4>{st.profile ? "Welcome back" : "Hi. I'm your race engineer."}</h4>
          <p>I'll walk you through Pitwall at your level. Pick who you are, and what you want first.</p>
          <div className="profile-pick">{PROFILES.map((p) => (
            <button key={p.id} aria-pressed={st.profile === p.id} onClick={() => update({ profile: p.id })}><b>{p.title}</b><span>{p.blurb}</span></button>
          ))}</div>
          <div className="profile-pick" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>{GOALS.map((g) => (
            <button key={g.id} aria-pressed={st.goal === g.id} onClick={() => update({ goal: g.id, step: 0 })} style={{ textAlign: "center" }}><b style={{ fontSize: 14 }}>{g.title}</b></button>
          ))}</div>
          <footer>
            <button className="text-btn" onClick={() => { setOpen(false); update({ dismissed: true }); }}>Not now</button>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn ghost" onClick={() => { setOpen(false); setExplain(true); }}>Explain mode</button>
              <button className="btn" onClick={start} disabled={!st.profile}>{(st.step ?? 0) > 0 ? "Resume tour" : "Start tour"}</button>
            </div>
          </footer>
        </div>
      )}

      {touring && step && (
        <>
          {rect && <div className="spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
          <div className="coach" role="dialog" aria-live="polite" aria-label={step.title} style={coachStyle}>
            <header><span className="label">Step {idx + 1} of {steps.length} · {PROFILES.find((p) => p.id === profile)?.title}</span></header>
            <h4>{step.title}</h4>
            <p>{step.body[profile]}</p>
            {step.task && <div className={`task ${taskDone ? "done" : ""}`}><b>{taskDone ? "Done. Nice." : "Try it"}</b>{step.task.text[profile]}</div>}
            <footer>
              <div className="dots" aria-hidden="true">{steps.map((s, i) => <i key={s.id} className={i <= idx ? "on" : ""} />)}</div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="text-btn" onClick={() => { setTouring(false); }}>Exit</button>
                {idx > 0 && <button className="text-btn" onClick={() => update({ step: idx - 1 })}>Back</button>}
                <button className="btn" onClick={next}>{idx === steps.length - 1 ? "Finish" : step.task && !taskDone ? "Skip" : "Next"}</button>
              </div>
            </footer>
          </div>
        </>
      )}

      {explain && <div className="explain-banner">Explain mode · click anything outlined · Esc to exit</div>}
      {ex && pop && (
        <div className="explain-pop" role="dialog" style={{ left: Math.min(pop.x + 12, innerWidth - 360), top: Math.min(pop.y + 12, innerHeight - 200) }}>
          <b>{ex.title}</b>{ex[profile]}
        </div>
      )}
    </>
  );
}
