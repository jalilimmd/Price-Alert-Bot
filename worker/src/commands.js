/**
 * Command surface for the Worker tier.
 *
 * Every handler returns a plain object { text, reply_markup? } or an array of
 * them. No handler throws: validation failures become user-facing Persian
 * sentences that name the specific problem and show a correct example.
 */

import {
  ASSETS,
  ASSET_META,
  ASSET_TYPE_MATRIX,
  TYPE_META,
  LIMITS,
  DEFAULTS,
  resolveAsset,
  resolveType,
  validateAlertInput,
  newAlertId,
  newAlertRecord,
  effectiveStatus,
  DISABLED_REASON_FA,
  isPercentType,
} from './schema.js';
import { fmtPrice, fmtBound, fmtNumber, fmtTehran, fmtAgo, toFaDigits, escapeHtml } from './format.js';
import { fetchAllPrices, DEFAULT_CONFIG } from './sources.js';
import { readState, updateAlerts } from './gist.js';
import { alertKeyboard } from './telegram.js';

/** Alerts are evaluated on a 5-minute cron that GitHub delays 5–20 min at peak. */
export const LATENCY_NOTICE =
  '⏱ <b>نکتهٔ مهم دربارهٔ تأخیر</b>\n' +
  'پاسخ دستورها فوری است، اما قیمت‌ها روی زمان‌بندی بررسی می‌شوند. ' +
  'کران زمان‌بندی هر ۵ دقیقه است، ولی GitHub Actions در ساعات شلوغ تأخیر دارد، ' +
  'بنابراین <b>هشدار قیمت ممکن است تا ۲۰ دقیقه دیرتر برسد</b>. ' +
  'این ربات برای رصد و اطلاع‌رسانی است، نه برای معامله‌گری لحظه‌ای.';

const NO_ADVICE =
  'ℹ️ این ربات فقط قیمت را رصد و اطلاع‌رسانی می‌کند. هیچ توصیهٔ مالی، سیگنال معاملاتی یا پیش‌بینی قیمتی ارائه نمی‌دهد.';

/* --------------------------------------------------------------- parsing */

const DIGIT_MAP = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export function normalizeDigits(s) {
  return String(s).replace(/[۰-۹٠-٩]/g, (d) => DIGIT_MAP[d] || d);
}

/**
 * Accepts 70000, 70,000, 70_000, 18.8m, 1.2k, -5, ‎−5 and Persian digits.
 * Returns null when the token is not a number.
 */
export function parseNum(raw) {
  if (raw === null || raw === undefined) return null;
  let s = normalizeDigits(String(raw).trim())
    .replace(/[\u2212\u2013\u2014]/g, '-') // minus sign, en/em dash
    .replace(/[,\u066C\u060C_\s]/g, ''); // comma, Arabic thousands sep, Arabic comma, underscore
  if (!s) return null;
  let mult = 1;
  const m = s.match(/^(-?\d*\.?\d+)([kmb])$/i);
  if (m) {
    s = m[1];
    mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
  }
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : null;
}

export function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[0].slice(1).split('@')[0].toLowerCase();
  const args = [];
  const flags = {};
  for (const t of tokens.slice(1)) {
    const eq = t.indexOf('=');
    if (eq > 0) {
      flags[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
    } else {
      args.push(t);
    }
  }
  return { cmd, args, flags, raw: trimmed };
}

/* -------------------------------------------------------------- rendering */

function assetLine(asset) {
  const m = ASSET_META[asset];
  return `<b>${escapeHtml(m.faShort)}</b> — ${escapeHtml(m.faLong)}`;
}

function statusBadge(alert, rt) {
  const st = effectiveStatus(alert, rt);
  if (st.systemDisabled) {
    const reason = DISABLED_REASON_FA[st.disabledReason] || st.disabledReason || 'نامشخص';
    return `🔴 غیرفعال شده توسط سیستم (${escapeHtml(reason)})`;
  }
  if (st.paused) return '⏸ متوقف‌شده توسط شما';
  if (!st.evaluated) return '🟡 فعال — هنوز بررسی نشده';
  return st.armed ? '🟢 فعال — آمادهٔ شلیک' : '🟢 فعال — منتظر بازگشت به محدودهٔ عادی';
}

function renderAlert(alert, rt) {
  const meta = ASSET_META[alert.asset];
  const tmeta = TYPE_META[alert.type];
  const st = effectiveStatus(alert, rt);
  const lines = [];
  lines.push(`<b>#${escapeHtml(alert.id)}</b> — ${escapeHtml(meta.faShort)} — ${escapeHtml(tmeta.fa)}`);
  const bounds = [];
  if (alert.lower_bound !== null) bounds.push(`زیر ${fmtBound(alert.asset, alert.type, alert.lower_bound)}`);
  if (alert.upper_bound !== null) bounds.push(`بالای ${fmtBound(alert.asset, alert.type, alert.upper_bound)}`);
  lines.push(`کران‌ها: ${bounds.join('  یا  ')}`);
  lines.push(statusBadge(alert, rt));
  lines.push(
    `شلیک‌ها: ${toFaDigits(st.triggerCount)}/${toFaDigits(alert.max_triggers)} · ` +
      `فاصلهٔ حداقلی: ${toFaDigits(alert.cooldown_minutes)} دقیقه · ` +
      `انقضا: ${toFaDigits(alert.expires_after_days)} روز`
  );
  if (rt && rt.last_triggered_at) lines.push(`آخرین شلیک: ${fmtTehran(rt.last_triggered_at)}`);
  if (rt && rt.last_evaluated_at) {
    const v = rt.last_value;
    const valTxt = v === null || v === undefined ? '—' : fmtBound(alert.asset, alert.type, v);
    lines.push(`آخرین بررسی: ${fmtAgo(rt.last_evaluated_at)} · مقدار: ${valTxt}`);
  }
  if (rt && rt.last_skip_reason) lines.push(`<i>آخرین رد شدن: ${escapeHtml(rt.last_skip_reason)}</i>`);
  return lines.join('\n');
}

/* --------------------------------------------------------------- handlers */

export function cmdStart() {
  return {
    text:
      '👋 <b>ربات هشدار قیمت</b>\n\n' +
      'سه دارایی رصد می‌شود:\n' +
      `• ${assetLine(ASSETS.BTC_USDT)}\n` +
      `• ${assetLine(ASSETS.GOLD18)}\n` +
      `• ${assetLine(ASSETS.USDT_IRT)}\n\n` +
      'برای شروع:\n' +
      '<code>/price</code> — قیمت لحظه‌ای هر سه\n' +
      '<code>/add btc abs above=70000</code> — یک هشدار نمونه\n' +
      '<code>/help</code> — راهنمای کامل\n\n' +
      LATENCY_NOTICE +
      '\n\n' +
      NO_ADVICE,
  };
}

export function cmdHelp() {
  const matrixRows = Object.keys(ASSET_TYPE_MATRIX)
    .map((a) => `• ${ASSET_META[a].faShort}: <code>${ASSET_TYPE_MATRIX[a].map((t) => shortType(t)).join(' ')}</code>`)
    .join('\n');

  return {
    text:
      '<b>راهنمای کامل</b>\n\n' +
      '<b>۱) دستورها</b>\n' +
      '<code>/price</code> — قیمت لحظه‌ای هر سه دارایی\n' +
      '<code>/list</code> — هشدارهای شما با وضعیت مؤثر\n' +
      '<code>/add &lt;دارایی&gt; &lt;نوع&gt; [below=x] [above=y] [cooldown=m] [max=n] [expires=d] [hyst=h]</code>\n' +
      '<code>/del &lt;id&gt;</code> · <code>/pause &lt;id&gt;</code> · <code>/resume &lt;id&gt;</code>\n\n' +
      '<b>۲) دارایی‌ها</b>\n' +
      '<code>btc</code> = BTC/USDT · <code>gold</code> = یک گرم طلای ۱۸ عیار (۷۵۰) به تومان · <code>usdt</code> = تتر/تومان\n' +
      '⚠️ <code>gold</code> فقط «گرم طلای ۱۸ عیار» است؛ مثقال یا آب‌شده نیست.\n\n' +
      '<b>۳) انواع هشدار</b>\n' +
      '<code>abs</code> رسیدن به قیمت مشخص · <code>30m</code> <code>4h</code> <code>24h</code> <code>7d</code> <code>30d</code> تغییر درصدی\n' +
      'انواع مجاز برای هر دارایی:\n' +
      matrixRows +
      '\n<i>۷ روز و ۳۰ روز فقط برای بیت‌کوین موجود است، چون از کندل‌های صرافی خوانده می‌شود. ' +
      'هیچ منبع رایگان ایرانی تاریخچهٔ ۷/۳۰ روزهٔ طلا و تتر را نمی‌دهد.</i>\n\n' +
      '<b>۴) کران‌ها</b>\n' +
      'دست‌کم یکی از <code>below=</code> یا <code>above=</code> لازم است؛ اگر هر دو باشند با «یا» ترکیب می‌شوند.\n' +
      'در <code>abs</code> کران‌ها قیمت‌اند. در انواع درصدی، کران‌ها درصد علامت‌دار هستند (مثلاً <code>below=-5 above=8</code>).\n\n' +
      '<b>۵) رفتار شلیک</b>\n' +
      'هشدار «لبه‌ای» است: فقط در لحظهٔ عبور از کران شلیک می‌کند، نه در تمام مدتی که آن‌طرف کران مانده.\n' +
      `دوباره مسلح شدن وقتی است که مقدار به اندازهٔ حاشیهٔ ${toFaDigits(DEFAULTS.hysteresis_pct)}٪ کران به محدودهٔ عادی برگردد (با <code>hyst=</code> قابل تغییر).\n` +
      `<code>cooldown</code> کف مستقلی است: حداکثر یک اعلان در هر بازه (پیش‌فرض ${toFaDigits(DEFAULTS.cooldown_minutes)} دقیقه).\n` +
      `پس از <code>max</code> بار شلیک (پیش‌فرض ${toFaDigits(DEFAULTS.max_triggers)}) یا پس از <code>expires</code> روز (پیش‌فرض ${toFaDigits(DEFAULTS.expires_after_days)}) هشدار خودکار غیرفعال می‌شود.\n\n` +
      '<b>۶) مثال‌ها</b>\n' +
      '<code>/add btc abs above=70000</code>\n' +
      '<code>/add gold abs above=19,500,000 below=17m</code>\n' +
      '<code>/add usdt 24h below=-3 above=3 cooldown=60</code>\n' +
      '<code>/add btc 7d above=15 max=1</code>\n' +
      '<code>/del a1b2c3d</code>\n\n' +
      'اعداد را می‌توانید با کاما، زیرخط، پسوند <code>k</code>/<code>m</code> یا با ارقام فارسی بنویسید.\n\n' +
      LATENCY_NOTICE +
      '\n\n' +
      NO_ADVICE,
  };
}

function shortType(t) {
  return (
    { ABSOLUTE_TARGET: 'abs', PCT_CHANGE_30M: '30m', PCT_CHANGE_4H: '4h', PCT_CHANGE_24H: '24h', PCT_CHANGE_7D: '7d', PCT_CHANGE_30D: '30d' }[
      t
    ] || t
  );
}

export async function cmdPrice(env) {
  const cfg = { ...DEFAULT_CONFIG, retries: 0, timeoutMs: 3500, brsapiKey: env.BRSAPI_KEY || '' };
  const all = await fetchAllPrices(cfg);
  const lines = ['<b>قیمت لحظه‌ای</b> — گرفته‌شده همین الان توسط Worker', ''];

  for (const asset of [ASSETS.BTC_USDT, ASSETS.GOLD18, ASSETS.USDT_IRT]) {
    const r = all[asset];
    const meta = ASSET_META[asset];
    if (r && r.ok) {
      lines.push(`<b>${escapeHtml(meta.faShort)}</b>`);
      lines.push(`${fmtPrice(asset, r.price)}`);
      lines.push(`<i>منبع: ${escapeHtml(r.source)} · روش: ${escapeHtml(methodFa(r.method))}</i>`);
    } else {
      const why = (r && r.attempts ? r.attempts.map((a) => a.adapter).join(' → ') : 'نامشخص');
      lines.push(`<b>${escapeHtml(meta.faShort)}</b>`);
      lines.push(`❌ در دسترس نیست — همهٔ منابع زنجیره ناموفق بودند (${escapeHtml(why)})`);
    }
    lines.push('');
  }
  lines.push(`<i>${escapeHtml(ASSET_META.GOLD18.faLong)}</i>`);
  lines.push(`زمان: ${fmtTehran(Date.now())} به وقت تهران`);
  return { text: lines.join('\n') };
}

function methodFa(m) {
  return (
    {
      mid_of_best_bid_ask: 'میانگین بهترین خرید و فروش',
      mid_of_best_bid_ask_wide: 'میانگین بهترین خرید و فروش (اسپرد زیاد)',
      last_trade: 'آخرین معامله',
      last_trade_wide_spread: 'آخرین معامله (اسپرد غیرعادی)',
      published_gram18_quote: 'نرخ منتشرشدهٔ گرم ۱۸ عیار',
      tgju_geram18_rial_div10: 'نرخ گرم ۱۸ عیار (ریال ÷ ۱۰)',
    }[m] || m
  );
}

export async function cmdList(env, chatId) {
  let state;
  try {
    state = await readState(env);
  } catch (e) {
    return { text: `❌ خواندن Gist ناموفق بود: ${escapeHtml(String(e.message || e))}` };
  }
  if (!state.alerts) {
    return { text: '❌ فایل alerts.json خوانده نشد (خراب یا با نسخهٔ جدیدتر نوشته شده).' };
  }

  const mine = state.alerts.alerts.filter((a) => String(a.chat_id) === String(chatId));
  if (!mine.length) {
    return { text: 'هیچ هشداری ندارید.\nنمونه: <code>/add gold abs above=19,500,000</code>' };
  }

  const messages = [];
  const header = state.runtimeExists
    ? `<b>هشدارهای شما</b> (${toFaDigits(mine.length)})`
    : `<b>هشدارهای شما</b> (${toFaDigits(mine.length)})\n⚠️ فایل runtime.json هنوز وجود ندارد — یعنی تِیر ارزیابی (GitHub Actions) هنوز اجرا نشده است. تا آن زمان هیچ هشداری شلیک نمی‌شود.`;
  messages.push({ text: header });

  for (const a of mine) {
    const rt = state.runtime.alerts[a.id] || null;
    const st = effectiveStatus(a, rt);
    messages.push({
      text: renderAlert(a, rt),
      reply_markup: st.systemDisabled ? undefined : alertKeyboard(a, st.paused),
    });
  }
  return messages;
}

export async function cmdAdd(env, chatId, parsed) {
  const [assetRaw, typeRaw] = parsed.args;
  const asset = resolveAsset(assetRaw);
  const type = resolveType(typeRaw);

  if (!asset) {
    return {
      text:
        `❌ دارایی «${escapeHtml(String(assetRaw ?? ''))}» شناخته نشد.\n` +
        'دارایی‌های معتبر: <code>btc</code> · <code>gold</code> · <code>usdt</code>\n' +
        'مثال درست: <code>/add gold abs above=19,500,000</code>',
    };
  }
  if (!type) {
    return {
      text:
        `❌ نوع هشدار «${escapeHtml(String(typeRaw ?? ''))}» شناخته نشد.\n` +
        'انواع معتبر: <code>abs</code> <code>30m</code> <code>4h</code> <code>24h</code> <code>7d</code> <code>30d</code>\n' +
        'مثال درست: <code>/add btc 24h below=-5 above=5</code>',
    };
  }

  const nums = {};
  for (const [flag, field] of [
    ['below', 'lower'],
    ['above', 'upper'],
    ['cooldown', 'cooldown'],
    ['max', 'max'],
    ['expires', 'expires'],
    ['hyst', 'hyst'],
  ]) {
    if (parsed.flags[flag] === undefined) {
      nums[field] = null;
      continue;
    }
    const v = parseNum(parsed.flags[flag]);
    if (v === null) {
      return {
        text:
          `❌ مقدار <code>${escapeHtml(flag)}=${escapeHtml(parsed.flags[flag])}</code> عدد معتبری نیست.\n` +
          'مثال درست: <code>/add usdt 4h below=-2.5 above=2.5</code>',
      };
    }
    nums[field] = v;
  }

  const v = validateAlertInput({ asset, type, ...nums });
  if (!v.ok) {
    return { text: `❌ ${escapeHtml(v.error)}\n\nمثال درست: <code>/add btc abs above=70000</code>` };
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = newAlertId(bytes);
  const nowIso = new Date().toISOString();

  const res = await updateAlerts(env, (doc) => {
    const mine = doc.alerts.filter((a) => String(a.chat_id) === String(chatId));
    if (mine.length >= LIMITS.alerts_per_chat) {
      return { error: `به سقف ${LIMITS.alerts_per_chat} هشدار برای این گفتگو رسیده‌اید. ابتدا یکی را با /del حذف کنید.` };
    }
    if (doc.alerts.length >= LIMITS.alerts_total) {
      return { error: `به سقف کل ${LIMITS.alerts_total} هشدار رسیده‌اید.` };
    }
    if (doc.alerts.some((a) => a.id === id)) return { error: 'برخورد شناسه رخ داد؛ دوباره تلاش کنید.' };

    const record = newAlertRecord({ id, chatId, nowIso, ...v.value });
    doc.alerts.push(record);
    return { doc, result: record, verify: (after) => after.alerts.some((a) => a.id === id) };
  });

  if (res.userError) return { text: `❌ ${escapeHtml(res.userError)}` };
  if (!res.ok) return { text: `❌ ثبت هشدار ناموفق بود: ${escapeHtml(String(res.error))}\nهیچ چیزی تغییر نکرد؛ دوباره تلاش کنید.` };

  const a = res.result;
  const bounds = [];
  if (a.lower_bound !== null) bounds.push(`زیر ${fmtBound(a.asset, a.type, a.lower_bound)}`);
  if (a.upper_bound !== null) bounds.push(`بالای ${fmtBound(a.asset, a.type, a.upper_bound)}`);

  return {
    text:
      `✅ هشدار ثبت شد — <b>#${escapeHtml(a.id)}</b>\n` +
      `${escapeHtml(ASSET_META[a.asset].faLong)}\n` +
      `نوع: ${escapeHtml(TYPE_META[a.type].fa)}\n` +
      `کران‌ها: ${bounds.join('  یا  ')}\n` +
      `فاصلهٔ حداقلی ${toFaDigits(a.cooldown_minutes)} دقیقه · حداکثر ${toFaDigits(a.max_triggers)} شلیک · انقضا ${toFaDigits(
        a.expires_after_days
      )} روز\n\n` +
      (isPercentType(a.type)
        ? '⚠️ هشدارهای درصدی تا وقتی تاریخچهٔ کافی جمع نشده باشد نادیده گرفته می‌شوند و پیام نمی‌دهند.\n\n'
        : '') +
      LATENCY_NOTICE,
    reply_markup: alertKeyboard(a, false),
  };
}

export async function cmdDelete(env, chatId, id) {
  if (!id) return { text: '❌ شناسه لازم است. مثال: <code>/del a1b2c3d</code>' };
  const res = await updateAlerts(env, (doc) => {
    const idx = doc.alerts.findIndex((a) => a.id === id && String(a.chat_id) === String(chatId));
    if (idx === -1) return { error: `هشداری با شناسهٔ «${id}» برای شما پیدا نشد. با /list فهرست را ببینید.` };
    const [removed] = doc.alerts.splice(idx, 1);
    return { doc, result: removed, verify: (after) => !after.alerts.some((a) => a.id === id) };
  });
  if (res.userError) return { text: `❌ ${escapeHtml(res.userError)}` };
  if (!res.ok) return { text: `❌ حذف ناموفق بود: ${escapeHtml(String(res.error))}` };
  return {
    text: `🗑 هشدار <b>#${escapeHtml(id)}</b> حذف شد.\n<i>وضعیت اجرایی آن در اجرای بعدی تِیر ارزیابی پاک‌سازی می‌شود.</i>`,
  };
}

export async function cmdToggle(env, chatId, id, enabled) {
  if (!id) return { text: `❌ شناسه لازم است. مثال: <code>/${enabled ? 'resume' : 'pause'} a1b2c3d</code>` };
  const res = await updateAlerts(env, (doc) => {
    const a = doc.alerts.find((x) => x.id === id && String(x.chat_id) === String(chatId));
    if (!a) return { error: `هشداری با شناسهٔ «${id}» برای شما پیدا نشد.` };
    if (a.enabled === enabled) return { result: a, noWrite: true };
    a.enabled = enabled;
    return { doc, result: a, verify: (after) => after.alerts.some((x) => x.id === id && x.enabled === enabled) };
  });
  if (res.userError) return { text: `❌ ${escapeHtml(res.userError)}` };
  if (!res.ok) return { text: `❌ تغییر وضعیت ناموفق بود: ${escapeHtml(String(res.error))}` };
  return {
    text: enabled
      ? `▶️ هشدار <b>#${escapeHtml(id)}</b> از سر گرفته شد.\n<i>توجه: اگر سیستم آن را غیرفعال کرده باشد (سقف شلیک یا انقضا)، همچنان غیرفعال می‌ماند.</i>`
      : `⏸ هشدار <b>#${escapeHtml(id)}</b> متوقف شد.`,
  };
}

/* ------------------------------------------------------------- dispatcher */

export async function dispatch(env, chatId, text) {
  const parsed = parseCommand(text);
  if (!parsed) {
    return { text: 'دستور شناخته نشد. برای راهنما <code>/help</code> را بفرستید.' };
  }
  switch (parsed.cmd) {
    case 'start':
      return cmdStart();
    case 'help':
      return cmdHelp();
    case 'price':
      return cmdPrice(env);
    case 'list':
      return cmdList(env, chatId);
    case 'add':
      return cmdAdd(env, chatId, parsed);
    case 'del':
    case 'delete':
    case 'rm':
      return cmdDelete(env, chatId, parsed.args[0]);
    case 'pause':
      return cmdToggle(env, chatId, parsed.args[0], false);
    case 'resume':
      return cmdToggle(env, chatId, parsed.args[0], true);
    default:
      return {
        text: `❌ دستور <code>/${escapeHtml(parsed.cmd)}</code> وجود ندارد.\nدستورهای موجود: /start /help /price /list /add /del /pause /resume`,
      };
  }
}

/** Inline-keyboard callbacks. Format: "action:alertId". No conversation state. */
export async function handleCallback(env, chatId, data) {
  const [action, id] = String(data || '').split(':');
  if (!action || !id) return { text: 'دکمهٔ نامعتبر.', toast: 'نامعتبر' };
  switch (action) {
    case 'pause': {
      const r = await cmdToggle(env, chatId, id, false);
      return { ...r, toast: 'متوقف شد' };
    }
    case 'resume': {
      const r = await cmdToggle(env, chatId, id, true);
      return { ...r, toast: 'از سر گرفته شد' };
    }
    case 'del': {
      const r = await cmdDelete(env, chatId, id);
      return { ...r, toast: 'حذف شد' };
    }
    default:
      return { text: 'دکمهٔ ناشناخته.', toast: 'ناشناخته' };
  }
}
