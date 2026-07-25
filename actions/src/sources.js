/* ============================================================
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: shared/sources.js
 * Regenerate with:  npm run sync
 * ============================================================ */
/**
 * CANONICAL SHARED PRICE SOURCES — single source of truth.
 *
 * DO NOT EDIT THE COPIES. Edit this file, then run:  npm run sync
 *
 * Deliberately runtime-agnostic: uses only global fetch, AbortSignal.timeout and
 * plain objects, all of which exist in both Cloudflare Workers and Node 22.
 * Nothing here reads process.env or `env` — the caller passes a config object.
 *
 * ENDPOINT PROVENANCE (verified 2026-07-24, re-verify with `npm run diagnose`):
 *   OKX      https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT     public, no key
 *            https://www.okx.com/api/v5/market/candles?instId=&bar=1D     public, no key
 *   KuCoin   https://api.kucoin.com/api/v1/market/orderbook/level1        public, no key
 *            https://api.kucoin.com/api/v1/market/candles?type=1day       public, no key
 *   Coinbase https://api.exchange.coinbase.com/products/BTC-USDT/ticker   public, no key
 *   Nobitex  POST https://api.nobitex.ir/market/stats                     public, no key, RIAL
 *   Wallex   https://api.wallex.ir/v1/depth?symbol=USDTTMN                public, no key, TOMAN
 *   BrsAPI   https://Api.BrsApi.ir/Market/Gold_Currency.php?key=          free key, 1500/day
 *   TGJU     https://call1.tgju.org/ajax.json                             UNOFFICIAL, RIAL
 *
 * Binance is intentionally absent from every chain: api.binance.com answers HTTP
 * 451 to United-States egress IPs, and GitHub-hosted runners are US-based.
 */

import { ASSETS } from './schema.js';

export const DEFAULT_CONFIG = Object.freeze({
  timeoutMs: 8000,
  retries: 2,
  backoffBaseMs: 500,
  backoffMaxMs: 8000,
  userAgent: 'price-alert-bot/1.0 (+https://github.com/)',
  brsapiKey: '',
  goldOrder: ['brsapi', 'tgju'],
  btcOrder: ['okx', 'kucoin', 'coinbase'],
  usdtOrder: ['nobitex', 'wallex'],
  maxSpreadPct: 1.5, // above this the book is treated as untrustworthy -> last trade
});

export class SourceError extends Error {
  constructor(source, message, status) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
    this.source = source;
    this.status = status ?? null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(base, max) {
  const capped = Math.min(base, max);
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}

/**
 * fetch with explicit timeout, explicit User-Agent, Retry-After handling and
 * exponential backoff with jitter. Retries only on 429/5xx/network errors.
 */
export async function httpJson(url, opts = {}, cfg = DEFAULT_CONFIG) {
  const retries = opts.retries ?? cfg.retries;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = jitter(cfg.backoffBaseMs * 2 ** (attempt - 1), cfg.backoffMaxMs);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'application/json',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        const ra = Number(res.headers.get('Retry-After'));
        if (Number.isFinite(ra) && ra > 0 && attempt < retries) {
          await sleep(Math.min(ra * 1000, cfg.backoffMaxMs));
        }
        lastErr = new SourceError(url, 'rate limited (429)', 429);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new SourceError(url, `upstream ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) {
        // 4xx other than 429 will not improve on retry.
        throw new SourceError(url, `HTTP ${res.status}`, res.status);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new SourceError(url, `non-JSON response (first 120 chars: ${text.slice(0, 120)})`, res.status);
      }
    } catch (e) {
      if (e instanceof SourceError && e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new SourceError(url, 'unknown failure');
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mid of best bid / best ask, with a sanity guard.
 * WHY MID AND NOT LAST TRADE (applies to USDT/IRT):
 *   Iranian order books are thin and a single stale or wash print can sit far
 *   from where the market actually is, sometimes for minutes. The mid of the
 *   top of book is the price you could actually transact near right now and it
 *   updates continuously even with no trades. When the spread is implausibly
 *   wide (>maxSpreadPct) the book is treated as untrustworthy and we fall back
 *   to the last trade, which is the more conservative of two bad options.
 */
function midOrLast(bid, ask, last, cfg) {
  if (bid && ask && ask > 0 && bid > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;
    if (spreadPct <= cfg.maxSpreadPct) return { price: mid, method: 'mid_of_best_bid_ask', spreadPct };
    if (last) return { price: last, method: 'last_trade_wide_spread', spreadPct };
    return { price: mid, method: 'mid_of_best_bid_ask_wide', spreadPct };
  }
  if (last) return { price: last, method: 'last_trade', spreadPct: null };
  return null;
}

/* ------------------------------------------------------------ BTC adapters */

const BTC_ADAPTERS = {
  async okx(cfg) {
    const j = await httpJson('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', {}, cfg);
    if (j.code !== '0' || !Array.isArray(j.data) || !j.data[0]) throw new SourceError('okx', `bad payload code=${j.code}`);
    const d = j.data[0];
    const r = midOrLast(toNum(d.bidPx), toNum(d.askPx), toNum(d.last), cfg);
    if (!r) throw new SourceError('okx', 'no usable price fields');
    return { price: r.price, method: r.method, ts: toNum(d.ts) || Date.now(), source: 'OKX' };
  },
  async kucoin(cfg) {
    const j = await httpJson('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT', {}, cfg);
    if (j.code !== '200000' || !j.data) throw new SourceError('kucoin', `bad payload code=${j.code}`);
    const d = j.data;
    const r = midOrLast(toNum(d.bestBid), toNum(d.bestAsk), toNum(d.price), cfg);
    if (!r) throw new SourceError('kucoin', 'no usable price fields');
    return { price: r.price, method: r.method, ts: toNum(d.time) || Date.now(), source: 'KuCoin' };
  },
  async coinbase(cfg) {
    const j = await httpJson('https://api.exchange.coinbase.com/products/BTC-USDT/ticker', {}, cfg);
    const r = midOrLast(toNum(j.bid), toNum(j.ask), toNum(j.price), cfg);
    if (!r) throw new SourceError('coinbase', 'no usable price fields');
    const ts = j.time ? Date.parse(j.time) : Date.now();
    return { price: r.price, method: r.method, ts: Number.isFinite(ts) ? ts : Date.now(), source: 'Coinbase Exchange' };
  },
};

/* ----------------------------------------------------------- GOLD adapters */

/** Candidate identifiers for one gram of 18-karat (750) gold, in Toman. */
const BRSAPI_GOLD18_SYMBOLS = ['IR_GOLD_18K', 'IR_GOLD_18', 'GOLD_18K', '18K'];
const BRSAPI_GOLD18_NAME_HINTS = ['18 عیار', '۱۸ عیار', '18عیار', '750'];
/** Must never match: these are different instruments. */
const GOLD_EXCLUDE_HINTS = ['مثقال', 'آب‌شده', 'آبشده', 'اونس', '24 عیار', '۲۴ عیار', 'سکه'];

function looksLikeGram18(name) {
  const s = String(name || '');
  if (GOLD_EXCLUDE_HINTS.some((x) => s.includes(x))) return false;
  return BRSAPI_GOLD18_NAME_HINTS.some((x) => s.includes(x));
}

const GOLD_ADAPTERS = {
  async brsapi(cfg) {
    if (!cfg.brsapiKey) throw new SourceError('brsapi', 'no API key configured (set BRSAPI_KEY to enable)');
    const url = `https://Api.BrsApi.ir/Market/Gold_Currency.php?key=${encodeURIComponent(cfg.brsapiKey)}`;
    const j = await httpJson(url, {}, cfg);
    const list = Array.isArray(j) ? j : Array.isArray(j.gold) ? j.gold : null;
    if (!list) throw new SourceError('brsapi', 'no gold array in payload');

    let hit = list.find((x) => x && BRSAPI_GOLD18_SYMBOLS.includes(String(x.symbol || '').toUpperCase()));
    if (!hit) hit = list.find((x) => x && (looksLikeGram18(x.name) || looksLikeGram18(x.name_en)));
    if (!hit) throw new SourceError('brsapi', 'gram-18k entry not found; run diagnose to dump symbols');

    const price = toNum(hit.price);
    if (price === null || price <= 0) throw new SourceError('brsapi', 'gram-18k price not numeric');

    // BrsAPI publishes IRR/Toman per entry in a `unit` field. Treat an explicit
    // rial unit as rial; anything else is taken as Toman, which is its default.
    const unit = String(hit.unit || '').trim();
    const isRial = unit.includes('ریال') || unit.toUpperCase() === 'IRR';
    const toman = isRial ? price / 10 : price;

    const tsUnix = toNum(hit.time_unix);
    return {
      price: toman,
      method: 'published_gram18_quote',
      ts: tsUnix ? tsUnix * 1000 : Date.now(),
      source: 'BrsAPI (گرم طلای ۱۸ عیار)',
      raw_unit: unit || 'unspecified',
    };
  },

  async tgju(cfg) {
    // UNOFFICIAL internal endpoint of tgju.org. No contract, no versioning.
    // `geram18` is the "طلای ۱۸ عیار / ۷۵۰" series, quoted in RIAL.
    // Explicitly NOT `mesghal`, NOT `geram24`, NOT the melted-gold series.
    const j = await httpJson('https://call1.tgju.org/ajax.json', { headers: { Accept: '*/*' } }, cfg);
    const node = j && j.current && j.current.geram18 ? j.current.geram18 : null;
    if (!node) throw new SourceError('tgju', 'geram18 key missing from ajax.json');
    const rial = toNum(String(node.p ?? node.price ?? '').replace(/,/g, ''));
    if (rial === null || rial <= 0) throw new SourceError('tgju', 'geram18 price not numeric');
    let ts = Date.now();
    if (node.ts) {
      const parsed = Date.parse(node.ts);
      if (Number.isFinite(parsed)) ts = parsed;
    }
    return {
      price: rial / 10, // RIAL -> TOMAN
      method: 'tgju_geram18_rial_div10',
      ts,
      source: 'TGJU (طلای ۱۸ عیار / ۷۵۰)',
      raw_unit: 'ریال',
    };
  },
};

/* ------------------------------------------------------- USDT/IRT adapters */

const USDT_ADAPTERS = {
  async nobitex(cfg) {
    const j = await httpJson(
      'https://api.nobitex.ir/market/stats',
      { method: 'POST', body: { srcCurrency: 'usdt', dstCurrency: 'rls' } },
      cfg
    );
    const s = j && j.stats && j.stats['usdt-rls'];
    if (!s) throw new SourceError('nobitex', 'usdt-rls stats missing');
    const bid = toNum(s.bestBuy); // highest price a buyer will pay
    const ask = toNum(s.bestSell); // lowest price a seller will accept
    const last = toNum(s.latest);
    const r = midOrLast(bid, ask, last, cfg);
    if (!r) throw new SourceError('nobitex', 'no usable price fields');
    return {
      price: r.price / 10, // RIAL -> TOMAN
      method: r.method,
      ts: Date.now(),
      source: 'نوبیتکس',
      market_closed: s.isClosed === true,
      spreadPct: r.spreadPct,
    };
  },

  async wallex(cfg) {
    const j = await httpJson('https://api.wallex.ir/v1/depth?symbol=USDTTMN', {}, cfg);
    const book = j && j.result ? j.result.USDTTMN || j.result : null;
    if (!book || !Array.isArray(book.ask) || !Array.isArray(book.bid)) {
      throw new SourceError('wallex', 'USDTTMN depth missing ask/bid arrays');
    }
    const ask = toNum(book.ask[0] && book.ask[0].price);
    const bid = toNum(book.bid[0] && book.bid[0].price);
    const r = midOrLast(bid, ask, null, cfg);
    if (!r) throw new SourceError('wallex', 'empty order book');
    return { price: r.price, method: r.method, ts: Date.now(), source: 'والکس', spreadPct: r.spreadPct };
  },
};

/* ------------------------------------------------------------ public entry */

const CHAINS = {
  [ASSETS.BTC_USDT]: { adapters: BTC_ADAPTERS, orderKey: 'btcOrder' },
  [ASSETS.GOLD18]: { adapters: GOLD_ADAPTERS, orderKey: 'goldOrder' },
  [ASSETS.USDT_IRT]: { adapters: USDT_ADAPTERS, orderKey: 'usdtOrder' },
};

export function chainFor(asset, cfg = DEFAULT_CONFIG) {
  const c = CHAINS[asset];
  if (!c) return [];
  return cfg[c.orderKey] || DEFAULT_CONFIG[c.orderKey];
}

/**
 * Walk the fallback chain for one asset. Returns
 *   { ok:true, asset, price, source, method, ts, adapter, attempts }
 *   { ok:false, asset, attempts }   when every source in the chain failed
 * Never throws.
 */
export async function fetchAssetPrice(asset, cfg = DEFAULT_CONFIG) {
  const conf = { ...DEFAULT_CONFIG, ...cfg };
  const c = CHAINS[asset];
  if (!c) return { ok: false, asset, attempts: [{ adapter: 'none', error: 'unknown asset' }] };

  const order = conf[c.orderKey] || DEFAULT_CONFIG[c.orderKey];
  const attempts = [];
  for (const name of order) {
    const adapter = c.adapters[name];
    if (!adapter) {
      attempts.push({ adapter: name, error: 'adapter not implemented' });
      continue;
    }
    try {
      const r = await adapter(conf);
      if (!Number.isFinite(r.price) || r.price <= 0) throw new SourceError(name, 'non-positive price');
      attempts.push({ adapter: name, ok: true });
      return { ok: true, asset, adapter: name, attempts, ...r };
    } catch (e) {
      attempts.push({ adapter: name, error: String((e && e.message) || e) });
    }
  }
  return { ok: false, asset, attempts };
}

/** Fetch all three assets concurrently. Worker free plan allows 6 concurrent connections. */
export async function fetchAllPrices(cfg = DEFAULT_CONFIG) {
  const assets = [ASSETS.BTC_USDT, ASSETS.GOLD18, ASSETS.USDT_IRT];
  const results = await Promise.all(assets.map((a) => fetchAssetPrice(a, cfg)));
  const out = {};
  assets.forEach((a, i) => {
    out[a] = results[i];
  });
  return out;
}

/* ----------------------------------------------------- BTC daily klines ---
 * Used only for PCT_CHANGE_7D and PCT_CHANGE_30D. One call covers both windows.
 * Returns ascending [{ ts, close }] or throws after exhausting the chain.
 */
export async function fetchBtcDailyCloses(cfg = DEFAULT_CONFIG) {
  const conf = { ...DEFAULT_CONFIG, ...cfg };
  const attempts = [];

  try {
    const j = await httpJson('https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=40', {}, conf);
    if (j.code === '0' && Array.isArray(j.data) && j.data.length) {
      // OKX row: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm], newest first
      const rows = j.data
        .map((r) => ({ ts: toNum(r[0]), close: toNum(r[4]) }))
        .filter((r) => r.ts && r.close)
        .sort((a, b) => a.ts - b.ts);
      if (rows.length) return { ok: true, adapter: 'okx', source: 'OKX', rows, attempts };
    }
    attempts.push({ adapter: 'okx', error: `bad payload code=${j.code}` });
  } catch (e) {
    attempts.push({ adapter: 'okx', error: String((e && e.message) || e) });
  }

  try {
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - 40 * 86400;
    const j = await httpJson(
      `https://api.kucoin.com/api/v1/market/candles?type=1day&symbol=BTC-USDT&startAt=${startAt}&endAt=${endAt}`,
      {},
      conf
    );
    if (j.code === '200000' && Array.isArray(j.data) && j.data.length) {
      // KuCoin row: [time(sec), open, close, high, low, volume, turnover], newest first
      const rows = j.data
        .map((r) => ({ ts: toNum(r[0]) * 1000, close: toNum(r[2]) }))
        .filter((r) => r.ts && r.close)
        .sort((a, b) => a.ts - b.ts);
      if (rows.length) return { ok: true, adapter: 'kucoin', source: 'KuCoin', rows, attempts };
    }
    attempts.push({ adapter: 'kucoin', error: `bad payload code=${j.code}` });
  } catch (e) {
    attempts.push({ adapter: 'kucoin', error: String((e && e.message) || e) });
  }

  return { ok: false, rows: [], attempts };
}
