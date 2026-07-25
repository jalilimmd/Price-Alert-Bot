/**
 * Price history: one fixed-size ring buffer per asset.
 *
 * Deliberately minimal. The longest locally-served window is 24 hours, so at
 * one sample per run the ring holds RING_SIZE = 288 points and nothing else:
 * no multi-tier downsampling, no retention policy, no compaction job. BTC's
 * 7-day and 30-day windows come from the exchange kline endpoint instead, so
 * nothing here ever needs to reach past a day.
 *
 * Points are stored as [unixSeconds, price] pairs to keep the file small.
 */

import { RING_SIZE } from './schema.js';

export function appendSample(historyDoc, asset, tsMs, price) {
  if (!Array.isArray(historyDoc.series[asset])) historyDoc.series[asset] = [];
  const series = historyDoc.series[asset];
  const sec = Math.floor(tsMs / 1000);

  // Guard against a duplicated run (manual dispatch racing the cron, which the
  // workflow concurrency group should prevent, but belt and braces).
  const last = series[series.length - 1];
  if (last && last[0] === sec) {
    series[series.length - 1] = [sec, price];
  } else {
    series.push([sec, price]);
  }

  while (series.length > RING_SIZE) series.shift();
  return series.length;
}

/**
 * Finds the stored point nearest to `targetMs`.
 *
 * SELECTION IS BY TIMESTAMP PROXIMITY, NEVER BY ARRAY INDEX. GitHub's cron is
 * routinely 5–20 minutes late and occasionally skips a slot entirely, so "the
 * point 6 slots back" is not "30 minutes ago" and treating it as such would
 * quietly report a percent change over the wrong period.
 *
 * Returns { ts, price, deltaMs } or null when nothing lies within toleranceMs.
 */
export function nearestPoint(historyDoc, asset, targetMs, toleranceMs) {
  const series = historyDoc.series[asset];
  if (!Array.isArray(series) || !series.length) return null;

  let best = null;
  let bestDelta = Infinity;
  for (const [sec, price] of series) {
    const ts = sec * 1000;
    const delta = Math.abs(ts - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { ts, price, deltaMs: ts - targetMs };
    }
  }
  if (!best || bestDelta > toleranceMs) return null;
  return best;
}

/** Same proximity rule, applied to an ascending [{ts, close}] kline array. */
export function nearestClose(rows, targetMs, toleranceMs) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const r of rows) {
    const delta = Math.abs(r.ts - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { ts: r.ts, price: r.close, deltaMs: r.ts - targetMs };
    }
  }
  if (!best || bestDelta > toleranceMs) return null;
  return best;
}

export function seriesSpanMs(historyDoc, asset) {
  const series = historyDoc.series[asset];
  if (!Array.isArray(series) || series.length < 2) return 0;
  return (series[series.length - 1][0] - series[0][0]) * 1000;
}

export function seriesLength(historyDoc, asset) {
  const series = historyDoc.series[asset];
  return Array.isArray(series) ? series.length : 0;
}

/** Drops series for assets that are no longer monitored, keeping the file tidy. */
export function pruneSeries(historyDoc, keepAssets) {
  const keep = new Set(keepAssets);
  for (const k of Object.keys(historyDoc.series)) {
    if (!keep.has(k)) delete historyDoc.series[k];
  }
}
