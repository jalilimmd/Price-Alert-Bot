/**
 * Alert evaluation. This is where every correctness guard lives.
 *
 * RATE-LIMIT DISCIPLINE: each asset's price is fetched EXACTLY ONCE per run and
 * that single snapshot is fanned out to every alert on that asset. There is no
 * per-alert fetch anywhere in this file, so cost is O(assets) not O(alerts).
 * BTC daily klines are fetched at most once per run, and only when at least one
 * live 7d/30d alert exists.
 */

import {
  ASSETS,
  ASSET_LIST,
  ALERT_TYPES,
  TYPE_META,
  DISABLED_REASONS,
  HYSTERESIS_FLOOR,
  emptyRuntimeEntry,
  emptySourceState,
  isTypeAllowed,
  isPercentType,
  validateAlertInput,
} from './schema.js';
import { fetchAssetPrice, fetchBtcDailyCloses } from './sources.js';
import { appendSample, nearestPoint, nearestClose, pruneSeries, seriesLength } from './history.js';
import { buildTriggerMessage, buildAutoDisableMessage, buildSourceFailureMessage } from './messages.js';
import { deliver } from './channels/index.js';

const MIN = 60 * 1000;

/* ------------------------------------------------------------- snapshots */

/**
 * One price per asset, plus staleness bookkeeping, written into runtime.sources.
 * Returns { [asset]: { ok, price, source, method, ts, stale, staleReason, attempts } }
 */
export async function buildSnapshots(runtime, config, nowMs, assetsNeeded) {
  const snapshots = {};

  const results = await Promise.all(
    assetsNeeded.map(async (asset) => ({ asset, res: await fetchAssetPrice(asset, config.sources) }))
  );

  for (const { asset, res } of results) {
    if (!runtime.sources[asset]) runtime.sources[asset] = emptySourceState();
    const st = runtime.sources[asset];

    if (!res.ok) {
      st.consecutive_failures += 1;
      st.last_error = res.attempts.map((a) => `${a.adapter}=${a.error}`).join(' | ').slice(0, 400);
      snapshots[asset] = { ok: false, attempts: res.attempts, consecutiveFailures: st.consecutive_failures };
      console.error(`source_chain_failed asset=${asset} consecutive=${st.consecutive_failures} ${st.last_error}`);
      continue;
    }

    // ---- stale guard 1: source-supplied timestamp is too old ----
    let stale = false;
    let staleReason = null;
    const ageMin = Number.isFinite(res.ts) ? (nowMs - res.ts) / MIN : 0;
    if (ageMin > config.staleMaxAgeMin) {
      stale = true;
      staleReason = `timestamp ${Math.round(ageMin)}min old (limit ${config.staleMaxAgeMin})`;
    }

    // ---- stale guard 2: byte-identical to the previous run, repeatedly ----
    if (st.last_price !== null && st.last_price === res.price) {
      st.identical_count += 1;
    } else {
      st.identical_count = 0;
    }
    if (st.identical_count >= config.staleIdenticalRuns) {
      stale = true;
      staleReason = staleReason || `unchanged for ${st.identical_count} consecutive runs`;
    }

    if (stale && !st.stale) st.stale_since = new Date(nowMs).toISOString();
    if (!stale) st.stale_since = null;
    st.stale = stale;
    st.consecutive_failures = 0;
    st.last_ok_at = new Date(nowMs).toISOString();
    st.last_error = null;
    st.last_source = res.source;
    st.last_price = res.price;

    if (stale) {
      // Expected, not exceptional: Iranian gold and Toman feeds freeze
      // overnight, on Fridays and on public holidays. Log at info level.
      console.log(`price_stale asset=${asset} reason="${staleReason}" price=${res.price} source=${res.source}`);
    }

    snapshots[asset] = {
      ok: true,
      price: res.price,
      source: res.source,
      method: res.method,
      adapter: res.adapter,
      ts: res.ts,
      stale,
      staleReason,
    };
  }

  return snapshots;
}

/* ------------------------------------------------- percent-change compute */

/**
 * Returns { ok:true, value, baseline } or { ok:false, skip:'reason' }.
 * A missing baseline is NEVER treated as zero and NEVER as the current price.
 */
function percentChange(alert, snapshot, historyDoc, klineRows, config, nowMs) {
  const meta = TYPE_META[alert.type];
  const targetMs = nowMs - meta.windowMs;
  const tolMs = (config.windowToleranceMin[alert.type] || 30) * MIN;

  if (meta.source === 'kline') {
    if (!klineRows || !klineRows.length) {
      return { ok: false, skip: 'kline data unavailable this run' };
    }
    const base = nearestClose(klineRows, targetMs, tolMs);
    if (!base) return { ok: false, skip: `no daily close within ${Math.round(tolMs / MIN)}min of the target timestamp` };
    if (!(base.price > 0)) return { ok: false, skip: 'baseline close is not positive' };
    return { ok: true, value: ((snapshot.price - base.price) / base.price) * 100, baseline: base };
  }

  const base = nearestPoint(historyDoc, alert.asset, targetMs, tolMs);
  if (!base) {
    const n = seriesLength(historyDoc, alert.asset);
    return {
      ok: false,
      skip: `cold start: no stored point within ${Math.round(tolMs / MIN)}min of the target (${n} samples held)`,
    };
  }
  if (!(base.price > 0)) return { ok: false, skip: 'baseline price is not positive' };
  return { ok: true, value: ((snapshot.price - base.price) / base.price) * 100, baseline: base };
}

/* ----------------------------------------------------- trigger mechanics */

/**
 * Re-arm margin. `hysteresis_pct` is a percentage OF THE BOUND, e.g. a bound of
 * 19,500,000 Toman with the 0.5 default gives a 97,500 Toman margin.
 *
 * The floor exists because a percent-change bound can legitimately sit at or
 * near zero, where a relative margin would be zero and the alert would flap on
 * every tick across the line.
 */
export function marginFor(alert, bound) {
  const relative = Math.abs(bound) * (alert.hysteresis_pct / 100);
  const floor = isPercentType(alert.type) ? HYSTERESIS_FLOOR.percent_points : HYSTERESIS_FLOOR.absolute;
  return Math.max(relative, floor);
}

/** Which bound, if any, the value is currently on the wrong side of. */
export function breachSide(alert, value) {
  if (alert.upper_bound !== null && value > alert.upper_bound) return 'upper';
  if (alert.lower_bound !== null && value < alert.lower_bound) return 'lower';
  return null;
}

/** Has the value come back past the bound by the full hysteresis margin? */
export function hasRearmed(alert, side, value) {
  const bound = side === 'upper' ? alert.upper_bound : alert.lower_bound;
  if (bound === null || bound === undefined) return true; // bound removed; nothing to hold us
  const margin = marginFor(alert, bound);
  return side === 'upper' ? value <= bound - margin : value >= bound + margin;
}

/* ------------------------------------------------------------ main loop */

export async function evaluateAll({ alertsDoc, runtime, history, config, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const alerts = alertsDoc ? alertsDoc.alerts : [];
  const stats = { evaluated: 0, fired: 0, skipped: 0, disabled: 0, gc: 0, notices: 0 };

  /* -- 1. decide what to fetch. Always sample every asset so the ring buffer
        stays warm even with zero alerts; a user adding a 4h alert then has
        history already, instead of waiting four hours for it. ------------- */
  const assetsNeeded = ASSET_LIST.slice();
  const snapshots = await buildSnapshots(runtime, config, nowMs, assetsNeeded);

  /* -- 2. record history for every asset that produced a usable price ---- */
  for (const asset of assetsNeeded) {
    const s = snapshots[asset];
    if (s && s.ok) appendSample(history, asset, nowMs, s.price);
  }
  pruneSeries(history, assetsNeeded);

  /* -- 3. one kline call, only if a live 7d/30d alert exists ------------- */
  const needsKlines = alerts.some((a) => {
    const rt = runtime.alerts[a.id];
    return (
      a.asset === ASSETS.BTC_USDT &&
      TYPE_META[a.type] &&
      TYPE_META[a.type].source === 'kline' &&
      a.enabled !== false &&
      !(rt && rt.system_disabled)
    );
  });
  let klineRows = null;
  let klineSource = null;
  if (needsKlines) {
    const k = await fetchBtcDailyCloses(config.sources);
    if (k.ok) {
      klineRows = k.rows;
      klineSource = k.source;
      console.log(`klines_ok source=${k.source} rows=${k.rows.length}`);
    } else {
      console.error('klines_failed', JSON.stringify(k.attempts));
    }
  }

  /* -- 4. per-alert evaluation ------------------------------------------ */
  const outbox = [];

  for (const alert of alerts) {
    // Lazy init: the first time this tier sees an alert id, create its runtime entry.
    if (!runtime.alerts[alert.id]) {
      runtime.alerts[alert.id] = emptyRuntimeEntry(nowIso);
      console.log(`runtime_init id=${alert.id} asset=${alert.asset} type=${alert.type}`);
    }
    const rt = runtime.alerts[alert.id];

    // --- cheap skips, before touching any data ---
    if (alert.enabled === false) {
      stats.skipped++;
      continue;
    }
    if (rt.system_disabled) {
      stats.skipped++;
      continue;
    }

    // --- defensive re-validation of data read from a file another tier wrote ---
    if (!isTypeAllowed(alert.asset, alert.type)) {
      rt.system_disabled = true;
      rt.disabled_reason = 'invalid_combination';
      rt.last_skip_reason = 'asset/type combination is not permitted';
      console.error(`invalid_alert id=${alert.id} ${alert.asset}/${alert.type} — disabled`);
      stats.disabled++;
      continue;
    }
    const revalid = validateAlertInput({
      asset: alert.asset,
      type: alert.type,
      lower: alert.lower_bound,
      upper: alert.upper_bound,
      cooldown: alert.cooldown_minutes,
      max: alert.max_triggers,
      expires: alert.expires_after_days,
      hyst: alert.hysteresis_pct,
    });
    if (!revalid.ok) {
      rt.system_disabled = true;
      rt.disabled_reason = 'invalid_definition';
      rt.last_skip_reason = revalid.error;
      console.error(`invalid_alert id=${alert.id}: ${revalid.error} — disabled`);
      stats.disabled++;
      continue;
    }

    // --- lifecycle: expiry first, then trigger ceiling ---
    const createdMs = Date.parse(alert.created_at);
    if (Number.isFinite(createdMs) && nowMs > createdMs + alert.expires_after_days * 24 * 60 * MIN) {
      rt.system_disabled = true;
      rt.disabled_reason = DISABLED_REASONS.EXPIRED;
      stats.disabled++;
      outbox.push({ alert, payload: buildAutoDisableMessage(alert, DISABLED_REASONS.EXPIRED) });
      console.log(`auto_disable id=${alert.id} reason=expired`);
      continue;
    }
    if (rt.trigger_count >= alert.max_triggers) {
      rt.system_disabled = true;
      rt.disabled_reason = DISABLED_REASONS.MAX_TRIGGERS;
      stats.disabled++;
      outbox.push({ alert, payload: buildAutoDisableMessage(alert, DISABLED_REASONS.MAX_TRIGGERS) });
      console.log(`auto_disable id=${alert.id} reason=max_triggers`);
      continue;
    }

    const snap = snapshots[alert.asset];
    rt.last_evaluated_at = nowIso;

    if (!snap || !snap.ok) {
      rt.last_skip_reason = 'price source unavailable';
      stats.skipped++;
      continue;
    }

    // --- monitored value ---
    let value;
    let baseline = null;
    if (alert.type === ALERT_TYPES.ABSOLUTE_TARGET) {
      value = snap.price;
    } else {
      if (snap.stale) {
        rt.last_skip_reason = `stale feed: ${snap.staleReason}`;
        console.log(`skip_stale id=${alert.id} ${snap.staleReason}`);
        stats.skipped++;
        continue;
      }
      const pc = percentChange(alert, snap, history, klineRows, config, nowMs);
      if (!pc.ok) {
        rt.last_skip_reason = pc.skip;
        console.log(`skip id=${alert.id} type=${alert.type} reason="${pc.skip}"`);
        stats.skipped++;
        continue;
      }
      value = pc.value;
      baseline = pc.baseline;
    }

    rt.last_value = value;
    rt.last_skip_reason = null;
    stats.evaluated++;

    // --- edge-triggered state machine ---
    const side = breachSide(alert, value);

    if (!side) {
      if (!rt.armed) {
        const from = rt.breach_side || 'upper';
        if (hasRearmed(alert, from, value)) {
          rt.armed = true;
          rt.breach_side = null;
          console.log(`rearmed id=${alert.id} value=${value}`);
        }
      }
      continue;
    }

    // Breaching. Fire only on the transition into breach, or on a transition
    // straight from one side to the other (a jump large enough to cross the
    // whole safe band between two samples is a genuinely new edge).
    const isNewEdge = rt.armed || (rt.breach_side && rt.breach_side !== side);
    if (!isNewEdge) continue;

    const lastMs = rt.last_triggered_at ? Date.parse(rt.last_triggered_at) : 0;
    const cooldownActive = Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs < alert.cooldown_minutes * MIN;

    if (cooldownActive) {
      // The edge is CONSUMED, not queued. `cooldown_minutes` is documented as a
      // floor of at most one notification per window; holding the edge and
      // firing it late would deliver a notice about a crossing that is already
      // stale by up to `cooldown` minutes.
      rt.armed = false;
      rt.breach_side = side;
      rt.last_skip_reason = `crossing suppressed by the ${alert.cooldown_minutes}min cooldown`;
      console.log(`skip_cooldown id=${alert.id} side=${side} value=${value}`);
      stats.skipped++;
      continue;
    }

    const bound = side === 'upper' ? alert.upper_bound : alert.lower_bound;
    rt.armed = false;
    rt.breach_side = side;
    rt.trigger_count += 1;
    rt.last_triggered_at = nowIso;
    stats.fired++;

    outbox.push({
      alert,
      payload: buildTriggerMessage(alert, {
        side,
        bound,
        value,
        price: snap.price,
        snapshot: { ...snap, source: klineSource && TYPE_META[alert.type].source === 'kline' ? `${snap.source} + ${klineSource}` : snap.source },
        baseline,
        nowMs,
        triggerCount: rt.trigger_count,
      }),
    });
    console.log(`FIRE id=${alert.id} asset=${alert.asset} type=${alert.type} side=${side} value=${value} bound=${bound}`);

    if (rt.trigger_count >= alert.max_triggers) {
      rt.system_disabled = true;
      rt.disabled_reason = DISABLED_REASONS.MAX_TRIGGERS;
      stats.disabled++;
      outbox.push({ alert, payload: buildAutoDisableMessage(alert, DISABLED_REASONS.MAX_TRIGGERS) });
    }
  }

  /* -- 5. garbage-collect runtime entries whose alert no longer exists --- */
  const liveIds = new Set(alerts.map((a) => a.id));
  for (const id of Object.keys(runtime.alerts)) {
    if (!liveIds.has(id)) {
      delete runtime.alerts[id];
      stats.gc++;
      console.log(`runtime_gc id=${id}`);
    }
  }

  /* -- 6. deliver alert messages ---------------------------------------- */
  for (const item of outbox) {
    await deliver({ ...item.payload, chatIdTelegram: item.alert.chat_id }, config);
  }

  /* -- 7. whole-chain source failures: one throttled notice to the admin - */
  for (const asset of assetsNeeded) {
    const snap = snapshots[asset];
    if (!snap || snap.ok) continue;
    const st = runtime.sources[asset];
    if (st.consecutive_failures < config.sourceFailureThreshold) continue;
    if (!config.adminChatId) {
      console.error(`source_failure_no_admin asset=${asset} — set ADMIN_CHAT_ID to be told about this`);
      continue;
    }
    const lastNotice = runtime.admin.source_failure_notified_at[asset];
    const lastMs = lastNotice ? Date.parse(lastNotice) : 0;
    if (Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs < config.sourceFailureNoticeCooldownMin * MIN) continue;

    await deliver(
      { ...buildSourceFailureMessage(asset, snap.attempts, st.consecutive_failures, nowMs), chatIdTelegram: config.adminChatId },
      config
    );
    runtime.admin.source_failure_notified_at[asset] = nowIso;
    stats.notices++;
  }

  runtime.last_run_at = nowIso;
  return { stats, snapshots, klineRows: klineRows ? klineRows.length : 0 };
}
