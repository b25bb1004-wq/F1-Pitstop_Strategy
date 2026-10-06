"""The browser engine (web/src/core/pitwall-core.js) must make the same calls as Python."""
import json
import shutil
import subprocess

import pytest

from pitwall.export_web import model_json
from pitwall.strategy import RaceState, decide

STATES = [
    ("Sakhir", 14, 57, "SOFT", 13, False, "green", 30.0),
    ("Sakhir", 14, 57, "SOFT", 13, False, "sc", 30.0),
    ("Monaco", 30, 78, "MEDIUM", 29, False, "green", 45.0),
    ("Silverstone", 40, 52, "HARD", 15, True, "green", 40.0),
    ("Monza", 25, 53, "MEDIUM", 24, False, "vsc", 42.0),
    ("Marina Bay", 35, 62, "HARD", 20, True, "green", 33.0),
]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_js_matches_python(bundle, tmp_path):
    (tmp_path / "model.json").write_text(json.dumps(model_json(bundle)))
    states = [dict(circuit=c, lap=l, raceLaps=n, compound=k, tyreAge=a, twoCompounds=t, status=s,
                   trackTemp=tt) for c, l, n, k, a, t, s, tt in STATES]
    (tmp_path / "states.json").write_text(json.dumps(states))
    core = (__import__("pathlib").Path(__file__).resolve().parents[1] / "web" / "src" / "core" / "pitwall-core.js").as_uri()
    script = f"""
      const core = await import({json.dumps(core)});
      const fs = await import('node:fs');
      const model = JSON.parse(fs.readFileSync({json.dumps(str(tmp_path / 'model.json'))}));
      const states = JSON.parse(fs.readFileSync({json.dumps(str(tmp_path / 'states.json'))}));
      console.log(JSON.stringify(states.map(s => {{ const r = core.decide(model, s);
        return [r.pitNow, r.fit, r.gain, r.plan.stops.map(x => x.lap)]; }})));
    """
    out = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True,
                                    check=True).stdout)
    for (c, l, n, k, a, t, s, tt), (pit, fit, gain, stops) in zip(STATES, out):
        py = decide(bundle["model"], bundle["tables"], RaceState(c, l, n, k, a, t, s, tt))
        assert pit == py["pit_now"] and fit == py["fit_compound"]
        assert abs(gain - py["gain_if_pit_now_s"]) < 0.02, (c, gain, py["gain_if_pit_now_s"])
        assert stops == [x["lap"] for x in py["plan"]["stops"]]
