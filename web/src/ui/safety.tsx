/* Resilience: error boundaries, WebGL checks, context-loss recovery and adaptive quality. */
import { Component, ReactNode, useEffect, useState } from "react";

/* Low-power devices and phones get no post-processing and a lower pixel ratio. */
export const QUALITY = (() => {
  if (typeof window === "undefined") return "high";
  const coarse = matchMedia("(pointer: coarse)").matches, cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as any).deviceMemory || 8;
  return coarse || cores <= 4 || mem <= 4 ? "low" : "high";
})();
export const DPR: [number, number] = QUALITY === "low" ? [1, 1.25] : [1, 1.6];
export const FX = QUALITY === "high";

export const hasWebGL = (() => {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
})();

type BoundaryProps = { children: ReactNode; label?: string; compact?: boolean; silent?: boolean; resetKey?: unknown };
export class Boundary extends Component<BoundaryProps, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) {
    // a deploy can leave a stale tab pointing at chunks that no longer exist: reload once to pick up the new build
    if (/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(String(err?.message))) {
      try { if (!sessionStorage.getItem("pw-reloaded")) { sessionStorage.setItem("pw-reloaded", "1"); location.reload(); } } catch {}
    }
    console.error(`[pitwall] ${this.props.label || "panel"} failed:`, err);
  }
  componentDidUpdate(prev: BoundaryProps) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="deck pad" role="alert" style={{ display: "grid", gap: 10, placeItems: this.props.compact ? "center" : "start", minHeight: this.props.compact ? "100%" : undefined, height: this.props.compact ? "100%" : undefined, alignContent: "center" }}>
        <span className="kicker">Red flag</span>
        <b style={{ font: "800 italic 24px var(--display)", textTransform: "uppercase" }}>{this.props.label || "This panel"} stopped</b>
        <span style={{ color: "var(--text-2)", fontSize: 14 }}>The rest of Pitwall still works. {String(this.state.err.message || "").slice(0, 140)}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => this.setState({ err: null })}>Restart panel</button>
          <button className="btn ghost" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

/* Wraps a 3D canvas: no WebGL -> explanation; context lost -> pause and offer a restore. */
export function Safe3D({ children, label }: { children: (key: number, onLost: (gl: any) => void) => ReactNode; label: string }) {
  const [key, setKey] = useState(0);
  const [lost, setLost] = useState(false);
  const onLost = (gl: any) => {
    const el = gl?.domElement as HTMLCanvasElement | undefined;
    el?.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setLost(true); }, { once: true });
  };
  useEffect(() => { if (lost) { const id = setTimeout(() => { setLost(false); setKey((k) => k + 1); }, 1500); return () => clearTimeout(id); } }, [lost]);
  if (!hasWebGL) return (
    <div className="deck pad" style={{ height: "100%", display: "grid", placeContent: "center", textAlign: "center", gap: 8 }}>
      <span className="kicker" style={{ justifySelf: "center" }}>3D unavailable</span>
      <span style={{ color: "var(--text-2)" }}>This browser has WebGL turned off, so the {label} 3D view can't run. Everything else on the page still works.</span>
    </div>
  );
  return (
    <Boundary label={label} compact resetKey={key}>
      {lost ? <div style={{ height: "100%", display: "grid", placeContent: "center", color: "var(--text-2)" }}>Graphics reset, restoring…</div> : children(key, onLost)}
    </Boundary>
  );
}
