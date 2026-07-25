#!/usr/bin/env node
/**
 * TIER 2 — GitHub Actions. Scheduled price evaluation and alert delivery.
 *
 * Runs on a 5-minute cron plus workflow_dispatch. GitHub's scheduler is not
 * punctual: 5–20 minute delays are routine at peak and a slot is occasionally
 * skipped outright. Nothing in this tier assumes "exactly every 5 minutes" —
 * every time-based decision compares real timestamps, never counts of runs.
 *
 * WRITES: runtime.json and history.json, and nothing else, ever.
 * READS:  alerts.json.
 * NEVER CALLS: getUpdates. A webhook is registered by the Worker and Telegram
 * documents the two as mutually exclusive.
 */

import { config, validateConfig } from './config.js';
import { readAll, writeOwnedFiles } from './gist.js';
import { evaluateAll } from './evaluate.js';
import { seriesLength } from './history.js';
import { ASSET_LIST, ASSET_META } from './schema.js';
import { fmtTehran } from './format.js';

function banner(msg) {
  console.log(`\n=== ${msg} ===`);
}

async function main() {
  const nowMs = Date.now();
  banner(`run start ${new Date(nowMs).toISOString()} (Tehran ${fmtTehran(nowMs, { fa: false })})`);

  const missing = validateConfig();
  if (missing.length) {
    console.error(`FATAL missing required secrets: ${missing.join(', ')}`);
    console.error('Set them under Settings -> Secrets and variables -> Actions.');
    process.exit(1);
  }

  // ---------------------------------------------------------------- read --
  let state;
  try {
    state = await readAll();
  } catch (e) {
    console.error('FATAL could not read the Gist:', String((e && e.message) || e));
    process.exit(1);
  }

  console.log(
    `gist read: alerts=${state.alertsExisted ? 'present' : 'absent'} ` +
      `runtime=${state.runtimeExisted ? 'present' : 'absent'} ` +
      `history=${state.historyExisted ? 'present' : 'absent'}`
  );

  if (state.alertsFatal) {
    // Refusing to proceed is correct: with an unreadable alerts.json we cannot
    // tell "the user has no alerts" from "we cannot see the user's alerts", and
    // acting on the first interpretation would garbage-collect every runtime
    // entry the user has.
    console.error(
      `FATAL alerts.json is ${state.alertsFatal}. Refusing to evaluate or to garbage-collect runtime state, ` +
        'because that would destroy state belonging to alerts we simply cannot read right now.'
    );
    process.exit(1);
  }

  if (state.runtimeFatal === 'schema_too_new' || state.historyFatal === 'schema_too_new') {
    console.error('FATAL an owned file was written by a newer build. Refusing to write, to avoid a downgrade clobber.');
    process.exit(1);
  }

  const alertCount = state.alerts.alerts.length;
  if (!state.alertsExisted) {
    console.log(
      'alerts.json does not exist yet, so the Worker tier has not been used. ' +
        'Sampling prices anyway so the ring buffer is warm when the first alert is created.'
    );
  }
  console.log(`alerts loaded: ${alertCount}`);

  // ------------------------------------------------------------ evaluate --
  let outcome;
  try {
    outcome = await evaluateAll({
      alertsDoc: state.alerts,
      runtime: state.runtime,
      history: state.history,
      config,
      nowMs,
    });
  } catch (e) {
    console.error('FATAL evaluation threw:', String((e && e.stack) || e));
    // Do NOT write partial state after an unexpected throw.
    process.exit(1);
  }

  // --------------------------------------------------------------- write --
  try {
    const res = await writeOwnedFiles(state.runtime, state.history, {
      skipRuntime: state.runtimeFatal === 'schema_too_new',
      skipHistory: state.historyFatal === 'schema_too_new',
    });
    console.log(`gist write: ${res.dryRun ? 'DRY RUN' : (res.files || []).join(', ')}`);
  } catch (e) {
    console.error('FATAL could not write owned files:', String((e && e.message) || e));
    console.error('Alert notifications for this run may already have been delivered; runtime state was NOT persisted, ');
    console.error('so an alert that fired this run can fire once more on the next run. This is the deliberate trade-off:');
    console.error('at-least-once delivery is preferred over losing the notification entirely.');
    process.exit(1);
  }

  // -------------------------------------------------------------- summary --
  banner('summary');
  for (const asset of ASSET_LIST) {
    const s = outcome.snapshots[asset];
    const n = seriesLength(state.history, asset);
    if (s && s.ok) {
      console.log(
        `${ASSET_META[asset].key.padEnd(9)} price=${s.price} source=${s.source} method=${s.method}` +
          `${s.stale ? ` STALE(${s.staleReason})` : ''} ring=${n}/288`
      );
    } else {
      console.log(`${ASSET_META[asset].key.padEnd(9)} UNAVAILABLE ring=${n}/288`);
    }
  }
  const st = outcome.stats;
  console.log(
    `alerts: evaluated=${st.evaluated} fired=${st.fired} skipped=${st.skipped} ` +
      `auto-disabled=${st.disabled} runtime-gc=${st.gc} admin-notices=${st.notices}`
  );
  banner('run end');
}

main().catch((e) => {
  console.error('FATAL unhandled:', String((e && e.stack) || e));
  process.exit(1);
});
