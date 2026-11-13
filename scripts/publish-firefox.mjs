/**
 * Submits the Firefox build to addons.mozilla.org (AMO).
 *
 * Usage:
 *   yarn publish:firefox            # submit the released version as a listed update
 *   yarn publish:firefox --first    # first submission ever: also sends the listing
 *                                   # (summary, description, category, license) from
 *                                   # store/amo-metadata.json
 *   yarn publish:firefox --dry-run  # build, lint and print what would be uploaded; sends nothing
 *
 * Run it after `yarn release`, from the release commit. AMO reviewers get the exact source
 * of that tag, so HEAD must be tagged v<manifest version> and the tree must be clean.
 *
 * Credentials are an AMO API key ("JWT issuer") and secret from
 * https://addons.mozilla.org/developers/addon/api/key/. Either export WEB_EXT_API_KEY and
 * WEB_EXT_API_SECRET, or put 1Password references in .env as OP_AMO_API_KEY_REF and
 * OP_AMO_API_SECRET_REF. They reach web-ext only through its environment, never argv.
 *
 * AMO signs and reviews the upload. --approval-timeout 0 returns once the upload is
 * accepted; a listed version goes live on AMO when review passes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFileWithReport, formatEnvConflict } from './lib/env-file.mjs';
import { readOpSecret } from './lib/op-read.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_NAME = 'ai-chat-history-auto-delete';
const DIST_FIREFOX = path.join(ROOT, 'dist-firefox');
const RELEASE = path.join(ROOT, 'release');
const METADATA = path.join(ROOT, 'store', 'amo-metadata.json');

const { conflicts } = loadEnvFileWithReport(path.join(ROOT, '.env'));
for (const c of conflicts) console.warn(`⚠ ${formatEnvConflict(c)}`);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FIRST = argv.includes('--first');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) die(`\`${cmd} ${args.join(' ')}\` exited with status ${r.status}`);
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), status: r.status };
}

/** Env vars win; otherwise read both values from 1Password at the last moment. */
function resolveCredentials() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) {
    return { source: 'environment', read: () => ({}) };
  }
  const keyRef = process.env.OP_AMO_API_KEY_REF;
  const secretRef = process.env.OP_AMO_API_SECRET_REF;
  if (!keyRef || !secretRef) {
    if (DRY_RUN) return { source: '⚠ none configured (a real run needs them)', read: () => ({}) };
    die(
      'No AMO API credentials.\n' +
      '  Create them at https://addons.mozilla.org/developers/addon/api/key/ and either\n' +
      '  export WEB_EXT_API_KEY and WEB_EXT_API_SECRET, or add OP_AMO_API_KEY_REF and\n' +
      '  OP_AMO_API_SECRET_REF (1Password secret references) to .env.'
    );
  }
  const account = process.env.OP_ACCOUNT || null;
  return {
    source: '1Password (OP_AMO_API_KEY_REF, OP_AMO_API_SECRET_REF)',
    read: () => ({
      WEB_EXT_API_KEY: readOpSecret(spawnSync, keyRef, { account, envName: 'OP_AMO_API_KEY_REF' }).trim(),
      WEB_EXT_API_SECRET: readOpSecret(spawnSync, secretRef, { account, envName: 'OP_AMO_API_SECRET_REF' }).trim()
    })
  };
}

// ─── Preflight ───────────────────────────────────────────────────────────────

step('Preflight');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const tag = `v${version}`;
console.log(`  version: ${version}`);

const problems = [];
if (capture('git', ['status', '--porcelain']).out) {
  problems.push('Working tree is not clean; the uploaded source would not match the build.');
}
const headTags = capture('git', ['tag', '--points-at', 'HEAD']).out.split('\n').filter(Boolean);
if (!headTags.includes(tag)) {
  problems.push(`HEAD is not tagged ${tag}. Run \`yarn release\` first, then publish from that commit.`);
}
if (problems.length && !DRY_RUN) die(problems.join('\n  '));
for (const p of problems) console.log(`  ⚠ ${p} (allowed in dry-run)`);

const credentials = resolveCredentials();
console.log(`  credentials: ${credentials.source}`);
console.log(`  listing metadata: ${FIRST ? path.relative(ROOT, METADATA) : 'not sent (update)'}`);

// ─── Build + lint ────────────────────────────────────────────────────────────

step('Building the Firefox package');
run('node', ['scripts/build-extension.mjs', '--target', 'firefox']);

step('Linting with web-ext');
run('yarn', ['-s', 'web-ext', 'lint', '--source-dir', DIST_FIREFOX]);

// AMO asks for human-readable source when a package holds generated files (here, the
// minified Tailwind CSS). The tagged commit is exactly that.
step('Archiving source for AMO reviewers');
const sourceZip = path.join(RELEASE, `${PKG_NAME}-${version}-source.zip`);
fs.mkdirSync(RELEASE, { recursive: true });
run('git', ['archive', '--format=zip', '-o', sourceZip, 'HEAD']);
console.log(`  ${path.relative(ROOT, sourceZip)}`);

// ─── Submit ──────────────────────────────────────────────────────────────────

const signArgs = [
  '-s', 'web-ext', 'sign',
  '--channel', 'listed',
  '--source-dir', DIST_FIREFOX,
  '--artifacts-dir', path.join(RELEASE, 'amo'),
  '--upload-source-code', sourceZip,
  '--approval-timeout', '0',
  ...(FIRST ? ['--amo-metadata', METADATA] : [])
];

step(`Submitting ${version} to AMO`);
if (DRY_RUN) {
  console.log(`  [dry-run] yarn ${signArgs.join(' ')}`);
  console.log('\n✓ Dry run complete. Nothing was uploaded.');
  process.exit(0);
}

run('yarn', signArgs, { env: { ...process.env, ...credentials.read() } });

console.log(`\n✓ Submitted ${version} to AMO for review.`);
console.log('  Track it at https://addons.mozilla.org/developers/addons');
