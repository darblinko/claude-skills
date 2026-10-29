---
name: ts-ml-lookahead-audit
description: "Detect look-ahead bias in time-series ML datasets: resample leaks, daily-merge leaks, correlation audit"
user-invocable: false
---

# Time-Series ML Look-Ahead Bias Detection

**Context:** When building ML datasets from intraday financial data (or any time series), subtle look-ahead leaks can push short-horizon directional accuracy far above the 50% baseline while staying invisible in standard train/test splits.

## Problem

ML models trained on time-series feature datasets show high accuracy that does not degrade between in-sample and out-of-sample periods. Common causes:

1. **Resample/bucket leak**: `groupby().transform("last")` or `.resample("5min").last()` on time-series data assigns the END-of-bucket value to ALL bars in the bucket. A bar at 10:01 sees the 10:04 close (4-minute look-ahead for 5m buckets, 14-minute for 15m).

2. **Daily data merge leak**: Merging daily close values (VIX, economic data) by same-day date means at 9:30 AM the model sees the 4:15 PM close (about 7 hours of look-ahead).

3. **MFE/MAE as features**: Maximum Favorable/Adverse Excursion columns are forward-looking by definition. They must be targets only, never features.

## Detection: Correlation Audit

Run this on any ML dataset before training:

```python
from scipy.stats import pearsonr

target_col = "fwd_return_5m"  # or whatever your target is
sample = df.sample(5000, random_state=42)
fwd = sample[target_col].dropna()
sample_clean = sample.loc[fwd.index]

for col in sample_clean.select_dtypes(include=[np.number]).columns:
    if col.startswith("fwd_") or col.startswith("mae_") or col.startswith("mfe_"):
        continue  # skip known targets
    valid = sample_clean[[col, target_col]].dropna()
    if len(valid) < 100:
        continue
    r, _ = pearsonr(valid[col], valid[target_col])
    if abs(r) > 0.15:
        print(f"SUSPICIOUS: {col} |r|={abs(r):.4f}")
```

**Red flags**: Any feature with |r| > 0.15 against a short-horizon forward return. Honest 1-minute features rarely exceed |r| = 0.05.

## Fix Patterns

### Resample bucket fix
```python
# WRONG: look-ahead
resampled = df.groupby(bucket_key)[col].transform("last")

# RIGHT: shift by one bucket
bucket_last = df.groupby(bucket_key)[col].transform("last")
resampled = bucket_last.groupby(trading_day).shift(freq_minutes)
```

### Daily data merge fix
```python
# WRONG: same-day merge
df.merge(daily_data, left_on="date", right_on="date")

# RIGHT: shift daily data by one row before merging
daily_shifted = daily_data.copy()
for col in daily_shifted.columns:
    daily_shifted[col] = daily_shifted[col].shift(1)
df.merge(daily_shifted, left_on="date", right_on="date")
```

## When to Use

- After building any ML dataset from time-series data
- When model accuracy is higher than the task supports (>65% on binary direction prediction for short-horizon returns)
- When accuracy does not degrade between in-sample and out-of-sample periods
- When zero losing days appear in a backtest
- Before any model goes to production
