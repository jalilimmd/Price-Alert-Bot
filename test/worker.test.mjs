#!/usr/bin/env node
/**
 * Worker-tier unit tests: the pure, network-free logic that decides whether a
 * command is accepted and how numbers render. These are the parts most likely
 * to mishandle Persian input or the asset/type availability matrix.
 */

import assert from 'node:assert';
import { parseNum, parseCommand, normalizeDigits } from '../worker/src/commands.js';
import { validateAlertInput, resolveAsset, resolveType, ASSETS, ALERT_TYPES } from '../worker/src/schema.js';
import { fmtNumber, fmtPct, fmtPrice, fmtBound, fmtTehran } from '../worker/src/format.js';

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  console.log(`  ✓ ${name}`);
  passed++;
}
function eq(name, a, b) {
  assert.strictEqual(a, b, `${name}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
  console.log(`  ✓ ${name}`);
  passed++;
}

console.log('\n[A] number parsing');
eq('plain integer', parseNum('70000'), 70000);
eq('comma grouped', parseNum('19,500,000'), 19500000);
eq('underscore grouped', parseNum('70_000'), 70000);
eq('k suffix', parseNum('70k'), 70000);
eq('m suffix', parseNum('18.8m'), 18800000);
eq('decimal', parseNum('2.5'), 2.5);
eq('negative', parseNum('-5'), -5);
eq('unicode minus', parseNum('\u22125'), -5);
eq('persian digits', parseNum('۷۰۰۰۰'), 70000);
eq('persian with separator', parseNum('۱۹٬۵۰۰٬۰۰۰'), 19500000);
eq('arabic-indic digits', parseNum('٧٠٠٠٠'), 70000);
eq('garbage is null', parseNum('abc'), null);
eq('empty is null', parseNum(''), null);
eq('lone dash is null', parseNum('-'), null);

console.log('\n[B] command parsing');
const c1 = parseCommand('/add btc abs above=70000 cooldown=60');
eq('command name', c1.cmd, 'add');
eq('positional args', c1.args.join(','), 'btc,abs');
eq('flag above', c1.flags.above, '70000');
eq('flag cooldown', c1.flags.cooldown, '60');
const c2 = parseCommand('/list@MyBot');
eq('strips @botname', c2.cmd, 'list');
eq('non-command returns null', parseCommand('hello'), null);
const c3 = parseCommand('/add   gold   abs    above=19,500,000');
eq('collapses whitespace', c3.args.join(','), 'gold,abs');

console.log('\n[C] alias resolution');
eq('btc alias', resolveAsset('BTC'), ASSETS.BTC_USDT);
eq('persian gold alias', resolveAsset('طلا'), ASSETS.GOLD18);
eq('usdt alias', resolveAsset('tether'), ASSETS.USDT_IRT);
eq('unknown asset', resolveAsset('doge'), null);
eq('abs type', resolveType('abs'), ALERT_TYPES.ABSOLUTE_TARGET);
eq('24h alias 1d', resolveType('1d'), ALERT_TYPES.PCT_CHANGE_24H);
eq('7d alias 1w', resolveType('1w'), ALERT_TYPES.PCT_CHANGE_7D);

console.log('\n[D] validation matrix — the availability rules');
check(
  'gold 7d is rejected with an explanatory error',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.GOLD18, type: ALERT_TYPES.PCT_CHANGE_7D, upper: 5 });
    return !v.ok && /در دسترس نیست/.test(v.error);
  })()
);
check(
  'usdt 30d is rejected',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.USDT_IRT, type: ALERT_TYPES.PCT_CHANGE_30D, upper: 5 });
    return !v.ok;
  })()
);
check(
  'btc 7d is allowed',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.PCT_CHANGE_7D, upper: 5 });
    return v.ok;
  })()
);
check(
  'gold 24h is allowed',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.GOLD18, type: ALERT_TYPES.PCT_CHANGE_24H, lower: -3 });
    return v.ok;
  })()
);
check(
  'no bound at all is rejected',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.ABSOLUTE_TARGET });
    return !v.ok && /کران/.test(v.error);
  })()
);
check(
  'lower >= upper is rejected',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.ABSOLUTE_TARGET, lower: 80000, upper: 70000 });
    return !v.ok;
  })()
);
check(
  'absolute bound must be positive',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.ABSOLUTE_TARGET, upper: -5 });
    return !v.ok;
  })()
);
check(
  'percent bound may be negative',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.PCT_CHANGE_24H, lower: -5, upper: 5 });
    return v.ok && v.value.lower === -5 && v.value.upper === 5;
  })()
);
check(
  'cooldown below minimum is rejected',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.ABSOLUTE_TARGET, upper: 70000, cooldown: 1 });
    return !v.ok;
  })()
);
check(
  'defaults are applied when flags omitted',
  (() => {
    const v = validateAlertInput({ asset: ASSETS.BTC_USDT, type: ALERT_TYPES.ABSOLUTE_TARGET, upper: 70000 });
    return v.ok && v.value.cooldown === 120 && v.value.max === 3 && v.value.expires === 30;
  })()
);

console.log('\n[E] formatting (Persian digits, separators, signed percent)');
eq('thousands separators + persian digits', fmtNumber(19500000, 0), '۱۹٬۵۰۰٬۰۰۰'.replace(/٬/g, ',').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]));
// simpler explicit expectation:
eq('grouping ascii check', fmtNumber(1234567, 0, { fa: false }), '1,234,567');
eq('two decimals', fmtNumber(1234.5, 2, { fa: false }), '1,234.50');
eq('positive percent has plus', fmtPct(3.2, { fa: false }), '+3.20٪');
eq('negative percent has minus sign', fmtPct(-5, { fa: false }), '\u22125.00٪');
eq('zero percent no sign', fmtPct(0, { fa: false }), '0.00٪');
check('price attaches quote currency', /تومان/.test(fmtPrice(ASSETS.GOLD18, 19500000)));
check('btc price attaches تتر', /تتر/.test(fmtPrice(ASSETS.BTC_USDT, 70000)));
check('abs bound formats as price', /تومان/.test(fmtBound(ASSETS.GOLD18, ALERT_TYPES.ABSOLUTE_TARGET, 19500000)));
check('pct bound formats as percent', /٪/.test(fmtBound(ASSETS.BTC_USDT, ALERT_TYPES.PCT_CHANGE_24H, 5)));

console.log('\n[F] Tehran timezone rendering');
// 2026-07-20T08:00:00Z -> Tehran is UTC+3:30 -> 11:30
eq('utc to tehran +3:30', fmtTehran('2026-07-20T08:00:00Z', { fa: false }), '2026-07-20 11:30');

console.log(`\nALL ${passed} CHECKS PASSED`);
