/**
 * Channel: Bale (third channel, ships disabled).
 *
 * Included to demonstrate the claim that a channel can be added without
 * touching alert-evaluation logic: this file plus one line in channels/index.js
 * is the entire change. Nothing in evaluate.js, history.js, sources.js or
 * gist.js is aware of it.
 *
 * Bale is an Iranian messenger whose bot API is Telegram-compatible in shape,
 * which is why this adapter is short. Its practical advantage over both Telegram
 * and ntfy is that it is reachable from inside Iran without a workaround.
 *
 * ITS RISK, STATED PLAINLY: tapi.bale.ai may refuse or throttle requests from
 * non-Iranian egress IPs, and GitHub-hosted runners are US-based. That is why
 * this channel is off by default. Run `npm run diagnose` from a workflow_dispatch
 * to find out whether the runner can reach it, and only then set
 * BALE_ENABLED=true. If it cannot be reached, `deliver` logs the failure and the
 * other channels still go out.
 */

const TIMEOUT_MS = 10000;

export const baleChannel = {
  name: 'bale',

  enabled(config) {
    return Boolean(config.baleEnabled && config.baleToken && config.baleChatId);
  },

  async send(payload, config) {
    const text = `${payload.title}\n\n${payload.body}`.slice(0, 4000);
    try {
      const res = await fetch(`https://tapi.bale.ai/bot${config.baleToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': config.sources.userAgent },
        body: JSON.stringify({ chat_id: config.baleChatId, text: stripHtml(text) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        return { ok: false, status: res.status, error: JSON.stringify(json || {}).slice(0, 200) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
};

/** Bale's parse_mode support differs from Telegram's; send plain text. */
function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
