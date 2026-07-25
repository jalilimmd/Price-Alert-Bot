#!/usr/bin/env node
/**
 * Registers, inspects, or removes the Telegram webhook.
 *
 * Registering with a secret_token is what makes control #1 work: Telegram will
 * then send X-Telegram-Bot-Api-Secret-Token on every update, and the Worker
 * rejects anything whose header does not match.
 *
 * Usage (all read config from environment variables):
 *   BOT_TOKEN=...  WEBHOOK_URL=https://<worker>.workers.dev/tg/<pathsecret> \
 *   WEBHOOK_SECRET_TOKEN=... node scripts/register-webhook.mjs set
 *
 *   BOT_TOKEN=... node scripts/register-webhook.mjs info
 *   BOT_TOKEN=... node scripts/register-webhook.mjs delete
 *
 * Nothing is hardcoded; the script refuses to run without the values it needs.
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const cmd = process.argv[2] || 'info';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const api = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  if (cmd === 'set') {
    const url = process.env.WEBHOOK_URL;
    const secret = process.env.WEBHOOK_SECRET_TOKEN;
    if (!url || !secret) {
      console.error('set requires WEBHOOK_URL and WEBHOOK_SECRET_TOKEN.');
      process.exit(1);
    }
    const out = await call('setWebhook', {
      url,
      secret_token: secret,
      // Command handling + inline buttons only. We do NOT need most update types.
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      // Drop anything queued from before this webhook so an old command backlog
      // is not replayed on first go-live.
      drop_pending_updates: true,
      max_connections: 40,
    });
    console.log(JSON.stringify(out, null, 2));
    if (!out.ok) process.exit(1);
    console.log('\nWebhook registered. Verify with: node scripts/register-webhook.mjs info');
  } else if (cmd === 'delete') {
    const out = await call('deleteWebhook', { drop_pending_updates: false });
    console.log(JSON.stringify(out, null, 2));
  } else {
    const out = await call('getWebhookInfo');
    console.log(JSON.stringify(out, null, 2));
    if (out.ok && out.result) {
      const r = out.result;
      console.log('\n--- interpretation ---');
      console.log(`url set:            ${r.url ? 'yes' : 'NO'}`);
      console.log(`custom cert:        ${r.has_custom_certificate}`);
      console.log(`pending updates:    ${r.pending_update_count}`);
      console.log(`secret token in use:${r.has_custom_certificate !== undefined ? ' (Telegram does not echo the token; test by sending a command)' : ''}`);
      if (r.last_error_message) {
        console.log(`LAST ERROR:         ${r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : ''} ${r.last_error_message}`);
        console.log('  A 401 here means the Worker secret token does not match what was registered.');
        console.log('  A 404 here means the WEBHOOK_URL path does not match WEBHOOK_PATH_SECRET.');
      } else {
        console.log('last error:         none');
      }
    }
  }
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
