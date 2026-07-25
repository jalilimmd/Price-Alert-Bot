#!/usr/bin/env node
/**
 * Reachability and shape diagnostic. Run it with workflow_dispatch
 * (mode = diagnose) so it executes from the same runner IPs as the real job.
 *
 * This exists because three of the residual risks in this design are
 * environmental rather than logical, and none of them can be settled by reading
 * code:
 *   1. Iranian endpoints may refuse or throttle non-Iranian egress IPs, and
 *      GitHub-hosted runners are US-based.
 *   2. The two gold sources are scraping-derived and publish no schema contract,
 *      so a field can be renamed without notice.
 *   3. Bale's send side may or may not accept a US-origin request.
 *
 * Rather than assert any of these, the diagnostic measures them and prints what
 * it actually got back. It writes nothing to the Gist and delivers no alerts.
 */

import { config } from './config.js';
import { ASSET_LIST, ASSET_META } from './schema.js';
import { fetchAssetPrice, fetchBtcDailyCloses, chainFor } from './sources.js';
import { activeChannels } from './channels/index.js';
import { fmtPrice, fmtTehran } from './format.js';

const line = (s = '') => console.log(s);
const rule = () => line('-'.repeat(72));

async function probe(name, url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': config.sources.userAgent, ...(init.headers || {}) },
      signal: AbortSignal.timeout(config.sources.timeoutMs),
    });
    const ms = Date.now() - t0;
    const body = await res.text();
    line(`  ${res.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(28)} HTTP ${res.status}  ${String(ms).padStart(5)}ms  ${body.length}B`);
    if (!res.ok) line(`       body: ${body.slice(0, 200)}`);
    return { ok: res.ok, status: res.status, ms, body };
  } catch (e) {
    line(`  FAIL ${name.padEnd(28)} ${String((e && e.message) || e).slice(0, 120)}`);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function main() {
  line(`diagnose — ${new Date().toISOString()} (Tehran ${fmtTehran(Date.now(), { fa: false })})`);
  rule();

  line('CONFIGURATION');
  line(`  GIST_ID           ${config.gistId ? 'set' : 'MISSING'}`);
  line(`  GH_GIST_TOKEN     ${config.githubToken ? 'set' : 'MISSING'}`);
  line(`  BOT_TOKEN         ${config.botToken ? 'set' : 'MISSING'}`);
  line(`  ADMIN_CHAT_ID     ${config.adminChatId || 'not set (no source-failure notices will be sent)'}`);
  line(`  BRSAPI_KEY        ${config.brsapiKey ? 'set' : 'not set (gold falls back to TGJU)'}`);
  line(`  channels enabled  ${activeChannels(config).map((c) => c.name).join(', ') || 'NONE'}`);
  rule();

  line('EGRESS IDENTITY (this is the IP the price sources will see)');
  const ipRes = await probe('ipify', 'https://api.ipify.org?format=json');
  if (ipRes.ok) line(`       ${ipRes.body.slice(0, 120)}`);
  rule();

  line('RAW ENDPOINT REACHABILITY');
  await probe('okx ticker', 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT');
  await probe('kucoin level1', 'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT');
  await probe('coinbase ticker', 'https://api.exchange.coinbase.com/products/BTC-USDT/ticker');
  await probe('nobitex stats', 'https://api.nobitex.ir/market/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ srcCurrency: 'usdt', dstCurrency: 'rls' }),
  });
  await probe('wallex depth', 'https://api.wallex.ir/v1/depth?symbol=USDTTMN');
  await probe('tgju ajax', 'https://call1.tgju.org/ajax.json', { headers: { Accept: '*/*' } });
  if (config.brsapiKey) {
    const r = await probe('brsapi gold', `https://Api.BrsApi.ir/Market/Gold_Currency.php?key=${encodeURIComponent(config.brsapiKey)}`);
    // The gold adapter matches on symbol or Persian name. If BrsAPI renames a
    // field this dump is how you find out what it is now.
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const list = Array.isArray(j) ? j : j.gold || [];
        line('       gold entries returned (symbol | name | price | unit):');
        for (const g of list.slice(0, 25)) {
          line(`         ${String(g.symbol || '').padEnd(16)} ${String(g.name || '').padEnd(28)} ${g.price} ${g.unit || ''}`);
        }
      } catch {
        line('       could not parse gold array from the response');
      }
    }
  } else {
    line('  SKIP brsapi gold                (no BRSAPI_KEY set)');
  }
  if (config.baleEnabled || config.baleToken) {
    await probe('bale getMe', `https://tapi.bale.ai/bot${config.baleToken}/getMe`);
  } else {
    line('  SKIP bale                       (not configured)');
  }
  if (config.ntfyEnabled && config.ntfyTopic) {
    await probe('ntfy reachability', `${config.ntfyServer.replace(/\/+$/, '')}/v1/health`);
  } else {
    line('  SKIP ntfy                       (not configured)');
  }
  rule();

  line('ADAPTER CHAINS (what the bot would actually use)');
  let anyFailed = false;
  for (const asset of ASSET_LIST) {
    line(`  ${ASSET_META[asset].key}  chain: ${chainFor(asset, config.sources).join(' -> ')}`);
    const r = await fetchAssetPrice(asset, config.sources);
    if (r.ok) {
      line(`    RESOLVED  ${fmtPrice(asset, r.price, { fa: false })}  via ${r.adapter} (${r.source})  method=${r.method}`);
    } else {
      anyFailed = true;
      line('    ALL SOURCES FAILED:');
      for (const a of r.attempts) line(`      ${a.adapter}: ${a.error}`);
    }
    for (const a of r.attempts.filter((x) => x.error)) line(`    note ${a.adapter}: ${a.error}`);
  }
  rule();

  line('BTC DAILY KLINES (used only for 7d / 30d)');
  const k = await fetchBtcDailyCloses(config.sources);
  if (k.ok) {
    line(`  OK via ${k.adapter} (${k.source}) — ${k.rows.length} daily closes`);
    const first = k.rows[0];
    const last = k.rows[k.rows.length - 1];
    line(`  oldest ${new Date(first.ts).toISOString().slice(0, 10)} = ${first.close}`);
    line(`  newest ${new Date(last.ts).toISOString().slice(0, 10)} = ${last.close}`);
  } else {
    anyFailed = true;
    line('  ALL KLINE SOURCES FAILED:');
    for (const a of k.attempts) line(`    ${a.adapter}: ${a.error}`);
  }
  rule();

  line('GIST ACCESS (read-only check, nothing is written)');
  if (config.gistId && config.githubToken) {
    const r = await probe('gist read', `https://api.github.com/gists/${config.gistId}`, {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        line(`       files present: ${Object.keys(j.files || {}).join(', ') || '(none)'}`);
        line(`       public: ${j.public} — keep it SECRET, it holds your chat ids`);
      } catch {
        /* already reported */
      }
    }
  } else {
    line('  SKIP (GIST_ID or GH_GIST_TOKEN missing)');
  }
  rule();

  line(anyFailed ? 'RESULT: at least one chain is degraded — see above' : 'RESULT: every chain resolved');
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  console.error('diagnose failed:', String((e && e.stack) || e));
  process.exit(1);
});
