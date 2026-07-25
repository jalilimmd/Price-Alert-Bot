#!/usr/bin/env node
/**
 * Generates the two webhook secrets with the correct alphabets and lengths.
 *
 *   WEBHOOK_SECRET_TOKEN  authenticates every webhook call. Telegram restricts
 *                         it to 1–256 chars from [A-Za-z0-9_-]. We emit 48.
 *   WEBHOOK_PATH_SECRET   the random component of the webhook URL path. Kept to
 *                         [A-Za-z0-9] so it is URL-safe without encoding. 32 chars.
 *
 * Run:  node scripts/generate-secrets.mjs
 * Then feed each value to `wrangler secret put` as printed.
 */
import { randomBytes } from 'node:crypto';

function pick(alphabet, len) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const PATH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const token = pick(TOKEN_ALPHABET, 48);
const path = pick(PATH_ALPHABET, 32);

console.log('# Two secrets generated. Set them on the Worker:\n');
console.log(`WEBHOOK_SECRET_TOKEN=${token}`);
console.log(`WEBHOOK_PATH_SECRET=${path}`);
console.log('\n# Commands:');
console.log(`echo -n '${token}' | npx wrangler secret put WEBHOOK_SECRET_TOKEN`);
console.log(`echo -n '${path}' | npx wrangler secret put WEBHOOK_PATH_SECRET`);
console.log('\n# Your webhook URL will be:');
console.log(`#   https://<your-worker-subdomain>.workers.dev/tg/${path}`);
console.log('# Keep BOTH of these out of the repository and out of chat logs.');
