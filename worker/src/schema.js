/* ============================================================
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: shared/schema.js
 * Regenerate with:  npm run sync
 * ============================================================ */
/**
 * CANONICAL SHARED SCHEMA — single source of truth.
 *
 * DO NOT EDIT THE COPIES. Edit this file, then run:  npm run sync
 * Copies live at worker/src/schema.js and actions/src/schema.js and are
 * byte-compared by .github/workflows/schema-check.yml on every push.
 *
 * The two runtimes (Cloudflare Workers, Node on GitHub Actions) cannot import
 * from one another, so the file is physically duplicated and CI enforces equality.
 */

export const SCHEMA_VERSION = 1;

export const FILE_ALERTS = 'alerts.json'; // written ONLY by the Worker
export const FILE_RUNTIME = 'runtime.json'; // written ONLY by Actions
export const FILE_HISTORY = 'history.json'; // written ONLY by Actions

/* ------------------------------------------------------------------ assets */

export const ASSETS = Object.freeze({
  BTC_USDT: 'BTC_USDT',
  GOLD18: 'GOLD18',
  USDT_IRT: 'USDT_IRT',
});

export const ASSET_LIST = Object.freeze([ASSETS.BTC_USDT, ASSETS.GOLD18, ASSETS.USDT_IRT]);

/**
 * GOLD18 is one GRAM of 18-karat (750) gold, quoted in Iranian TOMAN.
 * It is explicitly NOT mesghal/mazaneh (~4.6083 g of 17-carat trade gold) and
 * NOT abshodeh / melted gold. Every user-facing string repeats this.
 */
export const ASSET_META = Object.freeze({
  BTC_USDT: {
    key: 'BTC_USDT',
    cmd: 'btc',
    quote: 'USDT',
    quoteFa: 'تتر',
    decimals: 2,
    fa: 'بیت‌کوین / تتر (BTC/USDT)',
    faShort: 'BTC/USDT',
    faLong: 'قیمت لحظه‌ای بیت‌کوین بر حسب تتر در بازار اسپات',
  },
  GOLD18: {
    key: 'GOLD18',
    cmd: 'gold',
    quote: 'TOMAN',
    quoteFa: 'تومان',
    decimals: 0,
    fa: 'یک گرم طلای ۱۸ عیار (۷۵۰)',
    faShort: 'گرم طلای ۱۸ عیار',
    faLong: 'قیمت هر گرم طلای ۱۸ عیار (۷۵۰) بر حسب تومان — نه مثقال، نه آب‌شده',
  },
  USDT_IRT: {
    key: 'USDT_IRT',
    cmd: 'usdt',
    quote: 'TOMAN',
    quoteFa: 'تومان',
    decimals: 0,
    fa: 'تتر / تومان (بازار ایران)',
    faShort: 'تتر/تومان',
    faLong: 'نرخ واقعی تتر بر حسب تومان در صرافی‌های ایرانی',
  },
});

export const ASSET_ALIASES = Object.freeze({
  btc: 'BTC_USDT',
  bitcoin: 'BTC_USDT',
  'btc/usdt': 'BTC_USDT',
  btcusdt: 'BTC_USDT',
  btc_usdt: 'BTC_USDT',
  بیتکوین: 'BTC_USDT',
  'بیت‌کوین': 'BTC_USDT',
  gold: 'GOLD18',
  gold18: 'GOLD18',
  geram18: 'GOLD18',
  g18: 'GOLD18',
  طلا: 'GOLD18',
  'طلا18': 'GOLD18',
  usdt: 'USDT_IRT',
  tether: 'USDT_IRT',
  'usdt/irt': 'USDT_IRT',
  usdtirt: 'USDT_IRT',
  usdt_irt: 'USDT_IRT',
  تتر: 'USDT_IRT',
});

export function resolveAsset(raw) {
  if (!raw) return null;
  const k = String(raw).trim().toLowerCase();
  if (ASSETS[k.toUpperCase()]) return ASSETS[k.toUpperCase()];
  return ASSET_ALIASES[k] || null;
}

/* ------------------------------------------------------------- alert types */

export const ALERT_TYPES = Object.freeze({
  ABSOLUTE_TARGET: 'ABSOLUTE_TARGET',
  PCT_CHANGE_30M: 'PCT_CHANGE_30M',
  PCT_CHANGE_4H: 'PCT_CHANGE_4H',
  PCT_CHANGE_24H: 'PCT_CHANGE_24H',
  PCT_CHANGE_7D: 'PCT_CHANGE_7D',
  PCT_CHANGE_30D: 'PCT_CHANGE_30D',
});

export const TYPE_LIST = Object.freeze(Object.keys(ALERT_TYPES));

export const TYPE_ALIASES = Object.freeze({
  abs: 'ABSOLUTE_TARGET',
  absolute: 'ABSOLUTE_TARGET',
  target: 'ABSOLUTE_TARGET',
  price: 'ABSOLUTE_TARGET',
  '30m': 'PCT_CHANGE_30M',
  '4h': 'PCT_CHANGE_4H',
  '24h': 'PCT_CHANGE_24H',
  '1d': 'PCT_CHANGE_24H',
  '7d': 'PCT_CHANGE_7D',
  '1w': 'PCT_CHANGE_7D',
  '30d': 'PCT_CHANGE_30D',
  '1m': 'PCT_CHANGE_30D',
});

export function resolveType(raw) {
  if (!raw) return null;
  const k = String(raw).trim().toLowerCase();
  const up = k.toUpperCase();
  if (ALERT_TYPES[up]) return ALERT_TYPES[up];
  return TYPE_ALIASES[k] || null;
}

export const TYPE_META = Object.freeze({
  ABSOLUTE_TARGET: { windowMs: 0, source: 'spot', fa: 'رسیدن به قیمت مشخص', unitFa: 'قیمت' },
  PCT_CHANGE_30M: { windowMs: 30 * 60 * 1000, source: 'ring', fa: 'تغییر درصدی ۳۰ دقیقه', unitFa: 'درصد' },
  PCT_CHANGE_4H: { windowMs: 4 * 60 * 60 * 1000, source: 'ring', fa: 'تغییر درصدی ۴ ساعت', unitFa: 'درصد' },
  PCT_CHANGE_24H: { windowMs: 24 * 60 * 60 * 1000, source: 'ring', fa: 'تغییر درصدی ۲۴ ساعت', unitFa: 'درصد' },
  PCT_CHANGE_7D: { windowMs: 7 * 24 * 60 * 60 * 1000, source: 'kline', fa: 'تغییر درصدی ۷ روز', unitFa: 'درصد' },
  PCT_CHANGE_30D: { windowMs: 30 * 24 * 60 * 60 * 1000, source: 'kline', fa: 'تغییر درصدی ۳۰ روز', unitFa: 'درصد' },
});

export function isPercentType(type) {
  return type !== ALERT_TYPES.ABSOLUTE_TARGET;
}

/**
 * Availability matrix. 7d/30d exist only for BTC because they are served by the
 * exchange kline endpoint at zero storage cost. No free Iranian source exposes
 * 7d/30d history for gram-18k gold or USDT/IRT, and the local ring buffer only
 * spans 24 hours by design.
 */
export const ASSET_TYPE_MATRIX = Object.freeze({
  BTC_USDT: Object.freeze([
    'ABSOLUTE_TARGET',
    'PCT_CHANGE_30M',
    'PCT_CHANGE_4H',
    'PCT_CHANGE_24H',
    'PCT_CHANGE_7D',
    'PCT_CHANGE_30D',
  ]),
  GOLD18: Object.freeze(['ABSOLUTE_TARGET', 'PCT_CHANGE_30M', 'PCT_CHANGE_4H', 'PCT_CHANGE_24H']),
  USDT_IRT: Object.freeze(['ABSOLUTE_TARGET', 'PCT_CHANGE_30M', 'PCT_CHANGE_4H', 'PCT_CHANGE_24H']),
});

export function isTypeAllowed(asset, type) {
  const allowed = ASSET_TYPE_MATRIX[asset];
  return Array.isArray(allowed) && allowed.includes(type);
}

/* ---------------------------------------------------------------- defaults */

export const DEFAULTS = Object.freeze({
  cooldown_minutes: 120,
  max_triggers: 3,
  expires_after_days: 30,
  hysteresis_pct: 0.5, // percent OF THE BOUND, e.g. bound 5,000,000 -> margin 25,000
});

export const LIMITS = Object.freeze({
  cooldown_minutes: { min: 5, max: 10080 },
  max_triggers: { min: 1, max: 100 },
  expires_after_days: { min: 1, max: 365 },
  hysteresis_pct: { min: 0, max: 50 },
  alerts_per_chat: 40,
  alerts_total: 400,
});

/** Minimum absolute re-arm margin, so a bound at or near zero cannot flap. */
export const HYSTERESIS_FLOOR = Object.freeze({
  percent_points: 0.05, // for PCT_CHANGE_* bounds, in percentage points
  absolute: 0, // for ABSOLUTE_TARGET, relative margin is always meaningful
});

export const RING_SIZE = 288; // 24h at one sample per 5-minute run

export const DISABLED_REASONS = Object.freeze({
  MAX_TRIGGERS: 'max_triggers',
  EXPIRED: 'expired',
});

export const DISABLED_REASON_FA = Object.freeze({
  max_triggers: 'به سقف تعداد اعلان رسید',
  expired: 'مهلت هشدار تمام شد',
});

/* ------------------------------------------------------------ empty models */

export function emptyAlertsDoc() {
  return { schema_version: SCHEMA_VERSION, updated_at: null, alerts: [] };
}

export function emptyRuntimeDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: null,
    last_run_at: null,
    alerts: {},
    sources: {},
    admin: { source_failure_notified_at: {} },
  };
}

export function emptyHistoryDoc() {
  return { schema_version: SCHEMA_VERSION, updated_at: null, series: {} };
}

export function emptyRuntimeEntry(nowIso) {
  return {
    armed: true,
    breach_side: null,
    trigger_count: 0,
    last_triggered_at: null,
    system_disabled: false,
    disabled_reason: null,
    first_seen_at: nowIso,
    last_evaluated_at: null,
    last_value: null,
    last_skip_reason: null,
  };
}

export function emptySourceState() {
  return {
    consecutive_failures: 0,
    last_ok_at: null,
    last_error: null,
    last_source: null,
    last_price: null,
    identical_count: 0,
    stale: false,
    stale_since: null,
  };
}

/* -------------------------------------------------------------- migrations */

export class SchemaTooNewError extends Error {
  constructor(file, found) {
    super(`${file} has schema_version ${found}, this build understands ${SCHEMA_VERSION}`);
    this.name = 'SchemaTooNewError';
    this.file = file;
    this.found = found;
  }
}

/**
 * Migration path. Every migration is a pure function from version N to N+1.
 * A file whose schema_version is HIGHER than this build throws, so an older
 * deployment can never silently overwrite data written by a newer one.
 */
const ALERT_MIGRATIONS = {
  // 1: (doc) => { ...; doc.schema_version = 2; return doc; }
};
const RUNTIME_MIGRATIONS = {};
const HISTORY_MIGRATIONS = {};

function runMigrations(doc, table, file) {
  let v = Number(doc.schema_version) || 1;
  if (v > SCHEMA_VERSION) throw new SchemaTooNewError(file, v);
  while (v < SCHEMA_VERSION) {
    const step = table[v];
    if (!step) {
      doc.schema_version = SCHEMA_VERSION;
      break;
    }
    doc = step(doc);
    v = Number(doc.schema_version) || v + 1;
  }
  doc.schema_version = SCHEMA_VERSION;
  return doc;
}

export function migrateAlertsDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyAlertsDoc();
  const doc = runMigrations({ ...raw }, ALERT_MIGRATIONS, FILE_ALERTS);
  if (!Array.isArray(doc.alerts)) doc.alerts = [];
  doc.alerts = doc.alerts.filter((a) => a && typeof a === 'object' && a.id).map(normalizeAlert);
  return doc;
}

export function migrateRuntimeDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyRuntimeDoc();
  const doc = runMigrations({ ...raw }, RUNTIME_MIGRATIONS, FILE_RUNTIME);
  if (!doc.alerts || typeof doc.alerts !== 'object') doc.alerts = {};
  if (!doc.sources || typeof doc.sources !== 'object') doc.sources = {};
  if (!doc.admin || typeof doc.admin !== 'object') doc.admin = { source_failure_notified_at: {} };
  if (!doc.admin.source_failure_notified_at) doc.admin.source_failure_notified_at = {};
  return doc;
}

export function migrateHistoryDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyHistoryDoc();
  const doc = runMigrations({ ...raw }, HISTORY_MIGRATIONS, FILE_HISTORY);
  if (!doc.series || typeof doc.series !== 'object') doc.series = {};
  for (const k of Object.keys(doc.series)) {
    if (!Array.isArray(doc.series[k])) doc.series[k] = [];
  }
  return doc;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeAlert(a) {
  return {
    id: String(a.id),
    chat_id: num(a.chat_id, 0),
    asset: a.asset,
    type: a.type,
    lower_bound: a.lower_bound === null || a.lower_bound === undefined ? null : num(a.lower_bound, null),
    upper_bound: a.upper_bound === null || a.upper_bound === undefined ? null : num(a.upper_bound, null),
    cooldown_minutes: num(a.cooldown_minutes, DEFAULTS.cooldown_minutes),
    max_triggers: num(a.max_triggers, DEFAULTS.max_triggers),
    expires_after_days: num(a.expires_after_days, DEFAULTS.expires_after_days),
    hysteresis_pct: num(a.hysteresis_pct, DEFAULTS.hysteresis_pct),
    enabled: a.enabled !== false,
    created_at: a.created_at || new Date(0).toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

/* ------------------------------------------------------------- id creation */

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike glyphs

export function newAlertId(randomBytes) {
  let out = '';
  for (let i = 0; i < 7; i++) out += ID_ALPHABET[randomBytes[i] % ID_ALPHABET.length];
  return out;
}

export function newAlertRecord({ id, chatId, asset, type, lower, upper, cooldown, max, expires, hyst, nowIso }) {
  return normalizeAlert({
    id,
    chat_id: chatId,
    asset,
    type,
    lower_bound: lower,
    upper_bound: upper,
    cooldown_minutes: cooldown,
    max_triggers: max,
    expires_after_days: expires,
    hysteresis_pct: hyst,
    enabled: true,
    created_at: nowIso,
  });
}

/* ------------------------------------------------------- shared validation */

/**
 * Validates a candidate alert. Returns { ok: true, alert } or
 * { ok: false, error } where error is a ready-to-send Persian sentence.
 * Both tiers call this; the Worker rejects at command time, Actions uses it as
 * a defensive re-check before evaluating anything it read from the Gist.
 */
export function validateAlertInput({ asset, type, lower, upper, cooldown, max, expires, hyst }) {
  if (!asset) return { ok: false, error: 'دارایی مشخص نشده است. یکی از این‌ها را بنویسید: btc / gold / usdt' };
  if (!ASSET_META[asset]) return { ok: false, error: `دارایی «${asset}» شناخته نشد.` };
  if (!type) return { ok: false, error: 'نوع هشدار مشخص نشده است. یکی از این‌ها: abs / 30m / 4h / 24h / 7d / 30d' };
  if (!TYPE_META[type]) return { ok: false, error: `نوع هشدار «${type}» شناخته نشد.` };

  if (!isTypeAllowed(asset, type)) {
    const allowed = ASSET_TYPE_MATRIX[asset].join(' ، ');
    return {
      ok: false,
      error:
        `هشدار «${TYPE_META[type].fa}» برای «${ASSET_META[asset].faShort}» در دسترس نیست.\n` +
        `دلیل: هیچ منبع رایگان ایرانی تاریخچهٔ ۷ روزه یا ۳۰ روزهٔ ${ASSET_META[asset].faShort} را نمی‌دهد، ` +
        `و بافر محلی این ربات فقط ۲۴ ساعت را نگه می‌دارد.\n` +
        `انواع مجاز برای این دارایی: ${allowed}`,
    };
  }

  const hasLower = lower !== null && lower !== undefined && Number.isFinite(Number(lower));
  const hasUpper = upper !== null && upper !== undefined && Number.isFinite(Number(upper));
  if (!hasLower && !hasUpper) {
    return {
      ok: false,
      error: 'دست‌کم یکی از دو کران لازم است: below=… یا above=…\nمثال: /add btc abs above=70000',
    };
  }

  const lo = hasLower ? Number(lower) : null;
  const up = hasUpper ? Number(upper) : null;

  if (type === ALERT_TYPES.ABSOLUTE_TARGET) {
    if (lo !== null && lo <= 0) return { ok: false, error: 'کران پایین در حالت abs باید عددی مثبت باشد.' };
    if (up !== null && up <= 0) return { ok: false, error: 'کران بالا در حالت abs باید عددی مثبت باشد.' };
  } else {
    if (lo !== null && (lo < -100 || lo > 1000)) return { ok: false, error: 'کران پایین درصدی باید بین ‎-100 و 1000 باشد.' };
    if (up !== null && (up < -100 || up > 1000)) return { ok: false, error: 'کران بالا درصدی باید بین ‎-100 و 1000 باشد.' };
  }
  if (lo !== null && up !== null && lo >= up) {
    return { ok: false, error: 'کران پایین باید کوچک‌تر از کران بالا باشد.' };
  }

  const checks = [
    ['cooldown_minutes', cooldown, 'cooldown'],
    ['max_triggers', max, 'max'],
    ['expires_after_days', expires, 'expires'],
    ['hysteresis_pct', hyst, 'hyst'],
  ];
  for (const [field, value, flag] of checks) {
    if (value === null || value === undefined) continue;
    const n = Number(value);
    const lim = LIMITS[field];
    if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
      return { ok: false, error: `مقدار ${flag} باید عددی بین ${lim.min} و ${lim.max} باشد.` };
    }
  }

  return {
    ok: true,
    value: {
      asset,
      type,
      lower: lo,
      upper: up,
      cooldown: cooldown == null ? DEFAULTS.cooldown_minutes : Number(cooldown),
      max: max == null ? DEFAULTS.max_triggers : Number(max),
      expires: expires == null ? DEFAULTS.expires_after_days : Number(expires),
      hyst: hyst == null ? DEFAULTS.hysteresis_pct : Number(hyst),
    },
  };
}

/** Effective status = user toggle AND NOT system disable. */
export function effectiveStatus(alert, runtimeEntry) {
  const rt = runtimeEntry || null;
  const systemDisabled = !!(rt && rt.system_disabled);
  return {
    active: alert.enabled === true && !systemDisabled,
    paused: alert.enabled === false,
    systemDisabled,
    disabledReason: systemDisabled ? rt.disabled_reason : null,
    triggerCount: rt ? rt.trigger_count : 0,
    armed: rt ? rt.armed : true,
    evaluated: !!(rt && rt.last_evaluated_at),
  };
}
