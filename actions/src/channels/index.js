/**
 * Pluggable delivery layer.
 *
 * A channel is an object:
 *   { name, enabled(config) -> boolean, send(payload, config) -> Promise<{ok,...}> }
 *
 * `payload` is channel-agnostic:
 *   { title, body, tags, priority, chatIdTelegram }
 *
 * Adding a fourth channel means writing one file and adding it to CHANNELS.
 * Nothing in evaluate.js knows a channel exists — it produces a payload and
 * hands it to `deliver`. This layer is delivery-only; command handling stays
 * Telegram-exclusive and lives entirely in the Worker tier.
 */

import { telegramChannel } from './telegram.js';
import { ntfyChannel } from './ntfy.js';
import { baleChannel } from './bale.js';

/** Telegram is first because it is the channel the user actually commands. */
export const CHANNELS = [telegramChannel, ntfyChannel, baleChannel];

export function activeChannels(config) {
  return CHANNELS.filter((c) => {
    try {
      return c.enabled(config);
    } catch {
      return false;
    }
  });
}

/**
 * Fan a single payload out to every enabled channel.
 * Never throws and never lets one channel's failure suppress another: a Telegram
 * outage must not stop the ntfy notification, which is the entire point of
 * having a second channel.
 */
export async function deliver(payload, config) {
  const chans = activeChannels(config);
  if (!chans.length) {
    console.warn('deliver: no channels enabled, message dropped:', payload.title);
    return { ok: false, results: [] };
  }

  if (config.dryRun) {
    console.log(`DRY_RUN: would deliver via [${chans.map((c) => c.name).join(', ')}]:\n${payload.title}\n${payload.body}`);
    return { ok: true, dryRun: true, results: chans.map((c) => ({ channel: c.name, ok: true, dryRun: true })) };
  }

  const results = await Promise.all(
    chans.map(async (c) => {
      try {
        const r = await c.send(payload, config);
        if (!r.ok) console.error(`channel_failed ${c.name}:`, r.error || r.status);
        return { channel: c.name, ...r };
      } catch (e) {
        console.error(`channel_threw ${c.name}:`, String((e && e.message) || e));
        return { channel: c.name, ok: false, error: String((e && e.message) || e) };
      }
    })
  );

  return { ok: results.some((r) => r.ok), results };
}
