/* Data loading with real per-file progress (drives the five start lights). */
const BASE = import.meta.env.BASE_URL + "data/";

export const STAGES = ["Physics model", "Circuits", "Race telemetry", "Car", "Fonts"];

export type Lap = {
  lap: number; time: number | null; pred: number | null; tyre: string; age: number; status: string;
  pit: number; rep: number; gain: number | null; p: number | null; call: number | null; t: number | null; pos: number | null;
};
export type Driver = { driver: string; team: string; finish: string; laps: Lap[] };
export type Race = { race_id: string; event: string; circuit: string; laps: number; drivers: Driver[] };
export type Track = { points: [number, number][]; aspect: number; length_m: number; race: string; scale_m: number; z: number[] };
export type Data = { model: any; metrics: any; tracks: Record<string, Track>; races: Race[] };

async function fetchJson(name: string, onProgress: (f: number) => void) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) { const j = await res.json(); onProgress(1); return j; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(got / total, 0.98));
  }
  const j = JSON.parse(await new Blob(chunks as BlobPart[]).text());
  onProgress(1);
  return j;
}

export async function loadAll(onStage: (stage: number, frac: number) => void): Promise<Data> {
  const fonts = (document as any).fonts?.ready ?? Promise.resolve();
  const frac = [0, 0];
  const both = (i: number) => (x: number) => { frac[i] = x; onStage(0, (frac[0] + frac[1]) / 2); };
  const { loadCar } = await import("./three/CarModel");
  const car = loadCar((x) => onStage(3, x)).catch((e) => { console.warn("car model unavailable, using procedural car", e); onStage(3, 1); });
  const [model, metrics, tracks, racesRaw] = await Promise.all([
    fetchJson("model.json", both(0)), fetchJson("metrics.json", both(1)),
    fetchJson("tracks.json", (x) => onStage(1, x)), fetchJson("races.json", (x) => onStage(2, x)),
  ]);
  await car;
  await fonts;
  onStage(4, 1);
  const F: string[] = racesRaw.fields;
  const races: Race[] = racesRaw.races.map((r: any) => ({
    ...r,
    drivers: r.drivers.map((d: any) => ({
      ...d,
      laps: d.laps.map((a: any[]) => Object.fromEntries(F.map((k, i) => [k === "p_call" ? "p" : k, a[i]]))),
    })),
  }));
  return { model, metrics, tracks, races };
}

export const TEAM_COLOR: Record<string, string> = {
  McLaren: "#ff8000", Ferrari: "#e8002d", "Red Bull Racing": "#3671c6", Mercedes: "#27f4d2", "Aston Martin": "#229971",
  Alpine: "#ff87bc", Williams: "#64c4ff", "Racing Bulls": "#6692ff", RB: "#6692ff", "Kick Sauber": "#52e252",
  "Haas F1 Team": "#b6babd", AlphaTauri: "#5e8faa", "Alfa Romeo": "#c92d4b",
};
export const TYRE_COLOR: Record<string, string> = {
  S: "#ff3b3b", M: "#ffd12e", H: "#f2f2f2", I: "#43b02a", W: "#2f8fff", SOFT: "#ff3b3b", MEDIUM: "#ffd12e", HARD: "#f2f2f2",
};
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const fmt = (x: number | null | undefined, d = 2) => (x == null || !isFinite(x) ? "–" : Number(x).toFixed(d));
export const signed = (x: number | null | undefined, d = 2) =>
  x == null || !isFinite(x) ? "–" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d);

/* lap-time fraction -> distance fraction along the lap, from the circuit's fastest-lap telemetry */
export function timeToDistFn(tel?: { t: number[] }) {
  if (!tel?.t?.length) return (f: number) => ((f % 1) + 1) % 1;
  const T = tel.t[tel.t.length - 1] || 1, M = tel.t.length, tf = tel.t.map((v) => v / T);
  return (f: number) => {
    const x = isFinite(f) ? ((f % 1) + 1) % 1 : 0;
    let lo = 0, hi = M - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tf[m] < x) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), t0 = tf[i - 1], t1 = tf[i];
    return Math.min(0.99999, ((i - 1) + (t1 > t0 ? (x - t0) / (t1 - t0) : 0)) / (M - 1));
  };
}
