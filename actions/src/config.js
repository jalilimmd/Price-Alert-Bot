/**
 * TIER 2 configuration. Every value comes from the environment (GitHub Secrets
 * and workflow env), nothing is hardcoded and nothing is read from the Gist.
 */

import { DEFAULT_CONFIG } from './sources.js';

function envStr(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v).trim();
}

/**
 * NOTE the empty-string case, which is not hypothetical: the workflow passes
 * every tunable as `VAR: ${{ vars.VAR }}`, and an UNSET repository variable
 * interpolates to an empty string rather than being absent. `Number('')` is 0
 * and `Number.isFinite(0)` is true, so reading the env directly would return 0
 * for every unset tunable and never reach the fallback — which set
 * `timeoutMs: 0` and made AbortSignal.timeout abort every request before it
 * left the runner. Delegate to envStr, which already collapses '' to the
 * fallback, exactly as envBool and envList do.
 */
function envNum(name, fallback) {
  const raw = envStr(name);
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name, fallback) {
  const v = envStr(name).toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envList(name, fallback) {
  const v = envStr(name);
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // --- required ---
  gistId: envStr('GIST_ID'),
  githubToken: envStr('GH_GIST_TOKEN'),
  botToken: envStr('BOT_TOKEN'),

  // --- optional ---
  adminChatId: envStr('ADMIN_CHAT_ID'),
  brsapiKey: envStr('BRSAPI_KEY'),

  // --- secondary channel: ntfy ---
  ntfyEnabled: envBool('NTFY_ENABLED', false),
  ntfyServer: envStr('NTFY_SERVER', 'https://ntfy.sh'),
  ntfyTopic: envStr('NTFY_TOPIC'),
  ntfyToken: envStr('NTFY_TOKEN'),

  // --- third channel: Bale (ships disabled; proves the interface is pluggable) ---
  baleEnabled: envBool('BALE_ENABLED', false),
  baleToken: envStr('BALE_BOT_TOKEN'),
  baleChatId: envStr('BALE_CHAT_ID'),

  // --- tuning ---
  sources: {
    ...DEFAULT_CONFIG,
    timeoutMs: envNum('SOURCE_TIMEOUT_MS', 8000),
    retries: envNum('SOURCE_RETRIES', 2),
    userAgent: envStr('USER_AGENT', 'price-alert-bot/1.0 (github-actions; +https://github.com)'),
    brsapiKey: envStr('BRSAPI_KEY'),
    goldOrder: envList('GOLD_SOURCE_ORDER', DEFAULT_CONFIG.goldOrder),
    btcOrder: envList('BTC_SOURCE_ORDER', DEFAULT_CONFIG.btcOrder),
    usdtOrder: envList('USDT_SOURCE_ORDER', DEFAULT_CONFIG.usdtOrder),
    maxSpreadPct: envNum('MAX_SPREAD_PCT', 1.5),
  },

  /**
   * Cold-start guard. A percent-change window is only computed when a stored
   * point exists within this many minutes of the target timestamp. Runs are
   * irregular (GitHub delays the cron 5–20 min routinely), so these are generous
   * relative to the window but never large enough to silently measure a
   * materially different period.
   */
  windowToleranceMin: {
    PCT_CHANGE_30M: envNum('TOL_30M_MIN', 10),
    PCT_CHANGE_4H: envNum('TOL_4H_MIN', 40),
    PCT_CHANGE_24H: envNum('TOL_24H_MIN', 150),
    PCT_CHANGE_7D: envNum('TOL_7D_MIN', 2160), // 1.5 days, daily klines
    PCT_CHANGE_30D: envNum('TOL_30D_MIN', 2160),
  },

  /**
   * Stale-price guard. After this many consecutive runs returning a byte-identical
   * price, the feed is treated as frozen and percent-change computation is
   * skipped for that asset. 12 runs is roughly an hour at the nominal cadence.
   * Iranian gold and USDT feeds freeze overnight and on Fridays; that is
   * expected market behaviour, logged at info level, not an error.
   */
  staleIdenticalRuns: envNum('STALE_IDENTICAL_RUNS', 12),

  /** A source timestamp older than this marks the sample stale immediately. */
  staleMaxAgeMin: envNum('STALE_MAX_AGE_MIN', 90),

  /** Own cooldown for the "all sources failed" admin notice, per asset. */
  sourceFailureNoticeCooldownMin: envNum('SOURCE_FAILURE_NOTICE_COOLDOWN_MIN', 180),

  /** Consecutive whole-chain failures before the admin is told at all. */
  sourceFailureThreshold: envNum('SOURCE_FAILURE_THRESHOLD', 3),

  dryRun: envBool('DRY_RUN', false),
};

export function validateConfig() {
  const missing = [];
  if (!config.gistId) missing.push('GIST_ID');
  if (!config.githubToken) missing.push('GH_GIST_TOKEN');
  if (!config.botToken) missing.push('BOT_TOKEN');
  return missing;
}
