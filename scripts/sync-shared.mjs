#!/usr/bin/env node
/**
 * Keeps the two tiers in sync.
 *
 * The Worker (Cloudflare) and the evaluator (Node on GitHub Actions) are
 * separate deployment units and cannot import from each other, so the canonical
 * files in shared/ are physically copied into each tier. This script does the
 * copying; .github/workflows/schema-check.yml runs it with --check on every push
 * so a divergence fails CI instead of silently shipping two different schemas.
 *
 *   node scripts/sync-shared.mjs           write the copies
 *   node scripts/sync-shared.mjs --check   exit 1 if any copy is stale
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const FILES = ['schema.js', 'format.js', 'sources.js'];
const TARGET_DIRS = ['worker/src', 'actions/src'];

const BANNER = [
  '/* ============================================================',
  ' * GENERATED FILE — DO NOT EDIT.',
  ' * Source of truth: shared/%NAME%',
  ' * Regenerate with:  npm run sync',
  ' * ============================================================ */',
  '',
].join('\n');

const check = process.argv.includes('--check');
let stale = 0;

for (const name of FILES) {
  const srcPath = resolve(root, 'shared', name);
  if (!existsSync(srcPath)) {
    console.error(`missing canonical file: shared/${name}`);
    process.exit(1);
  }
  const body = BANNER.replace('%NAME%', name) + readFileSync(srcPath, 'utf8');

  for (const dir of TARGET_DIRS) {
    const dst = resolve(root, dir, name);
    const current = existsSync(dst) ? readFileSync(dst, 'utf8') : null;
    if (current === body) {
      if (!check) console.log(`up to date  ${dir}/${name}`);
      continue;
    }
    if (check) {
      console.error(`STALE  ${dir}/${name} differs from shared/${name}`);
      stale++;
    } else {
      writeFileSync(dst, body, 'utf8');
      console.log(`written     ${dir}/${name}`);
    }
  }
}

if (check) {
  if (stale) {
    console.error(`\n${stale} copy/copies out of date. Run \`npm run sync\` and commit the result.`);
    process.exit(1);
  }
  console.log('all shared copies are in sync');
}
