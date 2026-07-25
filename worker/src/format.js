/* ============================================================
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: shared/format.js
 * Regenerate with:  npm run sync
 * ============================================================ */
/**
 * CANONICAL SHARED FORMATTING — single source of truth.
 *
 * DO NOT EDIT THE COPIES. Edit this file, then run:  npm run sync
 *
 * All grouping and digit conversion is done by hand rather than via Intl, so
 * that output is byte-identical between the Cloudflare Workers runtime and Node
 * regardless of which ICU build each ships. Only the timezone conversion uses
 * Intl, and it has a fixed-offset fallback (Iran has had no DST since 2022).
 */

import { ASSET_META } from './schema.js';

export const TEHRAN_TZ = 'Asia/Tehran';
const TEHRAN_FALLBACK_OFFSET_MIN = 210; // UTC+03:30

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function toFaDigits(s) {
  return String(s).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** Group the integer part in threes. Works on any magnitude without Intl. */
function group(intStr) {
  const neg = intStr.startsWith('-');
  const digits = neg ? intStr.slice(1) : intStr;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return (neg ? '\u2212' : '') + out; // U+2212 MINUS SIGN renders correctly in RTL
}

/**
 * @param {number} n
 * @param {number} decimals
 * @param {{fa?: boolean}} [opts]  fa=true renders Persian digits (default true)
 */
export function fmtNumber(n, decimals = 0, opts = {}) {
  const fa = opts.fa !== false;
  if (!Number.isFinite(n)) return fa ? 'نامعلوم' : 'n/a';
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  let s = group((n < 0 ? '-' : '') + intPart);
  if (decPart) s += '.' + decPart;
  return fa ? toFaDigits(s) : s;
}

/** Signed percentage, always with an explicit + or −, two decimals. */
export function fmtPct(n, opts = {}) {
  const fa = opts.fa !== false;
  if (!Number.isFinite(n)) return fa ? 'نامعلوم' : 'n/a';
  const sign = n > 0 ? '+' : n < 0 ? '\u2212' : '';
  const body = Math.abs(n).toFixed(2);
  const [i, d] = body.split('.');
  const s = `${sign}${group(i)}.${d}٪`;
  return fa ? toFaDigits(s) : s;
}

/** Price with the asset's own precision and quote-currency label. */
export function fmtPrice(asset, value, opts = {}) {
  const meta = ASSET_META[asset];
  if (!meta) return fmtNumber(value, 2, opts);
  return `${fmtNumber(value, meta.decimals, opts)} ${meta.quoteFa}`;
}

/** Bound formatted according to what the alert type means by a bound. */
export function fmtBound(asset, type, value, opts = {}) {
  if (value === null || value === undefined) return '—';
  return type === 'ABSOLUTE_TARGET' ? fmtPrice(asset, value, opts) : fmtPct(value, opts);
}

function tehranParts(date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: TEHRAN_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
    if (p.year && p.month && p.day) return p;
  } catch {
    /* fall through to fixed offset */
  }
  const shifted = new Date(date.getTime() + TEHRAN_FALLBACK_OFFSET_MIN * 60000);
  const pad = (x) => String(x).padStart(2, '0');
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
  };
}

/** "1405/05/02 14:37" in Tehran local time. Gregorian, to stay unambiguous in logs. */
export function fmtTehran(input, opts = {}) {
  const fa = opts.fa !== false;
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return fa ? 'نامعلوم' : 'n/a';
  const p = tehranParts(d);
  const s = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return fa ? toFaDigits(s) : s;
}

/** Compact relative age, e.g. "۱۲ دقیقه پیش". */
export function fmtAgo(input, now = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return 'نامعلوم';
  const mins = Math.max(0, Math.round((now - d.getTime()) / 60000));
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${toFaDigits(mins)} دقیقه پیش`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${toFaDigits(hours)} ساعت پیش`;
  return `${toFaDigits(Math.round(hours / 24))} روز پیش`;
}

/** Telegram MarkdownV2 is unforgiving; we send plain text and only escape HTML. */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
