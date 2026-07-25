#!/usr/bin/env node
/**
 * Drives the REAL Worker fetch handler (worker/src/index.js) through the four
 * security controls and the always-200 invariant. Global fetch is stubbed so
 * Telegram and GitHub calls are observed rather than made; the handler code is
 * otherwise the exact code that deploys.
 *
 * The invariant under test (success criterion #3): once an update is
 * authenticated, the handler returns HTTP 200 no matter what fails inside, so
 * Telegram never redelivers and no command runs twice.
 */

import assert from 'node:assert';
import worker from '../worker/src/index.js';

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

const TELEGRAM_CALLS = [];
let GIST_MODE = 'ok'; // 'ok' | 'throw'

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const respond = (obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async text() {
        return JSON.stringify(obj);
      },
      async json() {
        return obj;
      },
    });
    if (u.includes('api.telegram.org')) {
      TELEGRAM_CALLS.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
      return respond({ ok: true, result: { message_id: TELEGRAM_CALLS.length } });
    }
    if (u.includes('api.github.com/gists/')) {
      if (GIST_MODE === 'throw') return respond({ message: 'boom' }, 500);
      return respond({ id: 'x', files: {} });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}
stubFetch();

const SECRET_PATH = 'PATHSECRETPATHSECRETPATHSECRET12';
const SECRET_TOKEN = 'TOKENtokenTOKENtokenTOKENtokenTOKENtoken12345678';

const ENV = {
  BOT_TOKEN: 'bt',
  GITHUB_TOKEN: 'gt',
  GIST_ID: 'gid',
  WEBHOOK_SECRET_TOKEN: SECRET_TOKEN,
  WEBHOOK_PATH_SECRET: SECRET_PATH,
  ALLOWED_CHAT_IDS: '111,222',
  BRSAPI_KEY: '',
};

const CTX = { waitUntil: (p) => p };

function req(path, { method = 'POST', token, body } = {}) {
  const headers = new Headers();
  if (token !== undefined) headers.set('X-Telegram-Bot-Api-Secret-Token', token);
  headers.set('Content-Type', 'application/json');
  return new Request(`https://w.example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function msgUpdate(chatId, text) {
  return { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private' }, text } };
}

async function main() {
  console.log('\n[W] webhook security + always-200');

  // health
  let res = await worker.fetch(req('/health', { method: 'GET' }), ENV, CTX);
  check('/health returns 200', res.status === 200);
  const health = await res.json();
  check('/health reports ok when secrets present', health.ok === true);

  // control 2: secret path
  res = await worker.fetch(req(`/tg/WRONGPATH`, { token: SECRET_TOKEN, body: msgUpdate(111, '/start') }), ENV, CTX);
  check('wrong path -> 404', res.status === 404);

  // method guard
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { method: 'GET' }), ENV, CTX);
  check('GET on webhook path -> 405', res.status === 405);

  // control 1: secret token mismatch -> 401 (the one deliberate non-200)
  TELEGRAM_CALLS.length = 0;
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { token: 'WRONG', body: msgUpdate(111, '/start') }), ENV, CTX);
  check('wrong secret token -> 401', res.status === 401);
  check('unauthenticated request triggers no Telegram call', TELEGRAM_CALLS.length === 0);

  // missing token header -> 401
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { body: msgUpdate(111, '/start') }), ENV, CTX);
  check('missing secret token header -> 401', res.status === 401);

  // control 3: authenticated but chat not on allowlist -> 200, no reply
  TELEGRAM_CALLS.length = 0;
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { token: SECRET_TOKEN, body: msgUpdate(999, '/start') }), ENV, CTX);
  check('non-allowlisted chat still returns 200', res.status === 200);
  check('non-allowlisted chat gets no reply', TELEGRAM_CALLS.length === 0);

  // authenticated + allowlisted /start -> 200 and a reply
  TELEGRAM_CALLS.length = 0;
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { token: SECRET_TOKEN, body: msgUpdate(111, '/start') }), ENV, CTX);
  check('/start returns 200', res.status === 200);
  check('/start sends a reply', TELEGRAM_CALLS.length >= 1);
  check('/start reply contains the latency notice', /۲۰ دقیقه/.test(TELEGRAM_CALLS[0].body.text));

  // ALWAYS-200 under internal failure: /list forces a Gist read that 500s
  GIST_MODE = 'throw';
  TELEGRAM_CALLS.length = 0;
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { token: SECRET_TOKEN, body: msgUpdate(111, '/list') }), ENV, CTX);
  check('/list still returns 200 when the Gist read fails', res.status === 200);
  check('failure is reported in-band to the user, not by a non-200', TELEGRAM_CALLS.some((c) => /❌/.test(c.body.text)));
  GIST_MODE = 'ok';

  // malformed body after auth -> still 200
  const badReq = new Request(`https://w.example.com/tg/${SECRET_PATH}`, {
    method: 'POST',
    headers: new Headers({ 'X-Telegram-Bot-Api-Secret-Token': SECRET_TOKEN, 'Content-Type': 'application/json' }),
    body: '{not json',
  });
  res = await worker.fetch(badReq, ENV, CTX);
  check('malformed JSON body after auth -> 200', res.status === 200);

  // missing secrets -> 200 with in-band operator warning (no Telegram retry)
  TELEGRAM_CALLS.length = 0;
  const partialEnv = { ...ENV, GIST_ID: '' };
  res = await worker.fetch(req(`/tg/${SECRET_PATH}`, { token: SECRET_TOKEN, body: msgUpdate(111, '/start') }), partialEnv, CTX);
  check('missing secret still returns 200', res.status === 200);
  check('missing secret is reported in-band', TELEGRAM_CALLS.some((c) => /پیکربندی ناقص/.test(c.body.text)));

  console.log(`\nALL ${passed} CHECKS PASSED`);
}

main().catch((e) => {
  console.error('\nWORKER SMOKE TEST FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
