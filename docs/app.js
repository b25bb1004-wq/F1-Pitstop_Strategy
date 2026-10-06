/* Pitwall dashboard. Data from `python -m pitwall.export_web`; optimiser in pitwall-core.js. */
(async function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (x, d = 2) => (x == null || !isFinite(x) ? "–" : Number(x).toFixed(d));
  const signed = (x, d = 2) => (x == null || !isFinite(x) ? "–" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const TYRE = { S: "--soft", M: "--medium", H: "--hard", I: "--inter", W: "--wet", SOFT: "--soft", MEDIUM: "--medium", HARD: "--hard" };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const charts = {};

  const [model, races, metrics] = await Promise.all(
    ["data/model.json", "data/races.json", "data/metrics.json"].map((u) => fetch(u).then((r) => r.json())));
  const T = metrics.inrace.test, D = metrics.decisions.test;

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  function themeIcon() {
    $("#theme").innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${isDark() ? "sun" : "moon"}"/></svg>`;
    $("#theme").setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  }
  try { const t = localStorage.getItem("pitwall-theme"); if (t) root.dataset.theme = t; } catch (e) {}
  themeIcon();
  $("#theme").onclick = () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("pitwall-theme", root.dataset.theme); } catch (e) {}
    themeIcon(); redraw();
  };

  /* ---------- tabs (WAI-ARIA tab pattern) ---------- */
  const tabs = $$('[role="tab"]');
  function show(id, focus) {
    tabs.forEach((t) => {
      const on = t.getAttribute("aria-controls") === id;
      t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
      $("#" + t.getAttribute("aria-controls")).classList.toggle("on", on);
    });
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    redraw();
  }
  tabs.forEach((t, i) => {
    t.onclick = () => show(t.getAttribute("aria-controls"));
    t.onkeydown = (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); show(tabs[(i + d + tabs.length) % tabs.length].getAttribute("aria-controls"), true); }
    };
  });
  const active = () => tabs.find((t) => t.getAttribute("aria-selected") === "true").getAttribute("aria-controls");

  /* ---------- charts ---------- */
  Chart.defaults.font.family = "'Fira Code', ui-monospace, monospace";
  Chart.defaults.font.size = 11;
  Chart.register({
    id: "markers",
    beforeDatasetsDraw(chart, _a, o) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      if (!o || !x) return;
      ctx.save();
      (o.spans || []).forEach((s) => {
        const x0 = Math.max(x.getPixelForValue(s.from - 0.5), a.left), x1 = Math.min(x.getPixelForValue(s.to + 0.5), a.right);
        ctx.fillStyle = s.color; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      });
      (o.lines || []).forEach((l) => {
        const px = x.getPixelForValue(l.x);
        ctx.strokeStyle = l.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
        if (l.label) { ctx.setLineDash([]); ctx.fillStyle = l.color; ctx.font = "600 10px 'Fira Code'"; ctx.fillText(l.label, px + 4, a.top + 10); }
      });
      ctx.restore();
    },
  });
  function draw(id, config) {
    Chart.defaults.color = css("--text-2");
    Chart.defaults.borderColor = css("--line");
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }
  const opts = (extra) => Object.assign({
    responsive: true, maintainAspectRatio: false, animation: reduced ? false : { duration: 200 },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: css("--raised"), titleColor: css("--text"), bodyColor: css("--text"),
      borderColor: css("--line-strong"), borderWidth: 1, padding: 10, cornerRadius: 6, titleFont: { weight: "600" } } },
  }, extra);
  const linearX = (N, title = "lap") => ({ type: "linear", min: 1, max: N, title: { display: true, text: title }, grid: { color: css("--line") }, ticks: { stepSize: 10 } });

  /* ---------- strategy strip (pixel-accurate SVG) ---------- */
  function strip(svg, { N, now, stints, stops, calls, stopColor }) {
    const W = svg.clientWidth || 800, H = 76, pad = 14;
    const px = (lap) => pad + (lap / N) * (W - 2 * pad);
    const ink = css("--tyre-ink"), line = css("--line-strong"), text3 = css("--text-3");
    let s = "";
    for (let l = 10; l < N; l += 10) s += `<line x1="${px(l)}" x2="${px(l)}" y1="50" y2="54" stroke="${line}"/><text x="${px(l)}" y="66" fill="${text3}" font-size="10" text-anchor="middle">${l}</text>`;
    s += `<text x="${px(0)}" y="66" fill="${text3}" font-size="10">1</text><text x="${px(N)}" y="66" fill="${text3}" font-size="10" text-anchor="end">${N}</text>`;
    if (now) s += `<rect x="${px(0)}" y="20" width="${Math.max(px(now - 1) - px(0) - 2, 0)}" height="26" rx="4" fill="${line}"/>`;
    stints.forEach((t) => {
      const x0 = px(t.from - 1), x1 = px(t.to), w = Math.max(x1 - x0 - 2, 2), col = css(TYRE[t.c] || "--line-strong");
      s += `<rect x="${x0}" y="20" width="${w}" height="26" rx="4" fill="${col}" stroke="${line}" stroke-width=".5"/>`;
      if (w > 46) {
        s += `<circle cx="${x0 + 13}" cy="33" r="8" fill="${css("--surface")}" stroke="${ink}" stroke-opacity=".25"/>`;
        s += `<text x="${x0 + 13}" y="36.5" font-size="10" font-weight="700" fill="${css("--text")}" text-anchor="middle">${t.c[0]}</text>`;
        if (w > 80) s += `<text x="${x0 + 27}" y="37" font-size="11" font-weight="600" fill="${ink}">${t.to - t.from + 1} laps</text>`;
      }
    });
    (calls || []).forEach((l) => (s += `<rect x="${px(l - 0.5) - 1}" y="47" width="2" height="5" fill="${css("--red")}"/>`));
    if (now) s += `<line x1="${px(now - 1) - 1}" x2="${px(now - 1) - 1}" y1="14" y2="50" stroke="${css("--text")}" stroke-width="2"/><text x="${px(now - 1) - 4}" y="11" font-size="10" font-weight="600" fill="${css("--text")}" text-anchor="end">NOW</text>`;
    (stops || []).forEach((p) => {
      const x = px(p.lap) - 1, c = stopColor || css("--red-text");
      s += `<line x1="${x}" x2="${x}" y1="14" y2="50" stroke="${c}" stroke-width="2"/><text x="${Math.min(x + 4, W - 30)}" y="11" font-size="10" font-weight="600" fill="${c}">L${p.lap}</text>`;
    });
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = s;
  }

  /* ---------- scorecard ---------- */
  $("#scorecard").innerHTML = [
    [fmt(T.structural.all, 3) + " s", "lap-time error, in race", `last-lap baseline ${fmt(T.last_lap.all, 2)} s`, true],
    [fmt(T.structural["h1-5"], 3) + " s", "forecasting 1-5 laps ahead", `${T.n_predictions.toLocaleString()} predictions`],
    [fmt(metrics.race_time.test.mape_pct, 2) + "%", "remaining-race time error", `naive ${fmt(metrics.race_time.test.naive_mape_pct, 2)}%`],
    [fmt(metrics.pit_loss.test.mae_circuit_model, 2) + " s", "pit-loss error per stop", `${metrics.pit_loss.test.stops} green stops`],
    [fmt(D.pit_call_model.roc_auc, 3), "pit-call ROC-AUC vs teams", `${D.real_stops} real stops`],
  ].map(([v, k, h, best]) => `<div class="metric"><div class="v num${best ? " best" : ""}">${v}</div><div class="k">${k}</div><div class="h">${h}</div></div>`).join("");

  /* ---------- STRATEGY ---------- */
  const circuits = Object.keys(model.circuits).sort();
  const option = (v, t) => `<option value="${esc(v)}">${esc(t || v)}</option>`;
  $("#s-circuit").innerHTML = circuits.map((c) => option(c)).join("");
  $("#t-circuit").innerHTML = circuits.map((c) => option(c)).join("");
  const st = { circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "green", trackTemp: 30, twoCompounds: false };
  const fill = (el) => el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");

  $$("#s-compound button").forEach((b) => (b.onclick = () => { st.compound = b.dataset.v; sync(); decideNow(); }));
  $$("#s-status button").forEach((b) => (b.onclick = () => { st.status = b.dataset.v; sync(); decideNow(); }));
  [["s-lap", "lap"], ["s-laps", "raceLaps"], ["s-age", "tyreAge"], ["s-temp", "trackTemp"]].forEach(([id, k]) => {
    $("#" + id).oninput = (e) => { st[k] = +e.target.value; sync(); decideNow(); };
  });
  $("#s-two").onchange = (e) => { st.twoCompounds = e.target.checked; decideNow(); };
  $("#s-circuit").onchange = (e) => {
    const C = model.circuits[e.target.value];
    Object.assign(st, { circuit: e.target.value, raceLaps: C.laps, trackTemp: Math.round(C.temp) });
    sync(); decideNow();
  };
  function sync() {
    $("#s-circuit").value = st.circuit;
    st.lap = Math.min(st.lap, st.raceLaps - 1);
    const set = (id, v, out) => { const el = $("#" + id); el.value = v; fill(el); $("#" + out[0]).textContent = out[1]; };
    $("#s-lap").max = st.raceLaps - 1;
    set("s-lap", st.lap, ["o-lap", `${st.lap} / ${st.raceLaps}`]);
    set("s-laps", st.raceLaps, ["o-laps", `${st.raceLaps} laps`]);
    set("s-age", st.tyreAge, ["o-age", `${st.tyreAge}`]);
    set("s-temp", st.trackTemp, ["o-temp", `${st.trackTemp}°C`]);
    $("#s-two").checked = st.twoCompounds;
    $$("#s-compound button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === st.compound));
    $$("#s-status button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === st.status));
  }
  const presets = [
    ["Bahrain, softs, green flag", { circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "green", trackTemp: 30, twoCompounds: false }],
    ["Bahrain, same lap, Safety Car", { circuit: "Sakhir", lap: 15, raceLaps: 57, compound: "SOFT", tyreAge: 14, status: "sc", trackTemp: 30, twoCompounds: false }],
    ["Monaco, one-stop window", { circuit: "Monaco", lap: 30, raceLaps: 78, compound: "MEDIUM", tyreAge: 29, status: "green", trackTemp: 45, twoCompounds: false }],
    ["Monza, VSC on worn mediums", { circuit: "Monza", lap: 22, raceLaps: 53, compound: "MEDIUM", tyreAge: 21, status: "vsc", trackTemp: 42, twoCompounds: false }],
    ["Silverstone, run to the flag", { circuit: "Silverstone", lap: 38, raceLaps: 52, compound: "HARD", tyreAge: 15, status: "green", trackTemp: 40, twoCompounds: true }],
  ];
  $("#presets").innerHTML = presets.map(([t], i) => `<button data-i="${i}">${t}<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></button>`).join("");
  $$("#presets button").forEach((b) => (b.onclick = () => { Object.assign(st, presets[+b.dataset.i][1]); sync(); decideNow(); }));

  let frame = 0;
  function decideNow() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = PitwallCore.decide(model, Object.assign({}, st), { bootstrap: true });
      const box = r.pitNow;
      $("#decision").classList.toggle("box", box);
      $("#d-word").innerHTML = box ? `Box this lap <span class="tyre ${r.fit[0]}" style="width:30px;height:30px;font-size:13px;border-width:4px" aria-label="${r.fit}">${r.fit[0]}</span>` : "Stay out";
      const next = r.plan.stops[0];
      $("#d-why").textContent = box
        ? `Fit ${r.fit.toLowerCase()}s now. Every alternative that stays out is slower in expectation.`
        : next ? `Planned stop on lap ${next.lap} for ${next.fit.toLowerCase()}s. Boxing now would cost ${fmt(-r.gain, 2)} s.` : "No further stop needed to the flag.";
      $("#d-gain").textContent = signed(Math.abs(r.gain)) + " s";
      const agree = box ? r.pPit : 1 - r.pPit;
      $("#d-conf").textContent = Math.round(agree * 100) + "%";
      $("#d-bar").style.width = Math.round(agree * 100) + "%";
      const regime = { green: 0, sc: 1, vsc: 2 }[st.status];
      $("#d-loss").textContent = fmt(r.pitLoss[regime], 1) + " s";
      $("#d-loss-k").textContent = { green: "pit loss, green flag", sc: "pit loss under SC (effective)", vsc: "pit loss under VSC" }[st.status];
      const stints = r.plan.stints.map((t) => ({ from: t.from, to: t.to, c: t.compound }));
      strip($("#plan"), { N: st.raceLaps, now: st.lap, stints, stops: r.plan.stops });
      $("#plan-meta").textContent = (r.plan.stops.map((p) => `L${p.lap} → ${p.fit[0]}`).join("  ·  ") || "no more stops") + `  ·  tyre cost ${fmt(r.plan.tyreCost, 1)} s`;
      windowChart(r);
    });
  }
  function windowChart(r) {
    const w = r.window, best = w.reduce((m, x) => (x.delta < m.delta ? x : m), w[0]);
    const col = w.map((x) => (x === best ? css("--purple") : x.delta <= 0.5 ? css("--green-fill") : x.delta <= 2 ? css("--yellow-fill") : css("--line-strong")));
    draw("c-window", { type: "bar",
      data: { labels: w.map((x) => "L" + x.lap), datasets: [{ data: w.map((x) => x.delta), backgroundColor: col, borderRadius: 3, minBarLength: 3,
        borderColor: w.map((_, i) => (i === 0 ? css("--text") : "transparent")), borderWidth: w.map((_, i) => (i === 0 ? 1.5 : 0)) }] },
      options: opts({ scales: { y: { beginAtZero: true, title: { display: true, text: "s lost vs best" }, grid: { color: css("--line") } }, x: { grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `Stop at end of ${c[0].label}`, label: (c) => `+${fmt(c.raw, 2)} s vs optimal` } } } }) });
    const near = w.filter((x) => x.delta <= 0.5).map((x) => x.lap);
    $("#window-summary").innerHTML = `Optimal lap to stop: <span class="p">L${best.lap}</span> · within 0.5 s: <b>L${Math.min(...near)}-L${Math.max(...near)}</b> · stopping this lap costs <b>+${fmt(w[0].delta, 2)} s</b>`;
  }

  /* ---------- REPLAY ---------- */
  $("#r-race").innerHTML = races.races.map((r, i) => option(i, `R${r.race_id.slice(5)} · ${r.event}`)).join("");
  const pos = (d) => (d.finish && /^\d+$/.test(d.finish) ? "P" + d.finish : d.finish || "DNF");
  function setRace(i) {
    $("#r-driver").innerHTML = races.races[i].drivers.map((d, j) => option(j, `${pos(d)} · ${d.driver} · ${d.team}`)).join("");
    replay();
  }
  $("#r-race").onchange = (e) => setRace(+e.target.value);
  $("#r-driver").onchange = replay;
  function replay() {
    if (active() !== "replay") return;
    const race = races.races[+$("#r-race").value], drv = race.drivers[+$("#r-driver").value];
    const L = drv.laps.map((a) => ({ lap: a[0], time: a[1], pred: a[2], tyre: a[3], age: a[4], status: a[5], pit: a[6], rep: a[7], gain: a[8], p: a[9], call: a[10] }));
    const stints = [];
    L.forEach((l, i) => {
      if (!stints.length || L[i - 1].pit) stints.push({ from: l.lap, to: l.lap, c: l.tyre });
      else stints[stints.length - 1].to = l.lap;
    });
    const stops = L.filter((l) => l.pit).map((l) => ({ lap: l.lap }));
    strip($("#r-strip"), { N: race.laps, stints, stops, calls: L.filter((l) => l.call === 1).map((l) => l.lap), stopColor: css("--green") });
    const clean = L.filter((l) => l.rep && l.time && l.pred);
    const mae = clean.reduce((s, l) => s + Math.abs(l.time - l.pred), 0) / Math.max(clean.length, 1);
    const offsets = [];
    let seg = [];
    L.forEach((l) => { seg.push(l); if (l.pit) { const c = seg.find((x) => x.call === 1); offsets.push(c ? c.lap - l.lap : null); seg = []; } });
    $("#r-facts").innerHTML = [
      ["Finish", pos(drv)], ["Team stops", stops.map((s) => "L" + s.lap).join(", ") || "none"],
      ["Prediction MAE", fmt(mae, 3) + " s"], ["Clean laps scored", clean.length],
      ["First model call vs stop", offsets.map((d) => (d == null ? "missed" : d === 0 ? "same lap" : (d > 0 ? "+" : "") + d)).join(", ") || "–"],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

    const spans = L.filter((l) => l.status === "S" || l.status === "V").map((l) => ({ from: l.lap, to: l.lap, color: css(l.status === "S" ? "--sc-band" : "--vsc-band") }));
    const lines = stops.map((s) => ({ x: s.lap + 0.5, color: css("--green"), label: "BOX" }));
    const valid = L.filter((l) => l.time);
    const reps = valid.filter((l) => l.rep).map((l) => l.time).sort((a, b) => a - b);
    const med = reps[Math.floor(reps.length / 2)] || 90;
    draw("c-laps", { type: "scatter",
      data: { datasets: [
        { label: "Actual", data: valid.map((l) => ({ x: l.lap, y: l.time })), pointRadius: valid.map((l) => (l.rep ? 3.5 : 2.5)),
          pointBackgroundColor: valid.map((l) => (l.rep ? css(TYRE[l.tyre] || "--text-3") : "transparent")),
          pointBorderColor: valid.map((l) => (l.rep ? css("--tyre-ink") : css("--text-3"))), pointBorderWidth: valid.map((l) => (l.rep ? 0.5 : 1)) },
        { label: "Predicted", type: "line", data: L.filter((l) => l.pred).map((l) => ({ x: l.lap, y: l.pred })), borderColor: css("--blue"), borderWidth: 2, pointRadius: 0, tension: 0.25 },
      ] },
      options: opts({ scales: { x: linearX(race.laps), y: { min: Math.floor(med - 3), max: Math.ceil(med + 6), title: { display: true, text: "lap time (s)" }, grid: { color: css("--line") } } },
        plugins: { legend: { display: false }, markers: { spans, lines },
          tooltip: { callbacks: { title: (c) => `Lap ${c[0].parsed.x}`, label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, 3)} s` } } } }) });
    draw("c-calls", { type: "line",
      data: { datasets: [
        { label: "P(box)", data: L.filter((l) => l.p != null).map((l) => ({ x: l.lap, y: l.p })), yAxisID: "p", borderColor: css("--red"),
          backgroundColor: css("--red") + "26", fill: true, pointRadius: 0, borderWidth: 2, tension: 0.2 },
        { label: "Optimiser gain (s)", data: L.filter((l) => l.gain != null).map((l) => ({ x: l.lap, y: Math.max(l.gain, -25) })), yAxisID: "g",
          borderColor: css("--text-3"), borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0 },
      ] },
      options: opts({ scales: { x: linearX(race.laps), p: { position: "left", min: 0, max: 1, title: { display: true, text: "P(box this lap)" }, grid: { color: css("--line") } },
        g: { position: "right", max: 5, title: { display: true, text: "s gained by pitting now" }, grid: { display: false } } },
        plugins: { legend: { display: false }, markers: { spans, lines },
          tooltip: { callbacks: { title: (c) => `Lap ${c[0].parsed.x}`, label: (c) => (c.datasetIndex ? `Optimiser: ${signed(c.parsed.y)} s` : `P(box): ${Math.round(c.parsed.y * 100)}%`) } } } }) });
  }

  /* ---------- TYRES ---------- */
  const ts = { circuit: "Sakhir", temp: 30 };
  $("#t-circuit").onchange = (e) => { ts.circuit = e.target.value; ts.temp = Math.round(model.circuits[ts.circuit].temp); tyres(); };
  $("#t-temp").oninput = (e) => { ts.temp = +e.target.value; tyres(); };
  function tyres() {
    if (active() !== "tyres") return;
    const C = model.circuits[ts.circuit];
    $("#t-circuit").value = ts.circuit; $("#t-temp").value = ts.temp; fill($("#t-temp")); $("#o-ttemp").textContent = ts.temp + "°C";
    const maxA = 50, ds = [];
    model.compounds.forEach((c) => {
      const curve = PitwallCore.degCurve(model, ts.circuit, c, ts.temp, maxA), lim = C.max_age[c], col = css(TYRE[c]);
      const pts = (a0, a1) => Array.from({ length: a1 - a0 + 1 }, (_, i) => ({ x: a0 + i, y: curve[a0 + i] }));
      ds.push({ label: c[0] + c.slice(1).toLowerCase(), data: pts(1, Math.min(lim, maxA)), borderColor: col, borderWidth: 2.5, pointRadius: 0 });
      ds.push({ label: c + " extrapolated", data: pts(Math.min(lim, maxA), Math.min(lim + 6, maxA)), borderColor: col, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 });
    });
    draw("c-deg", { type: "line", data: { datasets: ds },
      options: opts({ scales: { x: { type: "linear", min: 1, max: maxA, title: { display: true, text: "tyre age (laps)" }, grid: { color: css("--line") } },
        y: { suggestedMin: -0.5, title: { display: true, text: "s / 90 s lap" }, grid: { color: css("--line") } } },
        plugins: { legend: { display: true, position: "top", align: "end", labels: { filter: (i) => !i.text.includes("extrap"), boxWidth: 14, boxHeight: 3 } },
          tooltip: { filter: (i) => !i.dataset.label.includes("extrap"), callbacks: { title: (c) => `Age ${c[0].parsed.x}`, label: (c) => `${c.dataset.label}: ${signed(c.parsed.y)} s` } } } }) });
    const per = (p) => (p * (C.laps - 1)).toFixed(2);
    $("#t-facts").innerHTML = [
      ["Green pit loss", fmt(C.pit_green, 1) + " s"], ["Stops measured", C.n_stops], ["Expected SCs / race", per(C.p_sc)],
      ["Expected VSCs / race", per(C.p_vsc)], ["Distance", C.laps + " laps"], ["Typical track temp", fmt(C.temp, 0) + "°C"],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    const order = circuits.slice().sort((a, b) => model.circuits[b].pit_green - model.circuits[a].pit_green);
    draw("c-pit", { type: "bar",
      data: { labels: order, datasets: [{ data: order.map((c) => model.circuits[c].pit_green), borderRadius: 3, barPercentage: 0.75,
        backgroundColor: order.map((c) => (c === ts.circuit ? css("--red") : css("--line-strong"))) }] },
      options: opts({ indexAxis: "y", scales: { x: { min: 15, title: { display: true, text: "seconds" }, grid: { color: css("--line") } },
        y: { ticks: { autoSkip: false, font: { size: 11, family: "'Fira Sans'" }, color: (c) => (order[c.index] === ts.circuit ? css("--text") : css("--text-2")) }, grid: { display: false } } },
        onClick: (_e, el) => { if (el.length) { ts.circuit = order[el[0].index]; ts.temp = Math.round(model.circuits[ts.circuit].temp); tyres(); } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(c.raw, 1)} s (${model.circuits[order[c.dataIndex]].n_stops} stops)` } } } }) });
  }

  /* ---------- RESULTS ---------- */
  function table(head, rows, opt = {}) {
    const bestCol = {};
    (opt.minCols || []).forEach((j) => { const v = rows.map((r) => parseFloat(r[j])).filter(isFinite); bestCol[j] = Math.min(...v); });
    (opt.maxCols || []).forEach((j) => { const v = rows.map((r) => parseFloat(r[j])).filter(isFinite); bestCol[j] = Math.max(...v); });
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${
      rows.map((r) => `<tr class="${opt.us && opt.us(r) ? "us" : ""}">${r.map((c, j) => `<td class="${bestCol[j] != null && parseFloat(c) === bestCol[j] ? "best" : ""}">${c}</td>`).join("")}</tr>`).join("")
    }</tbody></table></div>`;
  }
  function results() {
    const nm = { last_lap: "Repeat last lap", mean_last5: "Mean of last 5 laps", inrace_linear: "Linear fit on this race's laps (public-repo approach)",
      structural: "Pitwall structural model", "structural+gbm": "Pitwall + boosted residual" };
    const ir = Object.keys(T).filter((k) => T[k] && typeof T[k] === "object");
    const pr = metrics.prerace.test, rt = metrics.race_time.test, pl = metrics.pit_loss.test;
    const dn = { optimiser_in_race: "Optimiser alone (time-minimising)", optimiser_pre_race_only: "Optimiser, no in-race updates",
      imitation_basic: "Classifier on tyre and race state", pit_call_model: "Pitwall pit-call model (+ rivals, field)",
      hybrid_optimiser_features: "Pit-call model + optimiser outputs", leaky_current_lap_time: "Leaky: sees the current lap's time" };
    const head = (h, meta) => `<div class="panel-head"><h2>${h}</h2>${meta ? `<span class="meta">${meta}</span>` : ""}</div>`;
    $("#results-body").innerHTML = `
      <section class="panel">${head("Lap time during a race · 2025 · MAE (s)", `${T.n_predictions.toLocaleString()} predictions · purple = best`)}
        ${table(["Model", "All", "1-5 laps", "6-10", "11-20", "21+", "RMSE"], ir.map((k) => [nm[k] || k, fmt(T[k].all, 3), fmt(T[k]["h1-5"], 3), fmt(T[k]["h6-10"], 3), fmt(T[k]["h11-20"], 3), fmt(T[k]["h21-99"], 3), fmt(T[k].rmse, 3)]),
          { minCols: [1, 2, 3, 4, 5, 6], us: (r) => r[0] === nm.structural })}
        <p class="hint">At laps 5, 10, 15, … the model sees only laps already driven and predicts every remaining clean lap of the race.</p></section>
      <div class="two">
        <section class="panel">${head("Lap time before the race · 2025")}
          ${table(["Model", "MAE", "RMSE", "R²"], [
            ["Pitwall v1 Ridge (this repo)", fmt(pr.old_pitwall_ridge.mae, 3), fmt(pr.old_pitwall_ridge.rmse, 3), fmt(pr.old_pitwall_ridge.r2, 3)],
            ["Gradient boosting on conditions", fmt(pr.prerace_gbm.mae, 3), fmt(pr.prerace_gbm.rmse, 3), fmt(pr.prerace_gbm.r2, 3)],
            ["Pitwall structural + base pace", fmt(pr.prerace_structural.mae, 3), fmt(pr.prerace_structural.rmse, 3), fmt(pr.prerace_structural.r2, 3)]],
            { minCols: [1, 2], maxCols: [3], us: (r) => r[0].startsWith("Pitwall structural") })}</section>
        <section class="panel">${head("Pit loss and race simulation · 2025")}
          ${table(["", "Pitwall", "Baseline"], [
            [`Pit-loss MAE, ${pl.stops} green stops`, fmt(pl.mae_circuit_model, 2) + " s", fmt(pl.mae_constant_22s, 2) + " s (fixed 22 s)"],
            ["Remaining race time from lap 10", `${fmt(rt.mae_s, 1)} s (${fmt(rt.mape_pct, 2)}%)`, `${fmt(rt.naive_mae_s, 1)} s (${fmt(rt.naive_mape_pct, 2)}%)`]])}</section>
      </div>
      <section class="panel">${head(`Pit calls vs the real teams · 2025`, `${D.states.toLocaleString()} lap states · ${D.real_stops} stops · thresholds frozen from 2024`)}
        ${table(["Model", "Precision", "Recall", "F1", "F1 ±2 laps", "PR-AUC", "ROC-AUC"], Object.keys(dn).filter((k) => D[k]).map((k) => [dn[k],
          fmt(D[k].precision), fmt(D[k].recall), fmt(D[k].f1), fmt(D[k].tol2.f1), D[k].average_precision ? fmt(D[k].average_precision, 3) : "–", D[k].roc_auc ? fmt(D[k].roc_auc, 3) : "–"]),
          { us: (r) => r[0].startsWith("Pitwall pit-call") })}
        <p class="hint">Every model sees only information available before the lap except the last row. An in-lap is slow because the car is entering the pits, so a model given the lap's own time scores like published per-lap pit predictors.</p></section>
      <section class="panel">${head("Against existing work")}
        ${table(["Work", "Reported", "Pitwall on the comparable task"], [
          ["Pitwall v1 Ridge", `pre-race MAE ${fmt(pr.old_pitwall_ridge.mae, 2)} s`, `${fmt(pr.prerace_structural.mae, 2)} s pre-race · ${fmt(T.structural.all, 2)} s in-race`],
          ["Public FastF1 lap-time repos", "0.29-0.57 s MAE on 1-3 races, same-race laps in training", `${fmt(T.structural["h1-5"], 2)} s forecasting 1-5 laps ahead, unseen season · their method as a forecaster ${fmt(T.inrace_linear.all, 2)} s`],
          ["Bi-LSTM pit predictor, Frontiers in AI 2025", "F1 0.81 · ROC-AUC 0.988", `${fmt(D.pit_call_model.f1, 2)} · ${fmt(D.pit_call_model.roc_auc, 3)} honest · ${fmt(D.leaky_current_lap_time.f1, 2)} · ${fmt(D.leaky_current_lap_time.roc_auc, 3)} with the current lap's time`],
          ["Virtual Strategy Engineer, Heilmeier et al. 2020", "neural nets imitating pit calls in a simulator", "explicit optimiser for “should” + calibrated model for “will”"]])}</section>
      <section class="panel prose">${head("Method")}
        <p><b>Lap time</b> = driver-race base pace + compound offset + fuel (${fmt(model.fuel, 4)} s/kg per 90 s lap) + piecewise tyre curve + circuit and race wear rates + temperature × age + traffic. Base pace per driver per race means wear and fuel are learned from within-race variation only. In a race, race-level terms are re-fitted from laps already driven, weighting recent laps most.</p>
        <p><b>Pit loss</b> is measured from in- and out-laps against the model's expected clean laps. Under a Safety Car it is measured by gap to the leader against non-stopping cars, because the queue returns most of it.</p>
        <p><b>The call</b> comes from a stochastic dynamic programme over the remaining laps with per-circuit SC/VSC risk, the two-compound rule and a cliff beyond observed stint lengths; 30 race-bootstrap refits give the agreement figure.</p></section>`;
  }

  function redraw() {
    const a = active();
    if (a === "strategy") decideNow();
    if (a === "replay") replay();
    if (a === "tyres") tyres();
  }
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(redraw, 150); });

  sync();
  results();
  setRace(0);
  const start = location.hash.slice(1);
  show(["strategy", "replay", "tyres", "results"].includes(start) ? start : "strategy");
})();
