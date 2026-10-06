/* Plain-English what-if questions -> a structured scenario. Deterministic and transparent: the UI
 * shows exactly what was understood, and anything it could not place is reported, never guessed. */
import type { Change, WRace } from "./engine";

const DRIVERS: Record<string, string> = {
  verstappen: "VER", max: "VER", norris: "NOR", lando: "NOR", piastri: "PIA", oscar: "PIA", leclerc: "LEC", charles: "LEC",
  hamilton: "HAM", lewis: "HAM", russell: "RUS", george: "RUS", antonelli: "ANT", kimi: "ANT", sainz: "SAI", carlos: "SAI",
  albon: "ALB", alex: "ALB", alonso: "ALO", fernando: "ALO", stroll: "STR", lance: "STR", gasly: "GAS", pierre: "GAS",
  colapinto: "COL", franco: "COL", doohan: "DOO", ocon: "OCO", esteban: "OCO", bearman: "BEA", ollie: "BEA", oliver: "BEA",
  hulkenberg: "HUL", "hülkenberg": "HUL", nico: "HUL", bortoleto: "BOR", gabriel: "BOR", tsunoda: "TSU", yuki: "TSU",
  lawson: "LAW", liam: "LAW", hadjar: "HAD", isack: "HAD",
};
const RACE_ALIASES: Record<string, string[]> = {
  australian: ["australia", "melbourne", "albert park"], chinese: ["china", "shanghai"], japanese: ["japan", "suzuka"],
  bahrain: ["sakhir"], "saudi arabian": ["saudi", "jeddah"], miami: ["miami"], "emilia romagna": ["imola", "emilia"],
  monaco: ["monte carlo"], spanish: ["spain", "barcelona", "catalunya"], canadian: ["canada", "montreal", "montréal"],
  austrian: ["austria", "spielberg", "red bull ring"], british: ["britain", "silverstone", "uk"], belgian: ["belgium", "spa"],
  hungarian: ["hungary", "hungaroring", "budapest"], dutch: ["netherlands", "zandvoort", "holland"], italian: ["italy", "monza"],
  azerbaijan: ["baku"], singapore: ["marina bay"], "united states": ["austin", "cota", "usa", "us gp", "texas"],
  "mexico city": ["mexico"], "são paulo": ["brazil", "interlagos", "sao paulo"], "las vegas": ["vegas"], qatar: ["lusail"],
  "abu dhabi": ["yas marina", "yas island", "abu dhabi"],
};
const COMP: Record<string, string> = { soft: "SOFT", softs: "SOFT", medium: "MEDIUM", mediums: "MEDIUM", hard: "HARD", hards: "HARD" };
const ORD: Record<string, number> = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, last: -1, final: -1 };
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const n = (s: string) => (NUM[s] ?? Number(s));

export type Parsed = { raceIdx: number | null; driver: string | null; changes: Change[]; understood: string[]; missing: string[] };

export function parse(text: string, races: WRace[]): Parsed {
  const q = " " + text.toLowerCase().replace(/[’']s\b/g, "").replace(/[’']/g, "'").replace(/[?!.,]/g, " ") + " ";
  const understood: string[] = [], missing: string[] = [];
  // race
  let raceIdx: number | null = null;
  races.forEach((r, i) => {
    if (raceIdx != null) return;
    const ev = r.event.toLowerCase().replace(" grand prix", "");
    const keys = [ev, r.circuit.toLowerCase(), ...(RACE_ALIASES[ev] || [])];
    if (keys.some((k) => k && q.includes(" " + k))) raceIdx = i;
  });
  // driver (code or name), checked against that race's entry list
  let driver: string | null = null;
  const codes = new Set((raceIdx != null ? races[raceIdx].drivers : races.flatMap((r) => r.drivers)).map((d) => d.driver));
  for (const w of q.split(/\s+/)) {
    const up = w.toUpperCase();
    if (w.length === 3 && codes.has(up) && !["the", "had", "lap", "for", "was", "sco"].includes(w)) { driver = up; break; }
    if (DRIVERS[w]) { driver = DRIVERS[w]; break; }
  }
  let excluded: string | null = null;
  if (raceIdx == null) {
    // a 2025 race we know but do not model (wet races are excluded from the dry-race set)
    for (const [ev, al] of Object.entries(RACE_ALIASES)) {
      if ([ev, ...al].some((k) => q.includes(" " + k))) { excluded = ev; break; }
    }
  }
  if (raceIdx != null) understood.push(`Race: ${races[raceIdx].event}`);
  else if (excluded) missing.push(`the ${excluded.replace(/\b\w/g, (c) => c.toUpperCase())} GP is not in the 2025 dry-race set (wet races are excluded)`);
  else missing.push("race");
  if (driver) understood.push(`Driver: ${driver}`);

  const changes: Change[] = [];
  const stopIdx = (m: string | undefined) => (m ? ORD[m] ?? 1 : 1);
  let m: RegExpMatchArray | null;
  const rx = (r: RegExp) => q.match(r);
  // "pitted 3 laps earlier / later", "second stop 2 laps later"
  if ((m = rx(/(?:(first|second|third|last|1st|2nd|3rd|final) stop[^0-9a-z]*)?(?:pit(?:ted|s|ting)?|boxed|stopped)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten) laps? (earlier|later|sooner|before|after)/))) {
    const k = stopIdx(m[1] || (q.match(/(first|second|third|last|1st|2nd|3rd|final) stop/)?.[1]));
    const d = n(m[2]) * (/(earlier|sooner|before)/.test(m[3]) ? -1 : 1);
    changes.push({ type: "pitShift", stop: k, delta: d });
  } else if ((m = rx(/(?:went|go|gone|going|switch(?:ed)?|chang(?:ed|e)|mov(?:ed|e)|pit(?:ted)?|box(?:ed)?)(?: on)?(?: ?to| for| onto)? (?:the )?(softs?|mediums?|hards?) (?:on|at|in) lap (\d+)/))
    || (m = rx(/(softs?|mediums?|hards?) (?:on|at|from) lap (\d+)/))) {
    // "went onto hards on lap 20": move the named (else the nearest) stop there and fit that compound
    const o = q.match(/(first|second|third|last|1st|2nd|3rd|final) stop/)?.[1];
    changes.push({ type: "pitLap", stop: o ? stopIdx(o) : 0, lap: +m[2], compound: COMP[m[1]] });
  } else if ((m = rx(/(?:pit(?:ted|s|ting)?|box(?:ed)?|stop(?:ped)?)(?: stop)?(?: on| at| in)? lap (\d+)/))) {
    const k = stopIdx(q.match(/(first|second|third|last|1st|2nd|3rd|final) stop/)?.[1]);
    if (/extra|another|additional|again/.test(q)) changes.push({ type: "addStop", lap: +m[1], compound: COMP[(q.match(/(softs?|mediums?|hards?)/) || [])[1]] });
    else changes.push({ type: "pitLap", stop: k, lap: +m[1] });
  }
  if ((m = rx(/(?:start(?:ed|s)?|begin|began) on (?:the )?(softs?|mediums?|hards?)/))) changes.push({ type: "compound", stint: 1, compound: COMP[m[1]] });
  if ((m = rx(/(softs?|mediums?|hards?) (?:in|for|on) the (first|second|third|last|final) stint/)) || (m = rx(/(first|second|third|last|final) stint on (softs?|mediums?|hards?)/))) {
    const [c, o] = COMP[m[1]] ? [m[1], m[2]] : [m[2], m[1]];
    changes.push({ type: "compound", stint: ORD[o] ?? 1, compound: COMP[c] });
  } else if ((m = rx(/(?:pitted for|fitted|switched to|gone to|put on) (softs?|mediums?|hards?)/)) && !changes.some((c) => c.type === "addStop" || (c.type === "pitLap" && c.compound))) {
    changes.push({ type: "compound", stint: 2, compound: COMP[m[1]] });
  }
  if (rx(/(one|1)[- ]stop(?:ped)?/) && !rx(/(two|2)[- ]stop/)) changes.push({ type: "dropStop", stop: -1 });
  if (rx(/(two|2)[- ]stop(?:ped)?/) && !rx(/(one|1)[- ]stop/)) { const lap = Number(q.match(/lap (\d+)/)?.[1]) || 0; changes.push({ type: "addStop", lap: lap || 0 }); }
  if (rx(/(?:skip(?:ped)?|no|didn't make|did not make|without)(?: (?:the|his|her|their))? (?:(first|second|third|last|1st|2nd|3rd|final) )?(?:pit ?)?stop/) && !rx(/no (safety car|sc|vsc)/)) {
    const k = stopIdx(q.match(/(?:skip(?:ped)?|no|without)(?: (?:the|his|her|their))? (first|second|third|last|1st|2nd|3rd|final)/)?.[1] || "last");
    if (!changes.some((c) => c.type === "dropStop")) changes.push({ type: "dropStop", stop: k });
  }
  if (rx(/stay(?:ed)? out/) && !changes.length) changes.push({ type: "dropStop", stop: -1 });
  if (rx(/pitwall|optimi[sz]er|optimal|the model'?s? strategy|best strategy|ideal strategy/)) changes.push({ type: "optimal" });
  if (rx(/no (?:safety cars?|sc|vsc|virtual safety cars?|neutrali[sz]ations?)|without (?:the |a |any )?(?:safety cars?|sc|vsc)/)) changes.push({ type: "noSC" });
  else if ((m = rx(/(?:safety car|sc)(?: came out| was deployed| deployed| appeared)?(?: on| at| in)? lap (\d+)/) || rx(/lap (\d+) (?:safety car|sc)/))) {
    const k = Number(q.match(/for (\d+) laps/)?.[1]) || 4;
    changes.push({ type: "addSC", lap: +m[1], laps: k });
  }
  if ((m = rx(/(\d+)\s*(?:°|degrees?|deg)?\s*c?\s*(hotter|warmer|colder|cooler)/))) changes.push({ type: "trackTemp", delta: +m[1] * (/(hotter|warmer)/.test(m[2]) ? 1 : -1) });
  if ((m = rx(/(?:stops?|pit ?stops?|crew)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?) (faster|quicker|slower)/))) changes.push({ type: "pitLoss", delta: +m[1] * (/(faster|quicker)/.test(m[2]) ? -1 : 1) });
  if (!changes.length) missing.push("change");
  return { raceIdx, driver, changes, understood, missing };
}

export function describe(c: Change): string {
  switch (c.type) {
    case "pitLap": return `${c.stop === 0 ? "Nearest stop" : `Stop ${c.stop < 0 ? "last" : c.stop}`} on lap ${c.lap}${c.compound ? ` for ${c.compound.toLowerCase()}s` : ""}`;
    case "pitShift": return `Stop ${c.stop < 0 ? "last" : c.stop} ${Math.abs(c.delta)} lap${Math.abs(c.delta) > 1 ? "s" : ""} ${c.delta < 0 ? "earlier" : "later"}`;
    case "compound": return `Stint ${c.stint < 0 ? "last" : c.stint} on ${c.compound.toLowerCase()}s`;
    case "dropStop": return `Skip ${c.stop < 0 ? "last" : `stop ${c.stop}`}`;
    case "addStop": return `Extra stop${c.lap ? ` on lap ${c.lap}` : ""}${c.compound ? ` for ${c.compound.toLowerCase()}s` : ""}`;
    case "optimal": return "Follow Pitwall's strategy";
    case "noSC": return "No Safety Cars";
    case "addSC": return `Safety Car laps ${c.lap}-${c.lap + c.laps - 1}`;
    case "trackTemp": return `Track ${c.delta > 0 ? "+" : ""}${c.delta}°C`;
    case "pitLoss": return `Stops ${Math.abs(c.delta)} s ${c.delta < 0 ? "faster" : "slower"}`;
  }
}
