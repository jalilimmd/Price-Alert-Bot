/**
 * Telegram Bot API client for the Worker tier.
 *
 * Every function here swallows its own errors and returns a result object.
 * Nothing in this file may throw into the request handler, because a thrown
 * error that escaped would risk the Worker returning a non-200 to Telegram,
 * which would make Telegram redeliver the update and execute the command twice.
 */

const TIMEOUT_MS = 6000;

async function call(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!json || json.ok !== true) {
      console.error('telegram_error', method, res.status, JSON.stringify(json || {}).slice(0, 300));
      return { ok: false, status: res.status, body: json };
    }
    return { ok: true, result: json.result };
  } catch (e) {
    console.error('telegram_exception', method, String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Telegram hard-limits a message to 4096 characters. Split on line boundaries. */
function chunk(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const out = [];
  let buf = '';
  for (const line of lines) {
    if ((buf + '\n' + line).length > limit) {
      if (buf) out.push(buf);
      buf = line.length > limit ? line.slice(0, limit) : line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendMessage(env, chatId, text, opts = {}) {
  const parts = chunk(text);
  let last = { ok: true };
  for (let i = 0; i < parts.length; i++) {
    last = await call(env, 'sendMessage', {
      chat_id: chatId,
      text: parts[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      // Only attach the keyboard to the final chunk.
      ...(i === parts.length - 1 && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    });
  }
  return last;
}

export async function answerCallbackQuery(env, id, text, showAlert = false) {
  return call(env, 'answerCallbackQuery', {
    callback_query_id: id,
    text: text ? text.slice(0, 200) : undefined,
    show_alert: showAlert,
  });
}

export async function editMessageText(env, chatId, messageId, text, replyMarkup) {
  return call(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * Inline keyboard for one alert row in /list.
 * callback_data must stay under 64 bytes; ids are 7 chars so this is safe and,
 * critically, requires no per-user conversation state anywhere.
 */
export function alertKeyboard(alert, paused) {
  return {
    inline_keyboard: [
      [
        paused
          ? { text: '▶️ ازسرگیری', callback_data: `resume:${alert.id}` }
          : { text: '⏸ توقف', callback_data: `pause:${alert.id}` },
        { text: '🗑 حذف', callback_data: `del:${alert.id}` },
      ],
    ],
  };
}
