/**
 * One-command release.
 *
 * Bumps the version from Conventional Commits, updates the changelog, commits, tags,
 * builds the Chrome Web Store zip (and signed CRX) and the Firefox zip, pushes, and
 * publishes a GitHub release.
 *
 * Usage:
 *   yarn release                    # full flow (prompts before anything is pushed)
 *   yarn release --dry-run          # print every step, change nothing, read no secrets
 *   yarn release --release-as minor # override the bump the commits imply
 *   yarn release --first-release    # tag the CURRENT version as a baseline, no bump
 *   yarn release --yes              # skip the confirmation prompt
 *   yarn release --skip-checks      # skip lint + tests (not recommended)
 *   yarn release --no-sign          # skip CRX signing (zip is still produced)
 *
 * OP_SIGNING_KEY_REF is read from .env (gitignored) or the environment; see .env.example.
 * Signing is required by default — release fails rather than silently shipping unsigned.
 *
 * Bump is inferred from commit types since the last tag:
 *   fix: -> patch     feat: -> minor     BREAKING CHANGE / feat!: -> major
 *
 * Requires:
 *   - gh CLI authenticated (gh auth login)
 *   - op CLI signed in (op signin) and OP_SIGNING_KEY_REF set in .env
 *
 * Steps:
 *   1. Preflight: clean tree, gh authenticated, signing key resolves, lint + tests +
 *      Firefox lint (web-ext) pass
 *   2. Bump version + changelog + commit + tag (commit-and-tag-version)
 *   3. Validate the new version is legal for Chrome (not just legal semver)
 *   4. Build Chrome zip (+ signed CRX) and Firefox zip
 *   5. Confirm, then push branch + tag
 *   6. Create the GitHub release with the artifacts and changelog notes
 *   7. Print the remaining steps (Chrome Web Store upload, `yarn publish:firefox`)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertChromeVersion } from './lib/chrome-version.mjs';
import { diagnoseSigning, signingRefProblem, makeOpRunners, formatSigningFailure } from './lib/signing.mjs';
import { loadEnvFileWithReport, formatEnvConflict } from './lib/env-file.mjs';
import { releaseFileNames } from './lib/release-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Pick up OP_SIGNING_KEY_REF (and anything else) from .env so it does not have to live
// in a shell profile. Real environment variables still win — and when they disagree with
// .env we say so, because that precedence is otherwise invisible.
const ENV_FILE = path.join(ROOT, '.env');
const { conflicts: ENV_CONFLICTS } = loadEnvFileWithReport(ENV_FILE);

// ─── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const DRY_RUN = has('--dry-run');
const ASSUME_YES = has('--yes') || has('-y');
const SKIP_CHECKS = has('--skip-checks');
const FIRST_RELEASE = has('--first-release');
const NO_SIGN = has('--no-sign');

const releaseAsIndex = argv.indexOf('--release-as');
const RELEASE_AS = releaseAsIndex !== -1 ? argv[releaseAsIndex + 1] : null;
if (releaseAsIndex !== -1 && !['patch', 'minor', 'major'].includes(RELEASE_AS)) {
  die('--release-as must be one of: patch, minor, major');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
}

/** Runs a mutating command. Skipped (and logged) in dry-run. */
function run(cmd, args, opts = {}) {
  if (DRY_RUN && !opts.evenInDryRun) {
    console.log(`  [dry-run] ${cmd} ${args.join(' ')}`);
    return;
  }
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) die(`\`${cmd} ${args.join(' ')}\` exited with status ${r.status}`);
}

/** Read-only command; always runs, even in dry-run. */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

function readManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (!manifest.version) die('manifest.json is missing a version field.');
  return manifest.version;
}

async function confirm(question) {
  if (ASSUME_YES || DRY_RUN) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ─── 1. Preflight ────────────────────────────────────────────────────────────

step('Preflight');

// Releasing from main is allowed in this project (see AGENTS.md).
for (const conflict of ENV_CONFLICTS) {
  console.log(`  ⚠ ${formatEnvConflict(conflict).split('\n').join('\n  ')}`);
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
console.log(`  branch: ${branch}`);

const dirty = capture('git', ['status', '--porcelain']).out;
if (dirty && !DRY_RUN) {
  die(`Working tree is not clean. Commit or stash first:\n${dirty}`);
}
if (dirty && DRY_RUN) {
  console.log('  ⚠ working tree is dirty (allowed in dry-run)');
} else {
  console.log('  working tree: clean');
}

const ghAuth = capture('gh', ['auth', 'status']);
if (ghAuth.status !== 0) {
  const detail = ghAuth.err || ghAuth.out || 'gh not found';
  if (DRY_RUN) console.log(`  ⚠ gh not authenticated (${detail.split('\n')[0]})`);
  else die(`gh CLI is not authenticated. Run: gh auth login\n${detail}`);
} else {
  console.log('  gh: authenticated');
}

// Signing is on by default: an unsigned release should be a deliberate choice, not the
// consequence of a missing variable. Everything here runs BEFORE the version bump so a
// misconfigured key never leaves a dangling bump commit behind.
const willSign = !NO_SIGN;
if (!willSign) {
  console.log('  ⚠ signing disabled via --no-sign (zip only, no CRX)');
} else if (DRY_RUN) {
  // A dry run reads nothing from 1Password: only the reference itself is checked.
  const refProblem = signingRefProblem(process.env.OP_SIGNING_KEY_REF);
  if (refProblem) {
    console.log(`  ⚠ ${formatSigningFailure(refProblem).split('\n').join('\n  ')}`);
  } else {
    console.log('  signing: OP_SIGNING_KEY_REF is set (not read in a dry run)');
  }
} else {
  // Everything here runs BEFORE the version bump so a misconfigured key never leaves a
  // dangling bump commit behind.
  const opAccount = process.env.OP_ACCOUNT || null;
  const diag = diagnoseSigning(
    process.env.OP_SIGNING_KEY_REF,
    makeOpRunners(spawnSync, ROOT, opAccount),
    { hasDesktopApp: fs.existsSync('/Applications/1Password.app'), account: opAccount }
  );
  if (!diag.ok) {
    die(formatSigningFailure(diag));
  }
  console.log(
    `  signing: key resolves (${diag.ref.replace(/[^/]+$/, '…')}` +
    `${diag.account ? `, account ${diag.account}` : ''})`
  );
  if (diag.note) console.log(`  ⚠ ${diag.note}`);
}

if (SKIP_CHECKS) {
  console.log('  ⚠ skipping lint + tests (--skip-checks)');
} else {
  step('Running lint + tests');
  run('yarn', ['lint'], { evenInDryRun: true });
  run('yarn', ['test'], { evenInDryRun: true });
  // Builds the Firefox package from the pre-bump tree and runs Mozilla's linter, so an
  // AMO rejection shows up here instead of after the version is committed.
  run('yarn', ['lint:firefox'], { evenInDryRun: true });
}

// ─── 2. Bump + changelog + commit + tag ──────────────────────────────────────

const versionBefore = readManifestVersion();
step(`Bumping version (current: ${versionBefore})`);

const catvArgs = [];
if (DRY_RUN) catvArgs.push('--dry-run');
if (FIRST_RELEASE) catvArgs.push('--first-release');
if (RELEASE_AS) catvArgs.push('--release-as', RELEASE_AS);

// commit-and-tag-version writes manifest.json + package.json, CHANGELOG.md,
// then commits and tags. Config lives in .versionrc.json.
run('yarn', ['commit-and-tag-version', ...catvArgs], { evenInDryRun: true });

const version = DRY_RUN ? versionBefore : readManifestVersion();
const tag = `v${version}`;

if (!DRY_RUN && !FIRST_RELEASE && version === versionBefore) {
  die(
    'Version did not change. There are probably no releasable commits since the last ' +
    'tag.\n  Use --release-as patch to force a bump.'
  );
}

// ─── 3. Validate for Chrome (stricter than semver) ───────────────────────────

step(`Validating version ${version} for the Web Store`);
try {
  assertChromeVersion(version);
  console.log(`  ${version} is a legal Chrome extension version`);
} catch (err) {
  die(
    `${err.message}\n\n  The bump has already been committed. To undo:\n` +
    `    git tag -d ${tag}\n    git reset --hard HEAD~1`
  );
}

// package.json is not read by Chrome, but drift is confusing — verify the sync worked.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!DRY_RUN && pkgVersion !== version) {
  die(`package.json (${pkgVersion}) and manifest.json (${version}) disagree; check .versionrc.json bumpFiles.`);
}
console.log(`  package.json and manifest.json agree (${pkgVersion})`);

// ─── 4. Build artifacts ──────────────────────────────────────────────────────

step('Building release artifacts');
// Signing reads the key from 1Password, so a dry run builds without it.
run('yarn', ['build', ...(willSign && !DRY_RUN ? ['--sign'] : [])], { evenInDryRun: true });
if (willSign && DRY_RUN) console.log('  [dry-run] would sign the Chrome build into a CRX');

const releaseFiles = releaseFileNames(version);
const zipPath = path.join(ROOT, 'release', releaseFiles.chromeZip);
const firefoxZipPath = path.join(ROOT, 'release', releaseFiles.firefoxZip);
const crxPath = path.join(ROOT, 'release', releaseFiles.chromeCrx);
const assets = [];

if (!DRY_RUN) {
  if (!fs.existsSync(zipPath)) die(`Expected zip not found: ${zipPath}`);
  if (!fs.existsSync(firefoxZipPath)) die(`Expected Firefox zip not found: ${firefoxZipPath}`);
  assets.push(zipPath, firefoxZipPath);
  if (willSign) {
    if (!fs.existsSync(crxPath)) die(`Expected CRX not found: ${crxPath}`);
    assets.push(crxPath);
  }
  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`  zip: ${path.relative(ROOT, zipPath)} (${sizeKb} KB)`);
  console.log(`  firefox zip: ${path.relative(ROOT, firefoxZipPath)}`);
  if (willSign) console.log(`  crx: ${path.relative(ROOT, crxPath)}`);
}

// ─── 5. Release notes from the changelog ─────────────────────────────────────

/** Pulls just this version's section out of CHANGELOG.md. */
function extractNotes(ver) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  const text = fs.readFileSync(changelogPath, 'utf8');
  // Sections start with "## [x.y.z]" or "## x.y.z"
  const escaped = ver.replace(/\./g, '\\.');
  const re = new RegExp(`^##+ \\[?${escaped}\\]?.*$`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##+ \[?\d/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim() || null;
}

const notes = extractNotes(version)
  || capture('git', ['log', '-1', '--pretty=format:- %s (%h)']).out;

console.log('\n── Release notes ──────────────────────────────────────────────');
console.log(notes);
console.log('───────────────────────────────────────────────────────────────');

// ─── 6. Push + GitHub release ────────────────────────────────────────────────

const proceed = await confirm(
  `\nPush ${branch} + ${tag} to origin and publish GitHub release ${tag}?`
);
if (!proceed) {
  console.log(
    `\nStopped before pushing. The bump commit and tag ${tag} exist locally.\n` +
    `  To undo:   git tag -d ${tag} && git reset --hard HEAD~1\n` +
    `  To resume: git push origin ${branch} --follow-tags && ` +
    `gh release create ${tag} ${assets.map((a) => path.relative(ROOT, a)).join(' ')}`
  );
  process.exit(0);
}

step('Pushing branch + tag');
run('git', ['push', 'origin', branch, '--follow-tags']);

step(`Creating GitHub release ${tag}`);
const notesFile = path.join(os.tmpdir(), `release-notes-${version}.md`);
if (!DRY_RUN) fs.writeFileSync(notesFile, notes, 'utf8');
run('gh', ['release', 'create', tag, ...assets, '--title', tag, '--notes-file', notesFile]);
if (!DRY_RUN && fs.existsSync(notesFile)) fs.unlinkSync(notesFile);

// ─── 7. What's left ──────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n✓ Dry run complete — nothing was committed, pushed, or published.');
} else {
  console.log(`\n✓ Released ${tag}.`);
  console.log('\nRemaining steps (run from this commit):');
  console.log('  Chrome Web Store:       yarn publish:chrome');
  console.log('  Firefox Add-ons (AMO):  yarn publish:firefox');
}
