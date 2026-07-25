/**
 * User-facing message construction for the ACTIONS tier.
 *
 * Every alert message states, without exception:
 *   - the trigger reason (which bound, in which direction, with both numbers)
 *   - the timestamp, in Asia/Tehran
 *   - the price source that produced the number
 *
 * All numbers carry thousands separators. The gold asset repeats "one gram of
 * 18-karat" in full every single time, because "gold" in an Iranian price
 * context most often means mesghal, and a reader who assumes the wrong unit
 * misreads the number by a factor of about 4.6.
 */

import { ASSET_META, TYPE_META, DISABLED_REASON_FA } from './schema.js';
import { fmtPrice, fmtPct, fmtBound, fmtTehran, toFaDigits } from './format.js';

const NO_ADVICE = 'ℹ️ این پیام فقط اطلاع‌رسانی است. توصیهٔ مالی، سیگنال معاملاتی یا پیش‌بینی قیمت نیست.';

function sideWord(side) {
  return side === 'upper' ? 'بالاتر رفت از' : 'پایین‌تر آمد از';
}

/**
 * @param {object} a          alert record
 * @param {object} ctx        { side, bound, value, price, snapshot, baseline, nowMs, triggerCount }
 */
export function buildTriggerMessage(a, ctx) {
  const meta = ASSET_META[a.asset];
  const tmeta = TYPE_META[a.type];
  const isPct = a.type !== 'ABSOLUTE_TARGET';

  const title = `🔔 هشدار قیمت — ${meta.faShort}`;

  const lines = [];
  lines.push(`<b>${meta.faLong}</b>`);
  lines.push('');

  // --- reason -------------------------------------------------------------
  lines.push('<b>دلیل شلیک</b>');
  if (isPct) {
    lines.push(`${tmeta.fa}: ${fmtPct(ctx.value)} — ${sideWord(ctx.side)} کران ${fmtPct(ctx.bound)}`);
    if (ctx.baseline) {
      lines.push(
        `مبنا: ${fmtPrice(a.asset, ctx.baseline.price)} در ${fmtTehran(ctx.baseline.ts)}` +
          ` → اکنون: ${fmtPrice(a.asset, ctx.price)}`
      );
    }
  } else {
    lines.push(`قیمت ${fmtPrice(a.asset, ctx.value)} — ${sideWord(ctx.side)} کران ${fmtBound(a.asset, a.type, ctx.bound)}`);
  }
  lines.push('');

  // --- provenance ---------------------------------------------------------
  lines.push('<b>منبع و زمان</b>');
  lines.push(`منبع قیمت: ${ctx.snapshot.source}`);
  lines.push(`روش: ${methodFa(ctx.snapshot.method)}`);
  lines.push(`زمان بررسی: ${fmtTehran(ctx.nowMs)} به وقت تهران`);
  lines.push('');

  // --- state --------------------------------------------------------------
  lines.push(
    `شناسه: <b>#${a.id}</b> · شلیک ${toFaDigits(ctx.triggerCount)} از ${toFaDigits(a.max_triggers)} · ` +
      `فاصلهٔ حداقلی تا اعلان بعدی: ${toFaDigits(a.cooldown_minutes)} دقیقه`
  );
  lines.push('');
  lines.push(NO_ADVICE);

  return { title, body: lines.join('\n'), tags: ['bell'], priority: 4 };
}

export function buildAutoDisableMessage(a, reason) {
  const meta = ASSET_META[a.asset];
  const why = DISABLED_REASON_FA[reason] || reason;
  return {
    title: `⏹ هشدار #${a.id} غیرفعال شد`,
    body:
      `<b>${meta.faLong}</b>\n` +
      `نوع: ${TYPE_META[a.type].fa}\n` +
      `دلیل: ${why}\n\n` +
      `تعریف هشدار همچنان در فهرست شما هست. برای فعال‌سازی دوباره باید آن را حذف و از نو بسازید، ` +
      `چون سقف شلیک و مهلت هنگام ساخت تعیین می‌شوند.\n` +
      `مثال: <code>/del ${a.id}</code> و سپس ساخت دوباره با <code>/add</code>.`,
    tags: ['stop_sign'],
    priority: 3,
  };
}

export function buildSourceFailureMessage(asset, attempts, consecutiveFailures, nowMs) {
  const meta = ASSET_META[asset] || { faShort: asset, faLong: asset };
  const detail = attempts.map((x) => `• ${x.adapter}: ${x.error || 'ناموفق'}`).join('\n');
  return {
    title: `⚠️ همهٔ منابع قیمت ${meta.faShort} ناموفق بودند`,
    body:
      `<b>${meta.faLong}</b>\n\n` +
      `${toFaDigits(consecutiveFailures)} اجرای پیاپی هیچ منبعی پاسخ نداد.\n\n` +
      `<b>جزئیات زنجیرهٔ پشتیبان</b>\n${detail}\n\n` +
      `زمان: ${fmtTehran(nowMs)} به وقت تهران\n\n` +
      `هشدارهای این دارایی تا برطرف شدن مشکل بررسی نمی‌شوند و هیچ اعلان اشتباهی هم فرستاده نمی‌شود.\n` +
      `برای عیب‌یابی، workflow را با ورودی <code>diagnose</code> اجرا کنید.`,
    tags: ['warning'],
    priority: 4,
  };
}

export function methodFa(m) {
  return (
    {
      mid_of_best_bid_ask: 'میانگین بهترین قیمت خرید و فروش',
      mid_of_best_bid_ask_wide: 'میانگین بهترین خرید و فروش (اسپرد غیرعادی)',
      last_trade: 'آخرین معاملهٔ انجام‌شده',
      last_trade_wide_spread: 'آخرین معامله (به‌دلیل اسپرد غیرعادی)',
      published_gram18_quote: 'نرخ منتشرشدهٔ گرم طلای ۱۸ عیار',
      tgju_geram18_rial_div10: 'نرخ گرم طلای ۱۸ عیار (ریال تقسیم بر ۱۰)',
    }[m] || m
  );
}
