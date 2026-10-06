"""The What-If engine and question parser (web/src/whatif/*.ts), run under node on the shipped web data."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "web"
QUESTIONS = [
    "What if Leclerc had followed Pitwall's strategy at Monza?",
    "What if Verstappen pitted 5 laps later at Zandvoort?",
    "What if there was no safety car in the Dutch GP for Verstappen?",
    "What if a safety car came out on lap 30 in Bahrain for Norris?",
    "What if Norris had two-stopped in Hungary?",
    "What if Hamilton went onto hards on lap 20 at Monza?",
    "What if Piastri skipped his last stop at Zandvoort?",
]


def _node_strips_types():
    if shutil.which("node") is None:
        return False
    r = subprocess.run(["node", "-e", "process.exit(process.features.typescript ? 0 : 1)"], capture_output=True)
    return r.returncode == 0


@pytest.mark.skipif(not _node_strips_types(), reason="needs node with TypeScript type stripping (22.18+)")
@pytest.mark.skipif(not (WEB / "public" / "data" / "races.json").exists(), reason="web data not exported")
def test_whatif_scenarios():
    script = f"""
      const fs = await import('node:fs');
      const E = await import({json.dumps((WEB / 'src/whatif/engine.ts').as_uri())});
      const P = await import({json.dumps((WEB / 'src/whatif/parser.ts').as_uri())});
      const model = JSON.parse(fs.readFileSync({json.dumps(str(WEB / 'public/data/model.json'))}));
      const raw = JSON.parse(fs.readFileSync({json.dumps(str(WEB / 'public/data/races.json'))}));
      const races = raw.races.map((r) => ({{ ...r, drivers: r.drivers.map((d) => ({{ ...d,
        laps: d.laps.map((a) => Object.fromEntries(raw.fields.map((k, i) => [k === 'p_call' ? 'p' : k, a[i]]))) }})) }}));
      const run = (q) => {{ const p = P.parse(q, races); const r = E.runWhatIf(model, races[p.raceIdx], p.driver, p.changes);
        return {{ missing: p.missing, ok: r.ok, real: r.actual.finish, cf: r.cf.finish, delta: r.delta }}; }};
      const d0 = races[0].drivers[0].driver;
      const n = E.runWhatIf(model, races[0], d0, [{{ type: 'pitShift', stop: 1, delta: 0 }}]);
      console.log(JSON.stringify({{ qs: {json.dumps(QUESTIONS)}.map(run),
        nochange: {{ real: n.actual.finish, cf: n.cf.finish, delta: n.delta }} }}));
    """
    out = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", script], capture_output=True, text=True,
                         check=True).stdout
    res = json.loads(out)
    for q, r in zip(QUESTIONS, res["qs"]):
        assert r["missing"] == [] and r["ok"], q
    # an unchanged race reproduces reality exactly
    assert res["nochange"]["real"] == res["nochange"]["cf"] and abs(res["nochange"]["delta"]) < 1e-6
    monza, *_, skip = res["qs"]
    assert monza["cf"] < monza["real"] and monza["delta"] < 0      # the optimiser gains at Monza
    assert skip["cf"] > skip["real"]                               # skipping a stop costs positions
