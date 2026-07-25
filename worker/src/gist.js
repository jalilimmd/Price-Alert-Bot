/**
 * Gist access for the WORKER tier.
 *
 * OWNERSHIP CONTRACT — enforced structurally in this file:
 *   read  : alerts.json, runtime.json
 *   write : alerts.json ONLY
 *
 * `patchAlertsFile` builds a PATCH body containing exactly one key, FILE_ALERTS.
 * The GitHub Gist API documents that files not named in an edit are left
 * unchanged, so this tier cannot touch runtime.json or history.json. FILE_ALERTS
 * is the only filename ever placed in a PATCH body anywhere in the Worker.
 */

import {
  FILE_ALERTS,
  FILE_RUNTIME,
  migrateAlertsDoc,
  migrateRuntimeDoc,
  emptyAlertsDoc,
  emptyRuntimeDoc,
  SchemaTooNewError,
} from './schema.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 8000;

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'price-alert-bot-worker/1.0',
  };
}

async function gistFetch(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...ghHeaders(env), ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('GitHub returned non-JSON');
  }
}

/** Gist file contents arrive inline unless the file exceeds 1 MB. */
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

function parseDoc(text, migrate, empty) {
  if (text === null || !text.trim()) return empty();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Never silently replace a corrupt file with an empty one: for alerts.json
    // that would destroy every alert on the next write.
    throw new Error('corrupt');
  }
  return migrate(raw);
}

/**
 * Reads alerts.json and runtime.json in ONE API call.
 * Neither file must exist; a brand-new Gist yields empty documents.
 */
export async function readState(env) {
  const gist = await gistFetch(env, `/gists/${env.GIST_ID}`);
  const alertsText = await readGistFile(gist, FILE_ALERTS);
  const runtimeText = await readGistFile(gist, FILE_RUNTIME);

  let alerts = null;
  let alertsError = null;
  try {
    alerts = parseDoc(alertsText, migrateAlertsDoc, emptyAlertsDoc);
  } catch (e) {
    alertsError = e instanceof SchemaTooNewError ? 'schema_too_new' : 'corrupt';
  }

  // runtime.json is advisory here. If unreadable, the user can still manage
  // alerts; /list simply reports "not yet evaluated".
  let runtime = emptyRuntimeDoc();
  try {
    runtime = parseDoc(runtimeText, migrateRuntimeDoc, emptyRuntimeDoc);
  } catch {
    /* advisory only */
  }

  return {
    alerts,
    alertsError,
    runtime,
    runtimeExists: runtimeText !== null,
    alertsExists: alertsText !== null,
  };
}

async function patchAlertsFile(env, doc) {
  const body = {
    files: {
      // The ONLY filename this tier ever writes.
      [FILE_ALERTS]: {
        content: JSON.stringify({ ...doc, updated_at: new Date().toISOString() }, null, 2),
      },
    },
  };
  await gistFetch(env, `/gists/${env.GIST_ID}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Read-modify-write-verify against alerts.json.
 *
 * `mutate(doc, state)` receives a fresh copy of the current document and returns:
 *   { error }                 -> abort, surface `error` to the user, no write
 *   { result, noWrite: true } -> nothing to change, no write
 *   { doc, result, verify }   -> write `doc`, then confirm `verify(reread)` is true
 *
 * Re-reading and re-applying the mutation on every attempt is what makes this
 * correct: a retry never replays a stale document. This covers the intra-tier
 * case of one user firing two commands in the same second. The cross-tier
 * guarantee is separate and comes from file ownership, not from this loop.
 */
export async function updateAlerts(env, mutate) {
  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let state;
    try {
      state = await readState(env);
    } catch (e) {
      lastError = e;
      continue;
    }

    if (!state.alerts) {
      return {
        ok: false,
        userError:
          state.alertsError === 'schema_too_new'
            ? 'فایل alerts.json با نسخهٔ جدیدتری از این ربات نوشته شده است. برای جلوگیری از خرابی داده، نوشتن متوقف شد.'
            : 'فایل alerts.json در Gist خراب است. برای جلوگیری از پاک شدن هشدارها، نوشتن متوقف شد.',
      };
    }

    const out = mutate(structuredClone(state.alerts), state);
    if (out.error) return { ok: false, userError: out.error };
    if (out.noWrite) return { ok: true, result: out.result, state };

    try {
      await patchAlertsFile(env, out.doc);
    } catch (e) {
      lastError = e;
      continue;
    }

    if (typeof out.verify !== 'function') return { ok: true, result: out.result, state };

    try {
      const after = await readState(env);
      if (after.alerts && out.verify(after.alerts)) {
        return { ok: true, result: out.result, state: after };
      }
      lastError = new Error('write did not verify (possible concurrent command)');
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, error: String((lastError && lastError.message) || lastError) };
}
