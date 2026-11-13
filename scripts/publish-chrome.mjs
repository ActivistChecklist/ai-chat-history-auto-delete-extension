/**
 * Submits the release's signed CRX to the Chrome Web Store through the Web Store API (v2).
 *
 * Usage:
 *   yarn publish:chrome            # upload the released version and submit it for review
 *   yarn publish:chrome --dry-run  # check the package and print what would be uploaded
 *   yarn publish:chrome --status   # show what the store has published and in review
 *
 * Run it after `yarn release`. This listing uses verified uploads, so the store only
 * accepts a CRX signed with the extension's private key, which `yarn release` makes. The
 * script uploads that file unchanged after checking that every file inside it matches
 * the tag v<manifest version> byte for byte. Commits after the release that only touch
 * tooling or docs are fine, and the signing key is not needed again.
 *
 * The API only updates an existing item. The store listing (text, screenshots, privacy
 * answers) is still edited in the Developer Dashboard.
 *
 * Auth is a Google Cloud service account that has been added to the publisher (see the
 * README). Its JSON key stays in 1Password: .env holds the secret reference
 * (OP_CWS_SERVICE_ACCOUNT_REF) and the publisher ID (CWS_PUBLISHER_ID). The key is read
 * only after the package checks pass, and is never printed or passed on a command line.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFileWithReport, formatEnvConflict } from './lib/env-file.mjs';
import { readOpSecret } from './lib/op-read.mjs';
import {
  crxZipPayload,
  parseServiceAccountKey,
  getAccessToken,
  createWebStoreClient,
  summarizeStatus,
  uploadAndPublish
} from './lib/chrome-web-store.mjs';
import { listFiles, filesChangedSinceTag } from './lib/tagged-build.mjs';
import { releaseFileNames } from './lib/release-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

/** In a dry run a problem is reported and the run continues; otherwise it stops. */
function problem(msg) {
  if (!DRY_RUN) die(msg);
  console.log(`  ⚠ ${msg} (allowed in dry-run)`);
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

/** Paths inside the CRX whose bytes differ from the tag (or that the tag lacks). */
function crxFilesChangedSinceTag(crx, tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-crx-'));
  try {
    const zipPath = path.join(tmp, 'payload.zip');
    const filesDir = path.join(tmp, 'files');
    fs.writeFileSync(zipPath, crxZipPayload(crx));
    const unzip = spawnSync('unzip', ['-q', zipPath, '-d', filesDir], { encoding: 'utf8' });
    if (unzip.error || unzip.status !== 0) {
      die(`Could not unpack the CRX: ${unzip.error?.message || unzip.stderr.trim()}`);
    }
    const files = listFiles(filesDir);
    const changed = filesChangedSinceTag(
      files,
      (p) => fs.readFileSync(path.join(filesDir, p)),
      (p) => readAtRevision(tag, p)
    );
    return { files, changed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

  const missing = missingConfig();
  if (missing.length) problem(`Set ${missing.join(' and ')} in .env.\n${SETUP_HELP}`);
  else console.log(`  publisher: ${process.env.CWS_PUBLISHER_ID}`);

  // ─── Package ───────────────────────────────────────────────────────────────

  step('Checking the signed package');
  const crxName = releaseFileNames(version).chromeCrx;
  const crxPath = path.join(ROOT, 'release', crxName);
  if (!fs.existsSync(crxPath)) {
    die(
      `No signed package at release/${crxName}.\n` +
      '  The store only accepts a CRX signed with the extension\'s key. `yarn release` makes one\n' +
      '  (unless run with --no-sign), and the GitHub release has it attached.'
    );
  }
  const crx = fs.readFileSync(crxPath);
  console.log(`  ${path.relative(ROOT, crxPath)} (${Math.round(crx.length / 1024)} KB)`);

  if (!readAtRevision(tag, 'manifest.json')) {
    problem(`There is no tag ${tag}. Run \`yarn release\` first.`);
  } else {
    const { files, changed } = crxFilesChangedSinceTag(crx, tag);
    if (changed.length) {
      problem(
        `The CRX differs from ${tag} in:\n    ${changed.join('\n    ')}\n` +
        '  Publish only a package made by `yarn release` for this version.'
      );
    } else {
      console.log(`  all ${files.length} files inside match ${tag}`);
    }
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  step(`Submitting ${version} to the Chrome Web Store`);
  if (DRY_RUN) {
    console.log(`  [dry-run] would upload ${crxName} and submit it for review`);
    console.log('\n✓ Dry run complete. Nothing was read from 1Password or uploaded.');
    return;
  }

  const client = await connect();
  const { before, publish } = await uploadAndPublish(client, { bytes: crx, fileName: crxName }, version, {
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
