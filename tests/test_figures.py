"""Check that docs/data.json, the README SVGs and the README snippets are current.

Each test reruns one step of the pipeline in tools/README.md and compares the
result with the committed file.
"""

import json
import subprocess
import sys

import pytest

from examples.lookahead_demo import REPO_ROOT, main

DATA_PATH = REPO_ROOT / "docs/data.json"
FIGURES = REPO_ROOT / "docs/figures"
SVGCHART = REPO_ROOT / "tools/svgchart.py"


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("figures")
    result = subprocess.run(
        [sys.executable, str(SVGCHART), str(DATA_PATH), str(out_dir)],
        capture_output=True,
        text=True,
        check=True,
    )
    return out_dir, result.stdout


def test_data_json_matches_a_fresh_measurement(tmp_path):
    fresh = tmp_path / "data.json"
    main(["lookahead_demo.py", str(fresh)])
    committed = json.loads(DATA_PATH.read_text())
    assert json.loads(fresh.read_text())["charts"] == committed["charts"]


def test_committed_svgs_match_the_renderer(rendered):
    out_dir, _ = rendered
    names = sorted(path.name for path in out_dir.glob("*.svg"))
    assert names == sorted(path.name for path in FIGURES.glob("*.svg"))
    for name in names:
        assert (FIGURES / name).read_text() == (out_dir / name).read_text(), name


def test_readme_contains_every_chart_snippet(rendered):
    _, snippets = rendered
    readme = (REPO_ROOT / "README.md").read_text()
    for snippet in snippets.split("<!-- chart: ")[1:]:
        assert "<!-- chart: " + snippet.rstrip("\n") in readme
