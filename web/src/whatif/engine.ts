/* What-if race simulator. Rebuilds a driver's race lap by lap under a changed strategy or changed race
 * conditions, using their real clean pace plus Pitwall's tyre physics and measured pit losses, and
 * re-ranks the field by elapsed time. Pure functions (runs in the browser and in Node tests).
 *
 * Model of a lap:  t' = clean_n + g_n * (tyre(c', a') - tyre(c, a)) + pitShare'(n)
 *   clean_n   the real lap time with any real pit-lane time removed (field-relative estimate)
 *   g_n       1 on green laps, 0.35 under SC/VSC (tyre wear matters less at SC pace)
 *   pitShare  a stop's loss split 45/55 over in-lap/out-lap; green loss, x0.5 under SC, x VSC ratio
 * Not modelled: traffic and overtaking difficulty (time gained is assumed to convert to positions). */
import { lapCostTable, pitLosses, solve, GREEN, SC, VSC } from "../core/pitwall-core.js";

export type WLap = { lap: number; time: number | null; tyre: string; age: number; status: string; pit: number; rep: number; t: number | null; pos: number | null };
export type WDriver = { driver: string; team: string; finish: string; laps: WLap[] };
export type WRace = { race_id: string; event: string; circuit: string; laps: number; drivers: WDriver[] };
export type Change =
  | { type: "pitLap"; stop: number; lap: number; compound?: string }   // stop 0 = the stop nearest `lap`
  | { type: "pitShift"; stop: number; delta: number }
  | { type: "compound"; stint: number; compound: string }
  | { type: "dropStop"; stop: number }
  | { type: "addStop"; lap: number; compound?: string }
  | { type: "optimal" }
  | { type: "noSC" }
  | { type: "addSC"; lap: number; laps: number }
  | { type: "trackTemp"; delta: number }
  | { type: "pitLoss"; delta: number };
export type Stint = { from: number; to: number; compound: string; startAge: number };
export type Result = {
  ok: boolean; error?: string; race: WRace; driver: string; team: string; applied: string[]; notes: string[];
  actual: { stints: Stint[]; cum: (number | null)[]; pos: (number | null)[]; finish: number | null; official: string; total: number | null };
  cf: { stints: Stint[]; cum: (number | null)[]; pos: (number | null)[]; finish: number | null; total: number | null };
  field: { driver: string; team: string; cum: (number | null)[] }[];   // everyone's (possibly re-simulated) clock, for the live run
  delta: number | null; deltaKind?: string; gapA?: number | null; gapC?: number | null; lastLap: number;
};

const CI: Record<string, number> = { S: 0, M: 1, H: 2, I: 1, W: 1, SOFT: 0, MEDIUM: 1, HARD: 2 };
const NAME = ["SOFT", "MEDIUM", "HARD"];
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function stintsOf(d: WDriver): Stint[] {
  const out: Stint[] = [];
  d.laps.forEach((l, i) => {
    const prevPit = i > 0 && d.laps[i - 1].pit;
    if (!out.length || prevPit) out.push({ from: l.lap, to: l.lap, compound: NAME[CI[l.tyre] ?? 1], startAge: Math.max(1, l.age) });
    else out[out.length - 1].to = l.lap;
  });
  return out;
}
const stopsOf = (st: Stint[]) => st.slice(0, -1).map((s) => s.to);

function context(model: any, race: WRace, tempDelta = 0) {
  const C = model.circuits[race.circuit];
  if (!C) throw new Error(`no physics for ${race.circuit}`);
  const temp = C.temp;
  const T0 = lapCostTable(model, race.circuit, temp, 130, null);
  const T1 = tempDelta ? lapCostTable(model, race.circuit, temp + tempDelta, 130, null) : T0;
  const PL = pitLosses(model, race.circuit);
  // field reference pace per lap (median of cars not stopping) and which laps are neutralised
  const N = race.laps;
  const fieldMed: number[] = [], status: string[] = [];
  for (let n = 1; n <= N; n++) {
    const ts: number[] = [], st: string[] = [];
    race.drivers.forEach((d) => {
      const i = d.laps.findIndex((l) => l.lap === n);
      if (i < 0) return;
      const l = d.laps[i], out = i > 0 && d.laps[i - 1].pit;
      st.push(l.status);
      if (l.time != null && !l.pit && !out) ts.push(l.time);
    });
    fieldMed[n] = median(ts);
    status[n] = st.filter((s) => s === "S").length > st.length / 2 ? "S" : st.filter((s) => s === "V").length > st.length / 2 ? "V" : "G";
  }
  // green field pace interpolated across neutralised laps
  const greenMed: number[] = [];
  const greens = Array.from({ length: N }, (_, k) => k + 1).filter((n) => status[n] === "G" && isFinite(fieldMed[n]) && n > 1);
  for (let n = 1; n <= N; n++) {
    if (status[n] === "G" && isFinite(fieldMed[n]) && n > 1) { greenMed[n] = fieldMed[n]; continue; }
    const a = [...greens].reverse().find((g) => g < n), b = greens.find((g) => g > n);
    greenMed[n] = a && b ? fieldMed[a] + ((fieldMed[b] - fieldMed[a]) * (n - a)) / (b - a) : fieldMed[a ?? b ?? n] ?? fieldMed[n];
  }
  return { C, T0, T1, PL, fieldMed, greenMed, status, N };
}

/* per-driver clean pace (real pit-lane time removed) */
function cleanOf(d: WDriver, ctx: ReturnType<typeof context>) {
  const offs = d.laps.filter((l) => l.rep && l.time != null && isFinite(ctx.fieldMed[l.lap])).map((l) => (l.time as number) - ctx.fieldMed[l.lap]);
  const off = isFinite(median(offs)) ? median(offs) : 0;
  return d.laps.map((l, i) => {
    const ref = (isFinite(ctx.fieldMed[l.lap]) ? ctx.fieldMed[l.lap] : ctx.greenMed[l.lap]) + off;
    const out = i > 0 && d.laps[i - 1].pit;
    if (l.time == null) return { clean: ref, off };
    if (l.pit || out) return { clean: Math.min(l.time, ref), off };
    return { clean: l.time, off };
  });
}

const cost = (T: Float64Array[], comp: string, age: number) => T[CI[comp] ?? 1][Math.min(Math.max(age, 0), T[0].length - 1)];

/* build a driver's clock under a stint plan and per-lap conditions */
function simulate(d: WDriver, plan: Stint[], ctx: ReturnType<typeof context>, opts: { noSC?: boolean; sc?: Set<number>; pitDelta?: number; temp?: boolean }) {
  const clean = cleanOf(d, ctx);
  const actual = stintsOf(d);
  const stopLaps = new Set(stopsOf(plan));
  const cfAt = (n: number) => { const s = plan.find((p) => n >= p.from && n <= p.to) || plan[plan.length - 1]; return { c: s.compound, a: s.startAge + (n - s.from) }; };
  const actAt = (n: number) => { const s = actual.find((p) => n >= p.from && n <= p.to) || actual[actual.length - 1]; return { c: s.compound, a: s.startAge + (n - s.from) }; };
  const stat = (n: number) => (opts.sc?.has(n) ? "S" : opts.noSC ? "G" : ctx.status[n]);
  const loss = (n: number) => { const s = stat(n); const L = ctx.PL[s === "S" ? SC : s === "V" ? VSC : GREEN] + (opts.pitDelta || 0); return Math.max(0, L); };
  const first = d.laps[0];
  const start = first?.t != null && first.time != null ? first.t - first.time : 0;
  let T = start;
  const cum: (number | null)[] = [];
  d.laps.forEach((l, i) => {
    const n = l.lap;
    let base = clean[i].clean;
    if (opts.noSC && ctx.status[n] !== "G") base = ctx.greenMed[n] + clean[i].off;
    else if (opts.sc?.has(n) && ctx.status[n] !== "S") base = ctx.greenMed[n] * 1.38;
    else if (ctx.status[n] === "S" && isFinite(ctx.fieldMed[n])) base = ctx.fieldMed[n];   // everyone at SC pace; the queue event closes gaps
    const g = stat(n) === "G" ? 1 : 0.35;
    const cf = cfAt(n), ac = actAt(n);
    const tyre = cost(opts.temp ? ctx.T1 : ctx.T0, cf.c, cf.a) - cost(ctx.T0, ac.c, ac.a);
    let pit = 0;
    if (stopLaps.has(n)) pit += 0.45 * loss(n);
    if (stopLaps.has(n - 1)) pit += 0.55 * loss(n - 1);
    T += base + g * tyre + pit;
    cum[n] = T;
  });
  return cum;
}

/* queue the field behind the safety car at the end of an added SC period. Cars keep their lap
   deficit: a lapped car joins the back of the queue still a lap (or more) down. */
function compress(clocks: Map<string, (number | null)[]>, lapEnd: number) {
  const cars = [...clocks.entries()].filter(([, c]) => c[lapEnd] != null);
  if (!cars.length) return;
  const lead = cars.reduce((a, b) => ((b[1][lapEnd] as number) < (a[1][lapEnd] as number) ? b : a))[1];
  const lapsDown = (c: (number | null)[]) => { let m = 0; while (lead[lapEnd + m + 1] != null && (lead[lapEnd + m + 1] as number) < (c[lapEnd] as number)) m++; return m; };
  const order = cars.map(([k, c]) => ({ k, c, m: lapsDown(c) }))
    .sort((a, b) => a.m - b.m || ((a.c[lapEnd] as number) - (lead[lapEnd + a.m] as number)) - ((b.c[lapEnd] as number) - (lead[lapEnd + b.m] as number)));
  order.forEach(({ c, m }, rank) => {
    const anchor = lead[lapEnd + m] as number;
    const shift = anchor + rank * 0.9 - (c[lapEnd] as number);
    if (shift > 0 && m > 0) return;          // never push a lapped car further back than it already is
    for (let n = lapEnd; n < c.length; n++) if (c[n] != null) c[n] = (c[n] as number) + Math.min(shift, 0);
  });
}

/* every car's clock in one world: lap-by-lap times, then the Safety Car queue at the end of each SC period */
function world(race: WRace, ctx: ReturnType<typeof context>, plans: Map<string, Stint[]>, opts: { noSC?: boolean; sc?: Set<number>; temp?: boolean; who?: string; pitDelta?: number }) {
  const clocks = new Map<string, (number | null)[]>();
  race.drivers.forEach((x) => clocks.set(x.driver, simulate(x, plans.get(x.driver) ?? stintsOf(x), ctx,
    { noSC: opts.noSC, sc: opts.sc, temp: opts.temp, pitDelta: x.driver === opts.who ? opts.pitDelta : 0 })));
  const isSC = (n: number) => (opts.sc?.has(n) || (!opts.noSC && ctx.status[n] === "S"));
  for (let n = 2; n <= ctx.N; n++) if (isSC(n) && !isSC(n + 1)) compress(clocks, n);
  return clocks;
}

function positions(clocks: Map<string, (number | null)[]>, who: string, N: number) {
  const pos: (number | null)[] = [];
  const me = clocks.get(who)!;
  for (let n = 1; n <= N; n++) {
    if (me[n] == null) { pos[n] = null; continue; }
    let ahead = 0;
    clocks.forEach((c, k) => { if (k !== who && c[n] != null && (c[n] as number) < (me[n] as number)) ahead++; });
    // cars that completed more laps by the time I finished this one count as ahead too
    pos[n] = ahead + 1;
  }
  return pos;
}

/* follow the optimiser's policy from `startLap` to the flag, reacting to the given track states */
function policyFrom(model: any, race: WRace, ctx: ReturnType<typeof context>, prefix: Stint[], startLap: number, comp: string,
                    tyreLife: number, two: boolean, lastLap: number, statusAt: (n: number) => string): Stint[] {
  const T = lapCostTable(model, race.circuit, ctx.C.temp, lastLap + 45, null);
  const { policy, id } = solve(T, ctx.PL, ctx.C.P, startLap, lastLap) as any;
  let c = CI[comp] ?? 1, a = Math.max(0, tyreLife - 1), f = two ? 1 : 0;
  const plan: Stint[] = prefix.map((s) => ({ ...s }));
  const cur = plan.length && plan[plan.length - 1].to >= startLap - 1 && plan[plan.length - 1].compound === comp ? plan.pop()! : null;
  plan.push({ from: cur ? cur.from : startLap, to: lastLap, compound: NAME[c], startAge: cur ? cur.startAge : Math.max(1, tyreLife) });
  for (let n = startLap; n < lastLap; n++) {
    const s = { G: GREEN, S: SC, V: VSC }[statusAt(n) as "G"] ?? GREEN;
    const act = policy[n].action[id(c, Math.min(a, T[0].length - 1), f, s)];
    if (act >= 0) {
      plan[plan.length - 1].to = n;
      f = f || act !== c ? 1 : 0; c = act; a = 0;
      plan.push({ from: n + 1, to: lastLap, compound: NAME[c], startAge: 1 });
    } else a += 1;
  }
  return plan;
}

export function runWhatIf(model: any, race: WRace, who: string, changes: Change[]): Result {
  const d = race.drivers.find((x) => x.driver === who);
  const empty = { stints: [], cum: [], pos: [], finish: null, total: null };
  if (!d || !d.laps.length) return { ok: false, error: `${who} has no laps in ${race.event}`, race, driver: who, team: "", applied: [], notes: [], actual: { ...empty, official: "" }, cf: empty, field: [], delta: null, lastLap: 0 };
  const tempDelta = changes.filter((c) => c.type === "trackTemp").reduce((a, c: any) => a + c.delta, 0);
  const ctx = context(model, race, tempDelta);
  const N = race.laps, lastLap = d.laps[d.laps.length - 1].lap;
  const applied: string[] = [], notes: string[] = [];
  const noSC = changes.some((c) => c.type === "noSC");
  const scAdd = changes.find((c) => c.type === "addSC") as any;
  const scSet = scAdd ? new Set(Array.from({ length: scAdd.laps }, (_, k) => scAdd.lap + k)) : undefined;
  const raceWide = noSC || !!scAdd || tempDelta !== 0;
  const statusAt = (n: number) => (scSet?.has(n) ? "S" : noSC ? "G" : ctx.status[n]);

  // ---- the target's strategy under the changes
  const actualSt = stintsOf(d);
  let plan: Stint[] = actualSt.map((s) => ({ ...s }));
  const setStops = (stops: number[], comps: string[]) => {
    const st = [...stops].filter((l) => l >= 2 && l < lastLap).sort((a, b) => a - b);
    const out: Stint[] = [];
    let from = d.laps[0].lap;
    st.forEach((l, k) => { out.push({ from, to: l, compound: comps[k] ?? plan[k]?.compound ?? "MEDIUM", startAge: k === 0 ? plan[0].startAge : 1 }); from = l + 1; });
    out.push({ from, to: lastLap, compound: comps[st.length] ?? plan[Math.min(st.length, plan.length - 1)].compound, startAge: st.length ? 1 : plan[0].startAge });
    plan = out;
  };
  const comps = () => plan.map((s) => s.compound);
  const idx = (stop: number) => (stop < 0 ? stopsOf(plan).length - 1 : stop - 1);
  for (const ch of changes) {
    const stops = stopsOf(plan);
    if (ch.type === "pitLap") {
      const near = stops.reduce((b, l, i) => (Math.abs(l - ch.lap) < Math.abs(stops[b] - ch.lap) ? i : b), 0);
      const k = ch.stop === 0 ? near : idx(ch.stop), c = comps(), tyre = ch.compound ? ` for ${ch.compound.toLowerCase()}s` : "";
      if (stops[k] != null) { stops[k] = ch.lap; if (ch.compound) c[k + 1] = ch.compound; setStops(stops, c); applied.push(`Stop ${k + 1} moved to lap ${ch.lap}${tyre}`); }
      else if (ch.stop === 0) { setStops([ch.lap], [c[0], ch.compound || (c[0] === "HARD" ? "MEDIUM" : "HARD")]); applied.push(`Stop on lap ${ch.lap}${tyre}`); }
      else notes.push(`${who} made no stop ${k + 1}`);
    }
    if (ch.type === "pitShift") { const k = idx(ch.stop); if (stops[k] != null) { stops[k] += ch.delta; setStops(stops, comps()); applied.push(`Stop ${k + 1} ${Math.abs(ch.delta)} lap${Math.abs(ch.delta) > 1 ? "s" : ""} ${ch.delta < 0 ? "earlier" : "later"} (lap ${stops[k]})`); } else notes.push(`${who} made no stop ${k + 1}`); }
    if (ch.type === "compound") { const k = ch.stint < 0 ? plan.length - 1 : ch.stint - 1; if (plan[k]) { plan[k].compound = ch.compound; applied.push(`Stint ${k + 1} on ${ch.compound.toLowerCase()}s`); } }
    if (ch.type === "dropStop") { const k = idx(ch.stop); if (stops[k] != null) { const c = comps(); stops.splice(k, 1); c.splice(k + 1, 1); setStops(stops, c); applied.push(`Skipped stop ${k + 1}`); } }
    if (ch.type === "addStop") {
      let lap = ch.lap;
      if (!lap) { const longest = plan.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a)); lap = Math.round((longest.from + longest.to) / 2); }
      const c = comps(); const pos = stops.filter((l) => l < lap).length; stops.push(lap); c.splice(pos + 1, 0, ch.compound || (c[pos] === "HARD" ? "MEDIUM" : "HARD")); setStops(stops, c); applied.push(`Extra stop on lap ${lap}`);
    }
    if (ch.type === "optimal") { plan = policyFrom(model, race, ctx, [], 2, stintsOf(d)[0].compound, d.laps[0].age + 1, false, lastLap, statusAt); applied.push(`Pitwall's optimiser strategy: ${stopsOf(plan).map((l, k) => `L${l} ${plan[k + 1].compound[0]}`).join(", ") || "no stop"}`); }
    if (ch.type === "noSC") applied.push("No Safety Cars or VSCs");
    if (ch.type === "addSC") applied.push(`Safety Car laps ${ch.lap}-${ch.lap + ch.laps - 1}`);
    if (ch.type === "trackTemp") applied.push(`Track ${ch.delta > 0 ? "+" : ""}${ch.delta}°C`);
    if (ch.type === "pitLoss") applied.push(`${who}'s stops ${Math.abs(ch.delta)} s ${ch.delta < 0 ? "faster" : "slower"}`);
  }
  // an added SC with no strategy instruction: let the optimiser make the call under it
  if (scAdd && !changes.some((c) => ["pitLap", "pitShift", "dropStop", "addStop", "optimal"].includes(c.type))) {
    // no strategy instruction: the optimiser runs the pit wall from the moment the Safety Car comes out
    const n = scAdd.lap, cur = plan.find((s) => n >= s.from && n <= s.to) || plan[plan.length - 1];
    const before = plan.filter((s) => s.from < n).map((s) => ({ ...s, to: Math.min(s.to, n - 1) }));
    const two = new Set(before.map((s) => s.compound)).size >= 2;
    const life = cur.startAge + (n - cur.from);
    const next = policyFrom(model, race, ctx, before, n, cur.compound, life, two, lastLap, statusAt);
    const newStops = stopsOf(next).filter((l) => l >= n);
    notes.push(newStops.length ? `Pitwall's call from the Safety Car on: ${newStops.map((l) => `box lap ${l} for ${next.find((s) => s.from === l + 1)!.compound.toLowerCase()}s`).join(", then ")}.`
      : "Pitwall's call under that Safety Car: stay out to the flag.");
    plan = next;
  }
  if (!applied.length && !notes.length) return { ok: false, error: "no change understood", race, driver: who, team: d.team, applied, notes, actual: { ...empty, official: d.finish }, cf: empty, field: [], delta: null, lastLap };

  // ---- clocks. Difference-in-differences: each car's what-if clock is its REAL clock plus the modelled
  // change (what-if world minus baseline world), so model error cancels out lap by lap. Both worlds
  // treat Safety Cars as queue events, so real and hypothetical neutralisations are handled the same way.
  const pitDelta = changes.filter((c) => c.type === "pitLoss").reduce((a, c: any) => a + c.delta, 0);
  const base = world(race, ctx, new Map(), {});
  const changed = world(race, ctx, new Map([[who, plan]]), { noSC, sc: scSet, temp: tempDelta !== 0, who, pitDelta });
  const actualClock = new Map<string, (number | null)[]>(), cfClock = new Map<string, (number | null)[]>();
  race.drivers.forEach((x) => {
    const real: (number | null)[] = [];
    x.laps.forEach((l) => (real[l.lap] = l.t));
    actualClock.set(x.driver, real);
    const b = base.get(x.driver)!, c = changed.get(x.driver)!;
    cfClock.set(x.driver, real.map((v, n) => (v == null || b[n] == null || c[n] == null ? null : v + ((c[n] as number) - (b[n] as number)))));
  });
  const posA = positions(actualClock, who, N), posC = positions(cfClock, who, N);
  const fin = (p: (number | null)[]) => p[lastLap] ?? null;
  const totA = actualClock.get(who)![lastLap] ?? null, totC = cfClock.get(who)![lastLap] ?? null;
  const leaderAt = (m: Map<string, (number | null)[]>) => Math.min(...[...m.values()].map((c) => c[lastLap]).filter((v): v is number => v != null));
  const gapA = totA != null ? totA - leaderAt(actualClock) : null, gapC = totC != null ? totC - leaderAt(cfClock) : null;
  if (raceWide && totA != null && totC != null) notes.unshift(`The race itself changes, so everyone's time moves: ${who}'s race is ${Math.abs(totC - totA).toFixed(1)} s ${totC < totA ? "shorter" : "longer"}; the headline compares the gap to the leader.`);
  if (lastLap < N) notes.push(`${who} did not finish (retired after lap ${lastLap}); compared up to that lap.`);
  notes.push("Positions assume time gained converts on track; traffic and overtaking difficulty are not modelled.");
  return {
    ok: true, race, driver: who, team: d.team, applied, notes,
    actual: { stints: actualSt, cum: actualClock.get(who)!, pos: posA, finish: fin(posA), official: d.finish, total: totA },
    cf: { stints: plan, cum: cfClock.get(who)!, pos: posC, finish: fin(posC), total: totC },
    field: race.drivers.map((x) => ({ driver: x.driver, team: x.team, cum: (raceWide ? cfClock : actualClock).get(x.driver)! })),
    delta: raceWide ? (gapA != null && gapC != null ? gapC - gapA : null) : totA != null && totC != null ? totC - totA : null,
    deltaKind: raceWide ? "gap to leader" : "race time", gapA, gapC, lastLap,
  };
}
