/* Small shared UI pieces: icons, tyre badge, ring gauge, slider, segmented control, magnetic hover, count-up. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import { reducedMotion } from "../data";

const PATHS: Record<string, string> = {
  wall: "M3 3v18h18M7 14l3-3 3 3 5-6",
  theatre: "M12 2a10 10 0 1 0 10 10M12 6v6l4 2M18 2v4h4",
  lab: "M9 3h6M10 3v6L4 19a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 19l-6-10V3",
  proof: "M3 3h18v18H3zM3 9h18M9 21V9",
  github: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4M9 18c-4.51 2-5-2-7-2",
  play: "M7 4v16l13-8z", pause: "M7 4h4v16H7zM14 4h4v16h-4z", arrow: "M5 12h14M13 6l6 6-6 6",
  flag: "M4 22V4M4 4h13l-2 4 2 4H4",
  rew: "M11 6L4 12l7 6zM20 6l-7 6 7 6z", ffw: "M13 6l7 6-7 6zM4 6l7 6-7 6z", chevron: "M6 9l6 6 6-6",
  restart: "M3 12a9 9 0 1 0 3-6.7M3 3v6h6", minus: "M5 12h14", plus: "M12 5v14M5 12h14",
  keys: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  onboard: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12l4-3M6 15h3M15 15h3",
  whatif: "M9.1 9a3 3 0 1 1 4 2.8c-.6.3-1.1.9-1.1 1.6V14M12 17.5v.5M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0",
};
export function Icon({ name, fill = false }: { name: string; fill?: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" style={fill ? { fill: "currentColor", stroke: "none" } : undefined}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export const Tyre = ({ c, lg = false }: { c: string; lg?: boolean }) => (
  <span className={`tyre ${c[0]}${lg ? " lg" : ""}`} aria-label={{ S: "soft", M: "medium", H: "hard", I: "intermediate", W: "wet" }[c[0]] || c}>{c[0]}</span>
);

/* SVG ring gauge with animated sweep */
export function Ring({ value, color, label }: { value: number; color: string; label: string }) {
  const R = 38, C = 2 * Math.PI * R;
  const arc = useRef<SVGCircleElement>(null);
  const txt = useRef<SVGTextElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const o = { v: prev.current };
    const set = () => {
      arc.current?.setAttribute("stroke-dasharray", `${(o.v / 100) * C} ${C}`);
      if (txt.current) txt.current.textContent = `${Math.round(o.v)}%`;
    };
    if (reducedMotion()) { o.v = value; set(); } else gsap.to(o, { v: value, duration: 0.7, ease: "power3.out", onUpdate: set });
    prev.current = value;
  }, [value]);
  return (
    <svg className="ring" viewBox="0 0 92 92" role="img" aria-label={`${label}: ${Math.round(value)}%`}>
      <circle cx="46" cy="46" r={R} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="7" />
      <circle ref={arc} cx="46" cy="46" r={R} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
        transform="rotate(-90 46 46)" style={{ filter: `drop-shadow(0 0 8px ${color})` }} />
      <text ref={txt} x="46" y="51" textAnchor="middle" fill="#eef0f4" fontSize="17" fontWeight="600" />
    </svg>
  );
}

export function Slider({ id, label, value, min, max, onChange, display }: any) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="ctl">
      <div className="ctl-row"><label htmlFor={id}>{label}</label><output htmlFor={id}>{display ?? value}</output></div>
      <input id={id} type="range" min={min} max={max} value={value} style={{ ["--fill" as any]: `${pct}%` }}
        onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}

export function Segmented({ label, value, options, onChange }: { label: string; value: string; options: [string, any][]; onChange: (v: string) => void }) {
  return (
    <div className="ctl">
      <div className="ctl-row"><span>{label}</span></div>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([v, content]) => (
          <button key={v} aria-pressed={v === value} onClick={() => onChange(v)}>{content}</button>
        ))}
      </div>
    </div>
  );
}

/* magnetic hover (GSAP quickTo), off under reduced motion */
export function useMagnetic<T extends HTMLElement>(strength = 0.25) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || matchMedia("(pointer: coarse)").matches) return;
    const xTo = gsap.quickTo(el, "x", { duration: 0.5, ease: "elastic.out(1, 0.45)" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.5, ease: "elastic.out(1, 0.45)" });
    const move = (e: PointerEvent) => { const r = el.getBoundingClientRect(); xTo((e.clientX - r.left - r.width / 2) * strength); yTo((e.clientY - r.top - r.height / 2) * strength); };
    const leave = () => { xTo(0); yTo(0); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerleave", leave);
    return () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); };
  }, [strength]);
  return ref;
}

export function CountUp({ to, decimals = 2, suffix = "", className = "" }: { to: number; decimals?: number; suffix?: string; className?: string }) {
  const el = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const o = { v: 0 };
    const set = () => el.current && (el.current.textContent = o.v.toFixed(decimals) + suffix);
    if (reducedMotion()) { o.v = to; set(); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { gsap.to(o, { v: to, duration: 1.6, ease: "expo.out", onUpdate: set }); io.disconnect(); }
    });
    set(); if (el.current) io.observe(el.current);
    return () => io.disconnect();
  }, [to]);
  return <b ref={el as any} className={className} />;
}

/* run a GSAP stagger reveal of `.rv` children when a view mounts */
export function useReveal(dep: any) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || reducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(".rv", { opacity: 0, y: 26, duration: 0.8, ease: "expo.out", stagger: 0.07, clearProps: "transform,opacity" });
    }, ref);
    return () => ctx.revert();
  }, [dep]);
  return ref;
}

export function useVisible<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [vis, setVis] = useState(true);
  useEffect(() => {
    if (!ref.current) return;
    const io = new IntersectionObserver(([e]) => setVis(e.isIntersecting), { rootMargin: "100px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, vis] as const;
}
