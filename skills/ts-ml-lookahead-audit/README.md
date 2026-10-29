# ts-ml-lookahead-audit

Detects look-ahead bias in time-series ML datasets: features that, at a bar's
timestamp, contain information recorded after it. Claude loads `SKILL.md` while
building or reviewing a dataset of intraday or other time-indexed features
(`user-invocable: false` keeps it out of the slash-command menu).

## What it covers

| Leak | Pattern in `SKILL.md` |
|---|---|
| Bucket resample: every bar in a 5-minute bucket sees the bucket's last value | `bucket_last_leaky`, fixed by `bucket_last_safe` (gapless 1-minute bars) or `bucket_last_safe_with_gaps` |
| Daily merge: an intraday bar sees that day's close | `merge_daily_leaky`, fixed by `merge_daily_safe` |
| Excursion columns (MFE, MAE) used as features | Skipped by prefix in the audit; they belong in targets only |

`lookahead_audit(df, target_col)` samples the dataset and reports every numeric
feature whose absolute Pearson correlation with a short-horizon forward return
exceeds 0.15 (the `threshold` default in `SKILL.md`).

## Tests and measurements

The Python blocks in `SKILL.md` are executed as written by
`tests/test_lookahead_patterns.py` and `examples/lookahead_demo.py` at the repo
root, on synthetic random-walk bars. The tests check that:

- `bucket_last_leaky` reads a later close on 4 of every 5 bars of 5-minute
  buckets (`BUCKET_MINUTES` in `examples/lookahead_demo.py`);
- `bucket_last_safe` reads none on 1-minute bars, with or without missing bars,
  and does read later closes on 30-second bars;
- `bucket_last_safe_with_gaps` reads none in all three conditions;
- `merge_daily_safe` gives each date the previous date's value, and shifting the
  date column together with the values removes nothing;
- the audit flags the two planted leaky features and passes the honest ones.

## Fixes made while publishing

- The audit snippet used `np` without importing numpy, included the target in
  its own scan when the target name had no known prefix, and failed on datasets
  with fewer than 5,000 rows. It is now a function that handles all three.
- The original daily-merge fix shifted every column of the daily frame,
  including the date key, which leaves each date paired with its own value. The
  fix now shifts the value columns only. A test covers the original pattern.
- The row-count shift in the bucket fix equals one bucket only for 1-minute bars;
  `SKILL.md` now states this and adds a variant that works on bucket keys.

## Limitations

- The 0.15 and 0.05 correlation figures are rules of thumb for short-horizon
  returns. A leak whose effect is nonlinear can pass a Pearson audit.
- The audit inspects features one at a time against one target.
