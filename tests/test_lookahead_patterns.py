"""Run the Python snippets in the ts-ml-lookahead-audit skill against synthetic bars.

The snippets are executed from SKILL.md itself, so the documented code is the code
under test.
"""

import numpy as np
import pandas as pd
import pytest

from examples.lookahead_demo import (
    BARS_PER_SESSION,
    BUCKET_MINUTES,
    CONDITIONS,
    audit_dataset,
    bucket_features,
    bucket_sources,
    epoch_seconds,
    future_reads,
    load_skill_snippets,
    make_bars,
)


@pytest.fixture(scope="module")
def skill():
    namespace, block_count = load_skill_snippets()
    assert block_count == 3
    return namespace


def test_bucket_last_leaky_reads_the_future(skill):
    bars = make_bars()
    leaking_bars_per_bucket = BUCKET_MINUTES - 1
    buckets = 2 * BARS_PER_SESSION // BUCKET_MINUTES
    read_from = bucket_sources(skill, bars)["leaky"]
    assert future_reads(bars, read_from) == leaking_bars_per_bucket * buckets


def test_future_reads_does_not_depend_on_repeated_closes(skill):
    bars = make_bars()
    bars["close"] = np.resize([100.0, 101.0, 100.0], len(bars))
    sources = bucket_sources(skill, bars)
    buckets = 2 * BARS_PER_SESSION // BUCKET_MINUTES
    assert future_reads(bars, sources["leaky"]) == (BUCKET_MINUTES - 1) * buckets
    assert future_reads(bars, sources["gap-safe"]) == 0


def test_future_reads_counts_no_reads_for_a_bar_reading_itself():
    bars = pd.DataFrame(
        {"close": [100.0, 101.0, 100.0]},
        index=pd.date_range("2026-01-05 09:30", periods=3, freq="1min"),
    )
    assert future_reads(bars, epoch_seconds(bars.index)) == 0


def test_bucket_last_safe_has_no_future_reads(skill):
    bars = make_bars()
    read_from = bucket_sources(skill, bars)["row shift"]
    assert future_reads(bars, read_from) == 0
    assert read_from.notna().sum() == 2 * (BARS_PER_SESSION - BUCKET_MINUTES)


def test_bucket_last_safe_with_missing_bars_has_no_future_reads(skill):
    bars = make_bars(drop_fraction=0.1)
    assert future_reads(bars, bucket_sources(skill, bars)["row shift"]) == 0


def test_bucket_last_safe_leaks_on_bars_finer_than_one_minute(skill):
    bars = make_bars(freq="30s")
    assert future_reads(bars, bucket_sources(skill, bars)["row shift"]) > 0


def test_bucket_last_safe_with_gaps_reads_the_previous_bucket_of_the_same_day(skill):
    times = pd.DatetimeIndex(
        [
            "2026-01-05 09:30",
            "2026-01-05 09:31",
            "2026-01-05 09:34",
            # no bars in the 09:35 bucket
            "2026-01-05 09:40",
            "2026-01-05 09:42",
            "2026-01-06 09:30",
            "2026-01-06 09:36",
            "2026-01-06 09:37",
        ]
    )
    bars = pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]}, index=times)
    feature = bucket_features(skill, bars)["gap-safe"]
    nan = float("nan")
    expected = pd.Series([nan, nan, nan, 3.0, 3.0, nan, 6.0, 6.0], index=times)
    pd.testing.assert_series_equal(feature, expected, check_names=False)


@pytest.mark.parametrize("condition", list(CONDITIONS))
def test_bucket_last_safe_with_gaps_has_no_future_reads(skill, condition):
    bars = make_bars(**CONDITIONS[condition])
    read_from = bucket_sources(skill, bars)["gap-safe"]
    assert read_from.notna().sum() > 0
    assert future_reads(bars, read_from) == 0


def daily_frames():
    dates = pd.bdate_range("2026-01-05", periods=4)
    daily = pd.DataFrame({"date": dates, "vix_close": [14.0, 15.0, 16.0, 17.0]})
    intraday = pd.DataFrame({"date": dates.repeat(3), "bar": range(12)})
    return intraday, daily


def test_merge_daily_leaky_sees_same_day_close(skill):
    intraday, daily = daily_frames()
    merged = skill["merge_daily_leaky"](intraday, daily)
    assert merged["vix_close"].tolist() == [14.0] * 3 + [15.0] * 3 + [16.0] * 3 + [17.0] * 3


def test_merge_daily_safe_sees_previous_day_close(skill):
    intraday, daily = daily_frames()
    merged = skill["merge_daily_safe"](intraday, daily)
    assert merged["vix_close"].isna().sum() == 3
    assert merged["vix_close"].iloc[3:].tolist() == [14.0] * 3 + [15.0] * 3 + [16.0] * 3


def test_shifting_the_date_column_too_removes_nothing(skill):
    intraday, daily = daily_frames()
    shifted_everything = daily.apply(lambda column: column.shift(1))
    merged = intraday.merge(shifted_everything, on="date", how="left")
    leaky = skill["merge_daily_leaky"](intraday, daily)
    first_three_days = slice(0, 9)
    assert (
        merged["vix_close"].iloc[first_three_days].equals(leaky["vix_close"].iloc[first_three_days])
    )


def test_audit_flags_planted_leaks_and_passes_honest_features(skill):
    flagged = [
        column for column, _ in skill["lookahead_audit"](audit_dataset(skill), "fwd_return_5m")
    ]
    assert set(flagged) == {"peek_3m", "bucket_gap_leaky"}


def test_audit_skips_the_target_and_known_forward_columns(skill):
    scores = dict(skill["lookahead_audit"](audit_dataset(skill), "fwd_return_5m", threshold=0.0))
    assert "fwd_return_5m" not in scores
    assert "mfe_5m" not in scores


def test_audit_skips_a_target_without_a_known_prefix(skill):
    dataset = audit_dataset(skill).rename(columns={"fwd_return_5m": "label"})
    scores = dict(skill["lookahead_audit"](dataset, "label", threshold=0.0))
    assert "label" not in scores


def test_audit_scores_a_feature_containing_infinity(skill):
    target = np.arange(200, dtype=float)
    feature = target.copy()
    feature[0] = np.inf
    dataset = pd.DataFrame({"target": target, "copy_of_target": feature})
    scores = dict(skill["lookahead_audit"](dataset, "target"))
    assert scores["copy_of_target"] == pytest.approx(1.0)


def test_audit_warns_about_columns_it_cannot_score(skill):
    target = np.arange(200, dtype=float)
    dataset = pd.DataFrame(
        {"target": target, "all_infinite": np.full(200, np.inf), "constant": np.ones(200)}
    )
    with pytest.warns(UserWarning, match=r"could not score: \['all_infinite', 'constant'\]"):
        assert skill["lookahead_audit"](dataset, "target") == []
