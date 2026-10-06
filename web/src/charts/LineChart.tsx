/* One chart component for every line/step/dot chart in the app, built to the dataviz skill:
 * 2px lines, hairline solid grid, area wash at ~10%, >=8px markers with a surface ring, one y-axis,
 * legend for >=2 series plus selective end labels, crosshair + tooltip on hover, and a progressive
 * `reveal` (draw only up to x) so charts grow live with playback. */
import { useEffect, useMemo, useRef, useState } from "react";

export type Pt = [number, number];
export type Series = {
  id: string; label: string; color: string; points: Pt[];
  kind?: "line" | "step" | "area" | "dots" | "bars";
  dotColor?: (p: Pt, i: number) => string; dashed?: boolean; endLabel?: boolean; width?: number;
  aux?: boolean; // drawn, but left out of the legend (e.g. a dashed extrapolation of another series)
};
type Marker = { x: number; color?: string; label?: string };
type Band = { from: number; to: number; color: string };
type Props = {
  series: Series[]; height?: number; width?: number;
  x?: [number, number]; y?: [number, number]; yInvert?: boolean; yTicks?: number[]; xTicks?: number[];
  xLabel?: string; yLabel?: string; fmtX?: (v: number) => string; fmtY?: (v: number) => string;
  markers?: Marker[]; bands?: Band[]; playhead?: number | null; reveal?: number | null; zero?: boolean;
  legend?: boolean; ariaLabel: string; animateKey?: string | number;
};

const SURFACE = "#15151e";
const niceTicks = (lo: number, hi: number, n = 4) => {
  const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
};

// end labels: keep a 15px vertical gap between labels whose anchors are horizontally close
function placeEnds<T extends { x: number; y: number }>(ls: T[]): (T & { ly: number })[] {
  const out = ls.map((l) => ({ ...l, ly: l.y })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++)
    for (let j = 0; j < i; j++)
      if (Math.abs(out[i].x - out[j].x) < 110 && out[i].ly - out[j].ly < 15) out[i].ly = out[j].ly + 15;
  return out;
}

export default function LineChart(p: Props) {
  // the viewBox tracks the rendered width, so text and strokes stay at true size in any panel
  const wrap = useRef<HTMLDivElement>(null);
  const [mw, setMw] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setMw(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = p.width ?? (mw || 900), H = p.height ?? 240, ml = 52, mr = 56, mt = 12, mb = 32;
  const all = p.series.flatMap((s) => s.points);
  const x = p.x ?? [Math.min(...all.map((d) => d[0])), Math.max(...all.map((d) => d[0]))];
  const yr = p.y ?? (() => { const ys = all.map((d) => d[1]); const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || 1; return [lo - pad, hi + pad] as [number, number]; })();
  const X = (v: number) => ml + ((v - x[0]) / (x[1] - x[0] || 1)) * (W - ml - mr);
  const Y = (v: number) => { const t = (v - yr[0]) / (yr[1] - yr[0] || 1); return p.yInvert ? mt + t * (H - mt - mb) : H - mb - t * (H - mt - mb); };
  const fx = p.fmtX ?? ((v) => String(Math.round(v))), fy = p.fmtY ?? ((v) => v.toFixed(1));
  const yTicks = p.yTicks ?? niceTicks(yr[0], yr[1]);
  const xTicks = p.xTicks ?? niceTicks(x[0], x[1], 6);
  const lim = p.reveal ?? Infinity;
  const vis = (pts: Pt[]) => pts.filter((d) => d[0] <= lim);
  const path = (s: Series) => {
    const pts = vis(s.points);
    if (!pts.length) return "";
    if (s.kind === "step") return pts.map((d, i) => (i ? `H${X(d[0])}V${Y(d[1])}` : `M${X(d[0])},${Y(d[1])}`)).join("");
    return pts.map((d, i) => `${i ? "L" : "M"}${X(d[0]).toFixed(1)},${Y(d[1]).toFixed(1)}`).join("");
  };
  const base = p.zero ? Y(0) : (p.yInvert ? mt : H - mb);
  const area = (s: Series) => { const pts = vis(s.points); if (!pts.length) return ""; return `${path(s)}L${X(pts[pts.length - 1][0])},${base}L${X(pts[0][0])},${base}Z`; };

  // draw-in animation when the data identity changes
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svg.current || !mw || matchMedia("(prefers-reduced-motion: reduce)").matches || p.reveal != null) return;
    svg.current.querySelectorAll<SVGPathElement>("path.ln").forEach((el) => {
      const L = el.getTotalLength();
      el.animate([{ strokeDasharray: `${L}`, strokeDashoffset: `${L}` }, { strokeDasharray: `${L}`, strokeDashoffset: "0" }], { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  }, [p.animateKey, mw > 0]);

  // hover: nearest x across series
  const [hover, setHover] = useState<{ px: number; xv: number } | null>(null);
  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    if (sx < ml || sx > W - mr) { setHover(null); return; }
    const xv = x[0] + ((sx - ml) / (W - ml - mr)) * (x[1] - x[0]);
    setHover({ px: e.clientX - r.left, xv });
  };
  const nearest = (s: Series, xv: number) => {
    let best: Pt | null = null, bd = Infinity;
    for (const d of vis(s.points)) { const dd = Math.abs(d[0] - xv); if (dd < bd) { bd = dd; best = d; } }
    return best;
  };
  // snap to the nearest x of any series, and only report series whose drawn range covers it
  const hx = hover ? p.series.reduce<number | null>((b, s) => { const d = nearest(s, hover.xv); return d && (b == null || Math.abs(d[0] - hover.xv) < Math.abs(b - hover.xv)) ? d[0] : b; }, null) : null;
  const covers = (s: Series, xv: number) => { const v = vis(s.points); return v.length > 0 && xv >= v[0][0] && xv <= v[v.length - 1][0]; };
  const keyed = p.series.filter((s) => !s.aux);
  const showLegend = (p.legend ?? true) && keyed.length >= 2;
  const endLabels = useMemo(() => p.series.filter((s) => s.endLabel && vis(s.points).length), [p.series, lim]);

  return (
    <div className="chart" ref={wrap} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {showLegend && (
        <div className="legend" style={{ marginTop: 0, marginBottom: 8 }}>
          {keyed.map((s) => <span key={s.id}><i className="sw ln" style={{ background: s.color, height: s.kind === "dots" ? 8 : 2, width: s.kind === "dots" ? 8 : 16, borderRadius: s.kind === "dots" ? 4 : 0 }} />{s.label}</span>)}
        </div>
      )}
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={p.ariaLabel}>
        <g className="grid">
          {yTicks.map((t) => <line key={"y" + t} x1={ml} x2={W - mr} y1={Y(t)} y2={Y(t)} />)}
        </g>
        {(p.bands || []).map((b, i) => <rect key={i} x={X(b.from)} width={Math.max(1, X(b.to) - X(b.from))} y={mt} height={H - mt - mb} fill={b.color} />)}
        {p.zero && <line x1={ml} x2={W - mr} y1={Y(0)} y2={Y(0)} stroke="#4a4a58" strokeWidth={1} />}
        {yTicks.map((t) => <text key={"yt" + t} x={ml - 8} y={Y(t) + 3.5} textAnchor="end">{fy(t)}</text>)}
        {xTicks.map((t) => <text key={"xt" + t} x={X(t)} y={H - mb + 16} textAnchor="middle">{fx(t)}</text>)}
        {p.xLabel && <text className="axis-title" x={W - mr} y={H - 2} textAnchor="end">{p.xLabel}</text>}
        {p.yLabel && <text className="axis-title" x={ml} y={mt - 2 < 8 ? 8 : mt - 2} textAnchor="start" dy={-2}>{p.yLabel}</text>}
        {(p.markers || []).map((m, i) => (
          <g key={i}><line x1={X(m.x)} x2={X(m.x)} y1={mt} y2={H - mb} stroke={m.color || "#4a4a58"} strokeWidth={1} />
            {m.label && <text x={X(m.x) + 4} y={mt + 10} style={{ fill: m.color || "#8c8c99", fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: ".08em" }}>{m.label}</text>}</g>
        ))}
        {p.series.map((s) => s.kind === "area" ? <path key={s.id + "a"} d={area(s)} fill={s.color} opacity={0.1} /> : null)}
        {p.series.map((s) => s.kind === "bars" ? vis(s.points).map((d, i) => {
          const bw = Math.min(24, ((W - ml - mr) / s.points.length) * 0.7), y0 = p.zero ? Y(0) : H - mb, y1 = Y(d[1]);
          return <rect key={s.id + i} x={X(d[0]) - bw / 2} y={Math.min(y0, y1)} width={bw} height={Math.max(1, Math.abs(y1 - y0))} rx={2} fill={s.dotColor ? s.dotColor(d, i) : s.color} />;
        }) : null)}
        {p.series.map((s) => (s.kind === "dots" || s.kind === "bars") ? null : (
          <path key={s.id} className="ln" d={path(s)} fill="none" stroke={s.color} strokeWidth={s.width ?? 2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "6 5" : undefined} />
        ))}
        {p.series.map((s) => s.kind === "dots" ? vis(s.points).map((d, i) => (
          <circle key={s.id + i} cx={X(d[0])} cy={Y(d[1])} r={4} fill={s.dotColor ? s.dotColor(d, i) : s.color} stroke={SURFACE} strokeWidth={2} />
        )) : null)}
        {placeEnds(endLabels.map((s) => { const v = vis(s.points), d = v[v.length - 1]; return { s, d, x: X(d[0]), y: Y(d[1]) }; })).map(({ s, d, x, y, ly }) => (
          <g key={s.id + "e"}><circle cx={x} cy={y} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />
            {Math.abs(ly - y) > 2 && <line x1={x + 4} y1={y} x2={x + 10} y2={ly} stroke={s.color} strokeWidth={1} />}
            <text x={x + 12} y={ly + 4} style={{ fill: "#f5f5f7", fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 13 }}>{s.label} {fy(d[1])}</text></g>))}
        {p.playhead != null && <line x1={X(p.playhead)} x2={X(p.playhead)} y1={mt} y2={H - mb} stroke="#e10600" strokeWidth={1.5} />}
        {hx != null && <line className="xhair" x1={X(hx)} x2={X(hx)} y1={mt} y2={H - mb} />}
        {hx != null && p.series.map((s) => { const d = covers(s, hx) ? nearest(s, hx) : null; return d && s.kind !== "bars" ? <circle key={s.id + "h"} cx={X(d[0])} cy={Y(d[1])} r={4.5} fill={s.color} stroke={SURFACE} strokeWidth={2} /> : null; })}
      </svg>
      {hover && hx != null && (
        <div className="tip" style={{ left: Math.min(hover.px, (svg.current?.clientWidth ?? 600) - 170), top: "45%" }}>
          <b>{p.xLabel ? `${p.xLabel} ${fx(hx)}` : fx(hx)}</b>
          {p.series.map((s) => { const d = covers(s, hx) ? nearest(s, hx) : null; return d ? <div className="row" key={s.id}><span><i style={{ background: s.color }} /> {s.label}</span><span>{fy(d[1])}</span></div> : null; })}
        </div>
      )}
    </div>
  );
}
