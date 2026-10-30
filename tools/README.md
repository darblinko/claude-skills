# Figure pipeline

The README charts and the landing page charts are generated from one file,
`docs/data.json`. Every number in it is computed by `examples/lookahead_demo.py`.

`svgchart.py` is a vendored copy of a shared chart renderer. It uses the Python
standard library only. It is excluded from ruff so it stays in its upstream
formatting.

## Regenerate

Run from the repository root:

```bash
uv run python examples/lookahead_demo.py
python3 tools/svgchart.py docs/data.json docs/figures
```

1. `examples/lookahead_demo.py` executes the Python blocks of
   `skills/ts-ml-lookahead-audit/SKILL.md`, measures them on synthetic bars and
   writes `docs/data.json`. `meta.revision` records the commit it ran at and
   `meta.measured` the date.
2. `tools/svgchart.py` reads `docs/data.json` and writes
   `docs/figures/<name>-light.svg` and `docs/figures/<name>-dark.svg` for every
   chart. It prints one Markdown snippet per chart: a `<!-- chart: <name> -->`
   marker, a `<picture>` element (GitHub picks the variant for the viewer's
   theme) and a collapsed data table.
3. In `README.md`, replace the block that starts at each `<!-- chart: <name> -->`
   marker and ends at its `</details>` with the matching printed snippet.
4. Update the revision in the `docs/index.html` footer. The landing page reads
   `docs/data.json` through `docs/charts.js` at view time, so its charts need no
   other step.

`tests/test_figures.py` fails when `docs/data.json`, the SVGs or the README
snippets differ from what this pipeline produces.

## docs/data.json schema

```json
{
  "meta": {"repo": "claude-skills", "revision": "abc1234", "measured": "2026-10-28"},
  "charts": [
    {"name": "audit-correlations", "type": "hbar",
     "title": "Feature correlation with the 5-minute forward return",
     "subtitle": "lookahead_audit on 10 synthetic sessions of 1-minute bars, seed 1",
     "source": "python examples/lookahead_demo.py",
     "alt": "peek_3m |r| 0.77; ...",
     "format": "decimal2", "max": 1,
     "threshold": {"value": 0.15, "label": "flag above 0.15"},
     "data": [{"label": "peek_3m", "value": 0.773, "status": "fail"}]}
  ]
}
```

Every chart has `name`, `type`, `title`, `subtitle`, `source` (the file or
command the numbers come from), `alt` (text for screen readers and the SVG
`<desc>`) and `format`.

| type | Required fields | Use for |
|---|---|---|
| hbar | data: [{label, value, status?, note?}]; optional max, threshold {value, label} | Per-feature or per-rule comparisons. status is "pass" or "fail" and prints as text beside the bar. |
| columns | categories: [...], series: [{name, values}] (1 to 4 series) | Values per category |
| line | x: [...], series: [{name, values}] (1 to 4 series; null for a gap; the last value must be a number); optional min, max | Change over folds, runs or time |
| stats | tiles: [{label, value (preformatted string), note?}] | Single figures. At most 4 tiles per row. |

`format` is one of `percent` (values are fractions, 0.86 prints 86%), `number`
(default, 2,909), `decimal2` or `decimal3`.

Rules: one y-axis per chart, at most 4 series, status colors only for pass and
fail, titles in sentence case that state what is plotted. A number with no
measured source gets no chart.
