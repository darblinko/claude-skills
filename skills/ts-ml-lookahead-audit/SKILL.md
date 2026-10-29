---
name: ts-ml-lookahead-audit
description: "Detect look-ahead bias in time-series ML datasets: resample leaks, daily-merge leaks, correlation audit"
user-invocable: false
---

# Time-Series ML Look-Ahead Bias Detection

**Context:** When building ML datasets from intraday financial data (or any time series), subtle look-ahead leaks can push short-horizon directional accuracy far above the 50% baseline while staying invisible in standard train/test splits.

## Problem

ML models trained on time-series feature datasets show high accuracy that does not degrade between in-sample and out-of-sample periods. Common causes:

1. **Resample/bucket leak**: `groupby().transform("last")` or `.resample("5min").last()` on time-series data assigns the END-of-bucket value to ALL bars in the bucket. A bar at 10:01 sees the 10:04 close, 3 minutes ahead. The first bar of a bucket reads furthest ahead: 4 minutes in 5m buckets, 14 minutes in 15m buckets.

2. **Daily data merge leak**: Merging daily close values (VIX, economic data) by same-day date means at 9:30 AM the model sees the 4:15 PM close (about 7 hours of look-ahead).

3. **MFE/MAE as features**: Maximum Favorable/Adverse Excursion columns are forward-looking by definition. They must be targets only, never features.

## Detection: Correlation Audit

Run this on any ML dataset before training:

```python
import numpy as np
import pandas as pd
from scipy.stats import pearsonr

KNOWN_TARGET_PREFIXES = ("fwd_", "mae_", "mfe_")


def lookahead_audit(df, target_col, threshold=0.15, sample_size=5000, seed=42):
    """Return (column, |r|) pairs for numeric features suspiciously correlated with the target."""
    sample = df.sample(min(sample_size, len(df)), random_state=seed)
    sample = sample[sample[target_col].notna()]
    suspicious = []
    for col in sample.select_dtypes(include=[np.number]).columns:
        if col == target_col or col.startswith(KNOWN_TARGET_PREFIXES):
            continue  # the target itself and known forward-looking columns
        valid = sample[[col, target_col]].dropna()
        if len(valid) < 100 or valid[col].nunique() < 2:
            continue
        r, _ = pearsonr(valid[col], valid[target_col])
        if abs(r) > threshold:
            suspicious.append((col, float(abs(r))))
    return sorted(suspicious, key=lambda pair: -pair[1])
```

Call it as `lookahead_audit(df, "fwd_return_5m")` and report every returned
column as suspicious, with its |r|.

**Red flags**: Any feature with |r| > 0.15 against a short-horizon forward return. Honest 1-minute features rarely exceed |r| = 0.05. Both thresholds are rules of thumb; tune them to the horizon and the asset.

## Fix Patterns

The three bucket functions take pandas objects aligned on the same index: `df` is a
frame of bars in time order, `bucket_start` is each bar's bucket start time
(for example `df.index.floor("5min")` as a Series), and `trading_day` is each
bar's session date.

### Resample bucket fix

```python
import pandas as pd


def bucket_last_leaky(df, col, bucket_start):
    # WRONG: every bar in a bucket sees the bucket's final value.
    return df.groupby(bucket_start)[col].transform("last")


def bucket_last_safe(df, col, bucket_start, trading_day, bucket_minutes):
    # RIGHT for 1-minute bars: shift by one bucket's worth of rows. The shift
    # counts rows. Missing bars make it reach further back (stale, no leak);
    # bars finer than 1 minute make it land inside the current bucket (a leak).
    bucket_last = df.groupby(bucket_start)[col].transform("last")
    return bucket_last.groupby(trading_day).shift(bucket_minutes)


def bucket_last_safe_with_gaps(df, col, bucket_start, trading_day):
    # RIGHT when bars can be missing: take the previous bucket's last value per day.
    last = df[col].groupby([trading_day, bucket_start]).last()
    previous = last.groupby(level=0).shift(1)
    keys = pd.MultiIndex.from_arrays([trading_day, bucket_start])
    return pd.Series(previous.reindex(keys).to_numpy(), index=df.index)
```

### Daily data merge fix

```python
def merge_daily_leaky(intraday, daily, on="date"):
    # WRONG: at 09:30 each bar sees that day's close.
    return intraday.merge(daily, on=on, how="left")


def merge_daily_safe(intraday, daily, on="date"):
    # RIGHT: each date carries the previous row's values. Shift the value columns
    # only; shifting the date column with them leaves every pairing unchanged.
    daily = daily.sort_values(on)
    value_cols = [c for c in daily.columns if c != on]
    shifted = daily.assign(**{c: daily[c].shift(1) for c in value_cols})
    return intraday.merge(shifted, on=on, how="left")
```

`merge_daily_safe` assumes one row per trading day, so the previous row is the
previous session.

## When to Use

- After building any ML dataset from time-series data
- When model accuracy is higher than the task supports (>65% on binary direction prediction for short-horizon returns)
- When accuracy does not degrade between in-sample and out-of-sample periods
- When zero losing days appear in a backtest
- Before any model goes to production
