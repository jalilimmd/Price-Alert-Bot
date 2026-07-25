/**
 * Channel: ntfy.sh (the required secondary channel).
 *
 * WHY NTFY, against the stated criteria:
 *   permanently free  the public ntfy.sh server has always been free to publish
 *                     to and the project states it will stay that way; paid
 *                     tiers only raise limits.
 *   no credit card    no account at all is needed to publish or subscribe.
 *   no dependency     delivery is one HTTP POST to https://ntfy.sh/<topic>.
 *                     No SDK, no second bot token, no OAuth dance.
 *   send side certain the publish call is plain HTTPS to a well-connected host,
 *                     so it works from a GitHub-hosted runner, which is the one
 *                     thing that must never be in doubt.
 *   escape hatch      ntfy is open source and self-hostable; NTFY_SERVER points
 *                     the same code at a private instance with no other change.
 *
 * HONEST LIMITATION: reachability from inside Iran is the same question as
 * Telegram's — if ntfy.sh is filtered, the subscribing device needs the same
 * workaround it already needs for Telegram. ntfy therefore buys resilience
 * against a Telegram *API* outage or a bot-token problem, not against network
 * filtering. The Bale channel in this directory addresses that second case and
 * ships ready to enable.
 *
 * SECURITY: a public topic is readable by anyone who guesses its name. Use a
 * long random topic. That is obscurity, not authentication — exactly the same
 * caveat as the Worker's secret webhook path. If the ntfy instance supports
 * auth, set NTFY_TOKEN and the request carries a bearer token.
 *
 * RATE LIMIT (ntfy.sh, verified 2026-07-24): 60-message burst, refilling at one
 * message per 5 seconds. This bot's ceiling is one message per alert per
 * cooldown window, so the burst is only reachable if dozens of alerts fire in
 * the same run.
 */

const TIMEOUT_MS = 10000;

export const ntfyChannel = {
  name: 'ntfy',

  enabled(config) {
    return Boolean(config.ntfyEnabled && config.ntfyTopic);
  },

  async send(payload, config) {
    const url = `${config.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(config.ntfyTopic)}`;
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'User-Agent': config.sources.userAgent,
      // ntfy reads metadata from headers. They must be latin-1 safe, so the
      // Persian title goes in the body and only ASCII metadata goes up here.
      Title: 'Price Alert',
      Tags: (payload.tags || []).join(','),
      Priority: String(payload.priority || 3),
    };
    if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: `${payload.title}\n\n${payload.body}`,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: t.slice(0, 200) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
};
