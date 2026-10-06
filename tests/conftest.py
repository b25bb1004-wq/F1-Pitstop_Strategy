import pickle
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def bundle():
    with open(ROOT / "models" / "pitwall.pkl", "rb") as fh:
        return pickle.load(fh)
