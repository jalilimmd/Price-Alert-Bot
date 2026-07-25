/**
 * TIER 1 — Cloudflare Workers. Telegram webhook receiver.
 *
 * SECURITY, four independent controls:
 *   1. secret_token   registered via setWebhook; every update carries it in the
 *                     X-Telegram-Bot-Api-Secret-Token header. This is the only
 *                     control that AUTHENTICATES the caller. Compared in
 *                     constant time.
 *   2. secret path    the webhook path contains a long random component held in
 *                     a Worker secret. Defence in depth against blind scanning;
 *                     obscurity, not authentication.
 *   3. chat allowlist ALLOWED_CHAT_IDS. chat_id is attacker-controlled data
 *                     inside an authenticated request, so this is
 *                     AUTHORIZATION, not authentication. Unknown ids are
 *                     logged and ignored with no reply.
 *   4. always 200     once an update is authenticated, this Worker answers 200
 *                     no matter what happens internally. A non-200 makes
 *                     Telegram redeliver the same update, which would execute
 *                     the command a second time.
 *
 * The single deliberate exception to (4) is an authentication failure, which
 * returns 401. A request whose secret token does not match is by construction
 * not proven to be Telegram, it never reaches a command handler, so redelivery
 * cannot duplicate anything. Answering 200 there would instead hide a
 * misconfigured secret forever; 401 surfaces it in getWebhookInfo's
 * last_error_message on the very first update. See README, "why I built it
 * this way", decision 5.
 */

import { dispatch, handleCallback } from './commands.js';
import { sendMessage, answerCallbackQuery } from './telegram.js';

const REQUIRED_SECRETS = ['BOT_TOKEN', 'GITHUB_TOKEN', 'GIST_ID', 'WEBHOOK_SECRET_TOKEN', 'WEBHOOK_PATH_SECRET', 'ALLOWED_CHAT_IDS'];

/**
 * Comparison whose running time does not depend on where the first difference
 * is, so it cannot be used to recover the secret one character at a time.
 * charCodeAt() past the end returns NaN, and `NaN | 0` is 0, so the loop is
 * safe for unequal lengths; the length XOR catches those anyway.
 */
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length, 1);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) | 0) ^ (y.charCodeAt(i) | 0);
  return diff === 0;
}

function allowlist(env) {
  return String(env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowed(env, chatId) {
  const list = allowlist(env);
  if (!list.length) return false; // fail closed: an empty allowlist permits nobody
  return list.includes(String(chatId));
}

function missingSecrets(env) {
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}

async function deliver(env, chatId, payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    if (!item || !item.text) continue;
    await sendMessage(env, chatId, item.text, { reply_markup: item.reply_markup });
  }
}

async function processUpdate(env, update) {
  // ---- callback query (inline keyboard button) ----
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
    if (chatId === null || !isAllowed(env, chatId)) {
      console.warn('rejected_callback_chat_id', String(chatId));
      await answerCallbackQuery(env, cq.id, '');
      return;
    }
    let out;
    try {
      out = await handleCallback(env, chatId, cq.data);
    } catch (e) {
      console.error('callback_handler_error', String((e && e.stack) || e));
      out = { text: '❌ خطای داخلی هنگام پردازش دکمه. لطفاً دوباره تلاش کنید.', toast: 'خطا' };
    }
    await answerCallbackQuery(env, cq.id, out.toast || '');
    await deliver(env, chatId, out);
    return;
  }

  // ---- ordinary message ----
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;

  if (!isAllowed(env, chatId)) {
    // Log and ignore. No reply: do not confirm the bot exists to a stranger.
    console.warn('rejected_chat_id', String(chatId), 'text=', String(msg.text || '').slice(0, 40));
    return;
  }

  const text = msg.text || msg.caption || '';
  if (!text.trim()) return;

  let out;
  try {
    out = await dispatch(env, chatId, text);
  } catch (e) {
    console.error('command_handler_error', String((e && e.stack) || e));
    out = {
      text:
        '❌ خطای داخلی هنگام اجرای دستور رخ داد و دستور کامل نشد.\n' +
        'هیچ داده‌ای تغییر نکرده است مگر اینکه پیام تأیید دریافت کرده باشید. دوباره تلاش کنید.',
    };
  }
  await deliver(env, chatId, out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- health probe: no secrets, no state, safe to expose ---
    if (url.pathname === '/health') {
      const missing = missingSecrets(env);
      return new Response(
        JSON.stringify({
          ok: missing.length === 0,
          tier: 'worker',
          missing_secrets: missing,
          allowlist_size: allowlist(env).length,
          time: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --- control 2: secret path ---
    const expectedPath = `/tg/${env.WEBHOOK_PATH_SECRET || ''}`;
    if (!env.WEBHOOK_PATH_SECRET || !safeEqual(url.pathname, expectedPath)) {
      return new Response('not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    // --- control 1: secret token (the only authentication) ---
    const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.WEBHOOK_SECRET_TOKEN || !safeEqual(presented, env.WEBHOOK_SECRET_TOKEN)) {
      console.warn('webhook_secret_mismatch');
      return new Response('unauthorized', { status: 401 });
    }

    // ================= AUTHENTICATED. From here on, always 200. =============
    let update = null;
    try {
      update = await request.json();
    } catch (e) {
      console.error('bad_update_body', String((e && e.message) || e));
      return new Response('ok', { status: 200 });
    }

    const missing = missingSecrets(env);
    if (missing.length) {
      // Report in-band rather than failing the request, so Telegram does not
      // retry and the operator sees the problem immediately.
      console.error('missing_secrets', missing.join(','));
      const chatId =
        (update.message && update.message.chat && update.message.chat.id) ||
        (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id);
      if (chatId && isAllowed(env, chatId)) {
        ctx.waitUntil(sendMessage(env, chatId, `❌ پیکربندی ناقص است. این Secretها تنظیم نشده‌اند: <code>${missing.join(', ')}</code>`));
      }
      return new Response('ok', { status: 200 });
    }

    try {
      await processUpdate(env, update);
    } catch (e) {
      // Last line of defence. Nothing escapes to become a non-200.
      console.error('unhandled_worker_error', String((e && e.stack) || e));
    }
    return new Response('ok', { status: 200 });
  },
};
