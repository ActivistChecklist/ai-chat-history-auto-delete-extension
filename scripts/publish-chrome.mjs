/**
 * Submits the Chrome build to the Chrome Web Store through the Web Store API (v2).
 *
 * Usage:
 *   yarn publish:chrome            # upload the released version and submit it for review
 *   yarn publish:chrome --dry-run  # build and print what would be uploaded; sends nothing
 *   yarn publish:chrome --status   # show what the store has published and in review
 *
 * Run it after `yarn release`. The store must get exactly the tagged build, so the tag
 * v<manifest version> must exist, the tree must be clean, and every file in the built
 * package must match that tag byte for byte. Later commits that only touch tooling or
 * docs are fine.
 *
 * The API only updates an existing item. The store listing (text, screenshots, privacy
 * answers) is still edited in the Developer Dashboard.
 *
 * Auth is a Google Cloud service account that has been added to the publisher (see the
 * README). Its JSON key stays in 1Password: .env holds the secret reference
 * (OP_CWS_SERVICE_ACCOUNT_REF) and the publisher ID (CWS_PUBLISHER_ID). The key is read
 * only after the build and lint pass, and is never printed or passed on a command line.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFileWithReport, formatEnvConflict } from './lib/env-file.mjs';
import { readOpSecret } from './lib/op-read.mjs';
import {
  parseServiceAccountKey,
  getAccessToken,
  createWebStoreClient,
  summarizeStatus,
  uploadAndPublish
} from './lib/chrome-web-store.mjs';
import { listFiles, filesChangedSinceTag } from './lib/tagged-build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG_NAME = 'ai-chat-history-auto-delete';

/** The listing's ID in the store (its URL ends with it). Fixed for the life of the listing. */
const ITEM_ID = 'ipmoefogkkpbgpbniklknonnmbmcbnpk';

const { conflicts } = loadEnvFileWithReport(path.join(ROOT, '.env'));
for (const c of conflicts) console.warn(`⚠ ${formatEnvConflict(c)}`);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const STATUS_ONLY = argv.includes('--status');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) die(`\`${cmd} ${args.join(' ')}\` exited with status ${r.status}`);
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/** A file's bytes at a git revision, or null when it has no such file. */
function readAtRevision(rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const SETUP_HELP =
  '  See "Publishing to the Chrome Web Store" in README.md for the one-time setup.';

function missingConfig() {
  const missing = [];
  if (!process.env.CWS_PUBLISHER_ID) missing.push('CWS_PUBLISHER_ID');
  if (!process.env.OP_CWS_SERVICE_ACCOUNT_REF) missing.push('OP_CWS_SERVICE_ACCOUNT_REF');
  return missing;
}

/** Reads the service account key from 1Password and signs in. Runs only on a real call. */
async function connect() {
  const missing = missingConfig();
  if (missing.length) die(`Set ${missing.join(' and ')} in .env.\n${SETUP_HELP}`);
  let serviceAccount;
  try {
    serviceAccount = parseServiceAccountKey(readOpSecret(spawnSync, process.env.OP_CWS_SERVICE_ACCOUNT_REF, {
      account: process.env.OP_ACCOUNT || null,
      envName: 'OP_CWS_SERVICE_ACCOUNT_REF'
    }));
  } catch (err) {
    die(err.message);
  }
  console.log(`  signed in as ${serviceAccount.clientEmail}`);
  const accessToken = await getAccessToken(serviceAccount);
  return createWebStoreClient({ publisherId: process.env.CWS_PUBLISHER_ID, itemId: ITEM_ID, accessToken });
}

async function main() {
  if (STATUS_ONLY) {
    step(`Chrome Web Store status for ${ITEM_ID}`);
    const client = await connect();
    for (const line of summarizeStatus(await client.fetchStatus())) console.log(`  ${line}`);
    return;
  }

  // ─── Preflight ─────────────────────────────────────────────────────────────

  step('Preflight');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  const tag = `v${version}`;
  console.log(`  version: ${version}`);
  console.log(`  item: ${ITEM_ID}`);

  const problems = [];
  if (capture('git', ['status', '--porcelain'])) {
    problems.push('Working tree is not clean; the uploaded package would not match the release.');
  }
  const tagExists = !!capture('git', ['tag', '--list', tag]);
  if (!tagExists) {
    problems.push(`There is no tag ${tag}. Run \`yarn release\` first.`);
  }
  const missing = missingConfig();
  if (missing.length) problems.push(`Set ${missing.join(' and ')} in .env.\n${SETUP_HELP}`);
  if (problems.length && !DRY_RUN) die(problems.join('\n  '));
  for (const p of problems) console.log(`  ⚠ ${p} (allowed in dry-run)`);
  if (!missing.length) console.log(`  publisher: ${process.env.CWS_PUBLISHER_ID}`);

  // ─── Build ─────────────────────────────────────────────────────────────────

  step('Building the Chrome package');
  run('node', ['scripts/build-extension.mjs', '--target', 'chrome']);
  const zipPath = path.join(ROOT, 'release', `${PKG_NAME}-${version}.zip`);
  if (!fs.existsSync(zipPath)) die(`Expected zip not found: ${zipPath}`);
  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);

  if (tagExists) {
    const built = listFiles(DIST);
    const changed = filesChangedSinceTag(
      built,
      (p) => fs.readFileSync(path.join(DIST, p)),
      (p) => readAtRevision(tag, p)
    );
    if (changed.length) {
      const msg = `The package differs from ${tag} in:\n    ${changed.join('\n    ')}\n` +
        '  Release those changes first, so the store gets a tagged build.';
      if (!DRY_RUN) die(msg);
      console.log(`  ⚠ ${msg} (allowed in dry-run)`);
    } else {
      console.log(`  all ${built.length} files match ${tag}`);
    }
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  step(`Submitting ${version} to the Chrome Web Store`);
  if (DRY_RUN) {
    console.log(`  [dry-run] would upload ${path.relative(ROOT, zipPath)} (${sizeKb} KB) and submit it for review`);
    console.log('\n✓ Dry run complete. Nothing was read from 1Password or uploaded.');
    return;
  }

  const client = await connect();
  const { before, publish } = await uploadAndPublish(client, fs.readFileSync(zipPath), version, {
    log: (phase) => console.log(`  ${phase}…`)
  });
  for (const line of summarizeStatus(before)) console.log(`  before: ${line}`);
  for (const w of publish.warningInfo?.warnings ?? []) {
    console.log(`  ⚠ ${w.reason}: ${w.description}`);
  }

  console.log(`\n✓ Submitted ${version} to the Chrome Web Store (state: ${publish.state ?? 'unknown'}).`);
  console.log('  It goes live when review passes. Check with `yarn publish:chrome --status`.');
}

main().catch((err) => die(err.message));
