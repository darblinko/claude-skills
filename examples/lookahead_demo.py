"""Measure the ts-ml-lookahead-audit snippets on synthetic bars and write docs/data.json.

Usage: python examples/lookahead_demo.py [output.json]

The snippets are executed from the skill's SKILL.md, so the documented code is the
code being measured. The tests in tests/test_lookahead_patterns.py use the same
helpers.
"""

import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = REPO_ROOT / "skills/ts-ml-lookahead-audit/SKILL.md"
DEFAULT_OUTPUT = REPO_ROOT / "docs/data.json"
BARS_PER_SESSION = 390
BUCKET_MINUTES = 5
AUDIT_THRESHOLD = 0.15


def load_skill_snippets(skill_path=SKILL_PATH):
    blocks = re.findall(r"```python\n(.*?)```", skill_path.read_text(), re.DOTALL)
    namespace = {}
    for block in blocks:
        exec(compile(block, str(skill_path), "exec"), namespace)
    return namespace, len(blocks)


def make_bars(sessions=2, freq="1min", seed=0, drop_fraction=0.0):
    rng = np.random.default_rng(seed)
    bars_per_session = BARS_PER_SESSION * pd.Timedelta("1min") // pd.Timedelta(freq)
    opens = pd.bdate_range("2026-01-05", periods=sessions) + pd.Timedelta(hours=9, minutes=30)
    index = pd.DatetimeIndex(
        np.concatenate(
            [pd.date_range(start, periods=bars_per_session, freq=freq) for start in opens]
        )
    )
    close = 100 + np.cumsum(rng.normal(0, 0.05, len(index)))
    bars = pd.DataFrame({"close": close}, index=index)
    if drop_fraction:
        bars = bars[rng.random(len(bars)) >= drop_fraction]
    return bars


def bucket_keys(bars):
    bucket_start = pd.Series(bars.index.floor(f"{BUCKET_MINUTES}min"), index=bars.index)
    trading_day = pd.Series(bars.index.normalize(), index=bars.index)
    return bucket_start, trading_day


def future_reads(bars, feature):
    """Count bars whose feature value is a close recorded after the bar itself."""
    recorded_at = dict(zip(bars["close"].to_numpy(), bars.index, strict=True))
    values = feature.dropna()
    return sum(recorded_at[value] > bar_time for bar_time, value in values.items())


def bucket_features(skill, bars):
    bucket_start, trading_day = bucket_keys(bars)
    return {
        "leaky": skill["bucket_last_leaky"](bars, "close", bucket_start),
        "row shift": skill["bucket_last_safe"](
            bars, "close", bucket_start, trading_day, BUCKET_MINUTES
        ),
        "gap-safe": skill["bucket_last_safe_with_gaps"](bars, "close", bucket_start, trading_day),
    }


def audit_dataset(skill, sessions=10, seed=1):
    bars = make_bars(sessions=sessions, seed=seed)
    close = bars["close"]
    by_day = close.groupby(bucket_keys(bars)[1])
    features = bucket_features(skill, bars)
    return pd.DataFrame(
        {
            "fwd_return_5m": by_day.shift(-5) / close - 1,
            "mfe_5m": by_day.transform(lambda day: day[::-1].rolling(5).max()[::-1]) / close - 1,
            "return_1m": by_day.pct_change(),
            "peek_3m": by_day.shift(-3) / close - 1,
            "bucket_gap_leaky": features["leaky"] / close - 1,
            "bucket_gap_safe": features["row shift"] / close - 1,
        }
    )


CONDITIONS = {
    "1-minute bars": {"freq": "1min"},
    "1-minute with 10% missing": {"freq": "1min", "drop_fraction": 0.1},
    "30-second bars": {"freq": "30s"},
}


def future_read_chart(skill):
    shares = {name: [] for name in ("leaky", "row shift", "gap-safe")}
    for params in CONDITIONS.values():
        bars = make_bars(**params)
        for name, feature in bucket_features(skill, bars).items():
            shares[name].append(round(future_reads(bars, feature) / len(bars), 4))
    return {
        "name": "future-reads",
        "type": "columns",
        "title": "Share of bars whose 5-minute bucket feature reads a later close",
        "subtitle": "2 synthetic sessions per condition, seed 0",
        "source": "python examples/lookahead_demo.py",
        "alt": " ".join(
            f"{name}: {', '.join(f'{share:.0%}' for share in values)}."
            for name, values in shares.items()
        )
        + f" Conditions in order: {'; '.join(CONDITIONS)}.",
        "format": "percent",
        "categories": list(CONDITIONS),
        "series": [{"name": name, "values": values} for name, values in shares.items()],
    }


def audit_chart(skill):
    dataset = audit_dataset(skill)
    scores = skill["lookahead_audit"](dataset, "fwd_return_5m", threshold=0.0)
    return {
        "name": "audit-correlations",
        "type": "hbar",
        "title": "Feature correlation with the 5-minute forward return",
        "subtitle": "lookahead_audit on 10 synthetic sessions of 1-minute bars, seed 1",
        "source": "python examples/lookahead_demo.py",
        "alt": "; ".join(f"{column} |r| {score:.2f}" for column, score in scores)
        + f". Features above {AUDIT_THRESHOLD} are flagged.",
        "format": "decimal2",
        "max": 1,
        "threshold": {"value": AUDIT_THRESHOLD, "label": f"flag above {AUDIT_THRESHOLD}"},
        "data": [
            {
                "label": column,
                "value": round(score, 3),
                "status": "fail" if score > AUDIT_THRESHOLD else "pass",
            }
            for column, score in scores
        ],
    }


def current_revision():
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def main(argv):
    output = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUTPUT
    skill, _ = load_skill_snippets()
    data = {
        "meta": {
            "repo": "claude-skills",
            "revision": current_revision(),
            "measured": date.today().isoformat(),
        },
        "charts": [audit_chart(skill), future_read_chart(skill)],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
