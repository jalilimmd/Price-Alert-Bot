/**
 * Gist access for the ACTIONS tier.
 *
 * OWNERSHIP CONTRACT — enforced structurally in this file:
 *   read  : alerts.json  (never written, not even to auto-disable an alert)
 *   write : runtime.json, history.json ONLY
 *
 * `writeOwnedFiles` builds a PATCH body whose keys are exactly FILE_RUNTIME and
 * FILE_HISTORY. FILE_ALERTS is imported for reading only and is never used as a
 * key in a write body anywhere in this tier. Because the Gist API leaves files
 * absent from an edit unchanged, alerts.json cannot be modified from here even
 * by accident.
 *
 * This is why auto-disable (max_triggers, expiry) is recorded as
 * runtime.system_disabled rather than by flipping alerts[].enabled: `enabled` is
 * the user's own toggle, owned by the Worker. Effective status is the AND of the
 * two, computed at read time by whichever tier needs it.
 */

import {
  FILE_ALERTS,
  FILE_RUNTIME,
  FILE_HISTORY,
  migrateAlertsDoc,
  migrateRuntimeDoc,
  migrateHistoryDoc,
  emptyAlertsDoc,
  emptyRuntimeDoc,
  emptyHistoryDoc,
  SchemaTooNewError,
} from './schema.js';
import { config } from './config.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15000;

function ghHeaders() {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'price-alert-bot-actions/1.0',
  };
}

async function gistFetch(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...ghHeaders(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('GitHub returned non-JSON');
  }
}

async function readGistFile(gist, filename) {
  const f = gist.files && gist.files[filename];
  if (!f) return null;
  if (f.truncated && f.raw_url) {
    const res = await fetch(f.raw_url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`raw_url fetch failed for ${filename}: ${res.status}`);
    return await res.text();
  }
  return f.content ?? null;
}

function parseDoc(text, migrate, empty, label) {
  if (text === null || !text.trim()) return { doc: empty(), existed: false };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return { doc: migrate(raw), existed: true };
}

/**
 * ONE API call fetches all three files.
 *
 * FIRST-RUN CASE: none of the three files needs to exist. alerts.json missing
 * means the Worker has not been used yet; this tier still records price history
 * so that percent-change windows are already warm when the first alert appears.
 */
export async function readAll() {
  const gist = await gistFetch(`/gists/${config.gistId}`);

  const alertsText = await readGistFile(gist, FILE_ALERTS);
  const runtimeText = await readGistFile(gist, FILE_RUNTIME);
  const historyText = await readGistFile(gist, FILE_HISTORY);

  // A corrupt or too-new alerts.json must NOT be treated as "no alerts",
  // because that would silently stop every alert the user created.
  let alerts;
  let alertsExisted;
  let alertsFatal = null;
  try {
    const r = parseDoc(alertsText, migrateAlertsDoc, emptyAlertsDoc, FILE_ALERTS);
    alerts = r.doc;
    alertsExisted = r.existed;
  } catch (e) {
    alerts = null;
    alertsExisted = true;
    alertsFatal = e instanceof SchemaTooNewError ? 'schema_too_new' : 'corrupt';
  }

  const runtimeR = safeParse(runtimeText, migrateRuntimeDoc, emptyRuntimeDoc, FILE_RUNTIME);
  const historyR = safeParse(historyText, migrateHistoryDoc, emptyHistoryDoc, FILE_HISTORY);

  return {
    alerts,
    alertsExisted,
    alertsFatal,
    runtime: runtimeR.doc,
    runtimeExisted: runtimeR.existed,
    runtimeFatal: runtimeR.fatal,
    history: historyR.doc,
    historyExisted: historyR.existed,
    historyFatal: historyR.fatal,
  };
}

/**
 * For files this tier owns, a too-new schema is fatal (refuse to write, so an
 * older deployment cannot clobber a newer one) but corruption is recoverable
 * (we own the file, and rebuilding an empty ring buffer costs at most 24h of
 * history — losing it is strictly better than wedging the bot forever).
 */
function safeParse(text, migrate, empty, label) {
  try {
    const r = parseDoc(text, migrate, empty, label);
    return { doc: r.doc, existed: r.existed, fatal: null };
  } catch (e) {
    if (e instanceof SchemaTooNewError) {
      console.error(`FATAL ${label}: ${e.message} — refusing to write this file`);
      return { doc: empty(), existed: true, fatal: 'schema_too_new' };
    }
    console.error(`WARN ${label}: ${e.message} — rebuilding from empty (this file is owned by this tier)`);
    return { doc: empty(), existed: true, fatal: null };
  }
}

/**
 * Writes runtime.json and history.json in a SINGLE PATCH.
 *
 * One request means the two owned files always advance together: there is no
 * window in which runtime says an alert fired but history lacks the sample that
 * caused it.
 */
export async function writeOwnedFiles(runtimeDoc, historyDoc, { skipRuntime = false, skipHistory = false } = {}) {
  const stamp = new Date().toISOString();
  const files = {};

  if (!skipRuntime) {
    files[FILE_RUNTIME] = { content: JSON.stringify({ ...runtimeDoc, updated_at: stamp }, null, 2) };
  }
  if (!skipHistory) {
    // History is written compactly: at 288 points x 3 assets it is roughly
    // 25 KB, far below the Gist API's 1 MB per-file inline limit, and there is
    // no reason to spend bytes on indentation for a machine-only file.
    files[FILE_HISTORY] = { content: JSON.stringify({ ...historyDoc, updated_at: stamp }) };
  }

  if (!Object.keys(files).length) {
    console.warn('writeOwnedFiles: nothing to write');
    return { ok: true, skipped: true };
  }

  if (config.dryRun) {
    console.log('DRY_RUN: would PATCH gist files:', Object.keys(files).join(', '));
    return { ok: true, dryRun: true };
  }

  await gistFetch(`/gists/${config.gistId}`, { method: 'PATCH', body: JSON.stringify({ files }) });
  return { ok: true, files: Object.keys(files) };
}
