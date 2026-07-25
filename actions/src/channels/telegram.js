/**
 * Channel: Telegram (primary delivery).
 *
 * NOTE: this tier sends only. It must NEVER call getUpdates. A webhook is
 * registered by the Worker, and Telegram documents the two as mutually
 * exclusive — a single getUpdates call would break command handling entirely
 * until the webhook were re-registered. There is deliberately no polling code
 * anywhere in this repository.
 */

const TIMEOUT_MS = 10000;

export const telegramChannel = {
  name: 'telegram',

  enabled(config) {
    return Boolean(config.botToken);
  },

  async send(payload, config) {
    const chatId = payload.chatIdTelegram;
    if (!chatId) return { ok: false, error: 'no telegram chat id on payload' };

    const text = `${payload.title}\n\n${payload.body}`.slice(0, 4000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': config.sources.userAgent },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if (!json || json.ok !== true) {
        return { ok: false, status: res.status, error: JSON.stringify(json || {}).slice(0, 200) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
};
