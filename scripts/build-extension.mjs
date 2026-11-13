/**
 * Production packaging for the Chrome and Firefox extensions (MV3).
 *
 * Approach (aligned with common extension + security practice):
 * - Allowlist-only copy: only known runtime files go into the build dir (no broad "copy src/").
 * - Fresh Tailwind build so shipped CSS is minified and matches input.css.
 * - Store-ready .zip with manifest.json at the archive root (Chrome Web Store, AMO, "Load unpacked").
 * - Never copies dev-only trees (tests, discovery, node_modules, Tailwind source, env files, keys).
 * - Both browsers ship the same files. Only manifest.json differs, derived for Firefox by
 *   scripts/lib/firefox-manifest.mjs.
 *
 * Usage:
 *   yarn build                     # CSS + dist/ + dist-firefox/ + release/*.zip
 *   yarn build --target chrome     # dist/ + release/<name>-<version>.zip
 *   yarn build --target firefox    # dist-firefox/ + release/<name>-<version>-firefox.zip
 *   yarn build --no-zip            # build dirs only
 *   yarn build --skip-css
 *   yarn build --sign              # also sign the Chrome build into a .crx
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { assertChromeVersion } from './lib/chrome-version.mjs';
import { toFirefoxManifest, GECKO_ID } from './lib/firefox-manifest.mjs';
import { loadEnvFileWithReport } from './lib/env-file.mjs';
import { readOpSecret } from './lib/op-read.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env so OP_SIGNING_KEY_REF works for `yarn build --sign` without shell setup.
// Real environment variables take precedence; release.mjs reports any disagreement.
const ENV_FILE = path.join(ROOT, '.env');
const { conflicts: ENV_CONFLICTS } = loadEnvFileWithReport(ENV_FILE);
for (const c of ENV_CONFLICTS) {
  console.warn(`Warning: ${c.key} differs between your shell and .env; shell value wins.`);
}
const DIST = path.join(ROOT, 'dist');
const DIST_FIREFOX = path.join(ROOT, 'dist-firefox');
const RELEASE = path.join(ROOT, 'release');
const PKG_NAME = 'ai-chat-history-auto-delete';

/** Per-browser output. Chrome keeps the original dist/ and zip names. */
const TARGETS = {
  chrome: { dist: DIST, zipSuffix: '' },
  firefox: { dist: DIST_FIREFOX, zipSuffix: '-firefox' }
};

/** Every file the extension loads at runtime — update when you add modules or static assets. */
const ALLOWLISTED_FILES = [
  'manifest.json',
  'src/background.js',
  'src/content/sidebar-badge.js',
  'src/content/sidebar-badge.css',
  'src/options/options.html',
  'src/options/options.js',
  'src/onboarding/onboarding.html',
  'src/onboarding/onboarding.js',
  'src/shared/alarms.js',
  'src/shared/constants.js',
  'src/shared/dom.js',
  'src/shared/badge-insertion.js',
  'src/shared/modal.css',
  'src/shared/pending-deletion-modal.js',
  'src/shared/run-frequency-fieldset.js',
  'src/shared/run-threshold.js',
  'src/shared/storage.js',
  'src/providers/claude.js',
  'src/providers/registry.js',
  'src/styles/auto-delete.css'
];

const FORBIDDEN_NAMES = ['.env', '.pem', '.key', 'credentials'];

function parseArgs(argv) {
  const set = new Set(argv);
  const targetIndex = argv.indexOf('--target');
  const target = targetIndex === -1 ? 'all' : argv[targetIndex + 1];
  if (!['all', 'chrome', 'firefox'].includes(target)) {
    throw new Error('--target must be one of: all, chrome, firefox');
  }
  const sign = set.has('--sign');
  if (sign && target === 'firefox') {
    throw new Error('--sign only applies to the Chrome build; Firefox builds are signed by AMO');
  }
  return {
    noZip: set.has('--no-zip'),
    skipCss: set.has('--skip-css'),
    sign,
    targets: target === 'all' ? ['chrome', 'firefox'] : [target]
  };
}

// ─── CRX signing via 1Password CLI ───────────────────────────────────────────

/**
 * Returns the path to the Chrome (or Chromium) executable, or null if not found.
 * Needed because macOS Chrome lives in a long path, not on $PATH.
 */
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser'
  ];
  for (const c of candidates) {
    if (c.startsWith('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      const r = spawnSync('which', [c], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return null;
}

/**
 * Reads the private key PEM from 1Password using the `op` CLI.
 * Requires OP_SIGNING_KEY_REF to be set, e.g.:
 *   export OP_SIGNING_KEY_REF="op://Personal/Chrome Extension Signing Key/private key"
 */
function readKeyFrom1Password() {
  return readOpSecret(spawnSync, process.env.OP_SIGNING_KEY_REF, {
    account: process.env.OP_ACCOUNT || null,
    envName: 'OP_SIGNING_KEY_REF'
  });
}

/**
 * Signs dist/ into a .crx using Chrome's --pack-extension.
 * Key is pulled from 1Password, written to a temp file, used, then wiped.
 * Returns the path to the produced .crx in release/.
 */
async function signExtension(version) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      'Chrome/Chromium executable not found.\n' +
      'Install Chrome or ensure it is on your PATH.'
    );
  }

  console.log('Retrieving signing key from 1Password…');
  const keyPem = readKeyFrom1Password();

  // Write to a temp file — mode 0o600 so only the current user can read it
  const tmpKey = path.join(os.tmpdir(), `crx-signing-key-${process.pid}.pem`);
  try {
    fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });

    console.log('Signing extension with Chrome…');
    // Chrome requires flag=value syntax (not space-separated) for --pack-extension on macOS.
    // Writes <parent-of-dist>/dist.crx — i.e. <ROOT>/dist.crx
    const r = spawnSync(chrome, [
      `--pack-extension=${DIST}`,
      `--pack-extension-key=${tmpKey}`
    ], { cwd: ROOT, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`Chrome signing exited with status ${r.status}`);

    const crxSrc = path.join(ROOT, 'dist.crx');
    if (!fs.existsSync(crxSrc)) {
      throw new Error('dist.crx not found after Chrome pack — did the signing succeed?');
    }

    // Verify CRX3 magic bytes ("Cr24" = 0x43 0x72 0x32 0x34)
    const magic = Buffer.alloc(4);
    const fd = fs.openSync(crxSrc, 'r');
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString('ascii') !== 'Cr24') {
      throw new Error(
        `CRX magic bytes invalid — got ${JSON.stringify(magic.toString('ascii'))} ` +
        `(expected "Cr24"). The file is likely a bare zip; signing may have failed.`
      );
    }
    console.log('CRX magic bytes verified (Cr24 ✓)');

    const crxName = `${PKG_NAME}-${safeVersionString(version)}.crx`;
    const crxDest = path.join(RELEASE, crxName);
    fs.mkdirSync(RELEASE, { recursive: true });
    if (fs.existsSync(crxDest)) fs.unlinkSync(crxDest);
    fs.renameSync(crxSrc, crxDest);

    console.log(`CRX:  ${crxDest}`);
    return crxDest;
  } finally {
    // Always wipe the temp key — overwrite with zeros first, then delete
    if (fs.existsSync(tmpKey)) {
      try {
        const len = fs.statSync(tmpKey).size;
        fs.writeFileSync(tmpKey, Buffer.alloc(len, 0));
      } catch { /* best-effort */ }
      fs.unlinkSync(tmpKey);
    }
  }
}

function assertSafeSourcePath(absPath, label) {
  const rel = path.relative(ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path (${label}): ${absPath}`);
  }
  if (FORBIDDEN_NAMES.some((n) => rel.split(path.sep).includes(n))) {
    throw new Error(`Refusing to package forbidden segment in path: ${rel}`);
  }
}

function copyAllowlistedFile(relPath, distDir) {
  const src = path.join(ROOT, relPath);
  assertSafeSourcePath(src, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required file (update allowlist or restore file): ${relPath}`);
  }
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${relPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${relPath}`);
  }
  const dest = path.join(distDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyIcons(distDir) {
  const iconsDir = path.join(ROOT, 'icons');
  assertSafeSourcePath(iconsDir, 'icons');
  if (!fs.existsSync(iconsDir)) {
    throw new Error('Missing icons/ directory');
  }
  const destRoot = path.join(distDir, 'icons');
  fs.mkdirSync(destRoot, { recursive: true });
  for (const name of fs.readdirSync(iconsDir)) {
    if (!name.endsWith('.png')) continue;
    const src = path.join(iconsDir, name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink: icons/${name}`);
    }
    if (!st.isFile()) continue;
    fs.copyFileSync(src, path.join(destRoot, name));
  }
}

function runTailwindBuild() {
  const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
  const r = spawnSync(yarn, ['build:css'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`Tailwind build failed with exit ${r.status}`);
  }
}

function validateManifest(manifestPath, target) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const m = JSON.parse(raw);
  if (m.manifest_version !== 3) {
    throw new Error('manifest.json must be manifest_version 3');
  }
  if (!m.name || !m.version) {
    throw new Error('manifest.json must include name and version');
  }
  // Catch an illegal version here rather than at Web Store upload time.
  assertChromeVersion(m.version);
  const csp = m.content_security_policy?.extension_pages;
  if (typeof csp === 'string' && csp.includes('unsafe-eval')) {
    throw new Error('Refusing to ship extension_pages CSP containing unsafe-eval');
  }
  if (target === 'firefox') {
    if (m.background?.service_worker || !m.background?.scripts?.length) {
      throw new Error('Firefox manifest must use background.scripts, not a service worker');
    }
    if (m.browser_specific_settings?.gecko?.id !== GECKO_ID) {
      throw new Error(`Firefox manifest must carry the gecko id ${GECKO_ID}`);
    }
  }
  return m;
}

/** Rewrites the copied manifest.json in a build dir into its Firefox form. */
function writeFirefoxManifest(distDir) {
  const manifestPath = path.join(distDir, 'manifest.json');
  const chromeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, `${JSON.stringify(toFirefoxManifest(chromeManifest), null, 2)}\n`);
}

function safeVersionString(version) {
  return String(version).replace(/[^0-9a-z._-]+/gi, '-');
}

function zipDist(version, distDir, zipSuffix) {
  const zipName = `${PKG_NAME}-${safeVersionString(version)}${zipSuffix}.zip`;
  const zipPath = path.join(RELEASE, zipName);
  fs.mkdirSync(RELEASE, { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => {
      console.log(`\nZip: ${zipPath} (${archive.pointer()} bytes)`);
      resolve(zipPath);
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(distDir, false);
    archive.finalize();
  });
}

async function buildTarget(target, { noZip }) {
  const { dist, zipSuffix } = TARGETS[target];
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  console.log(`Copying allowlisted extension files (${target})…`);
  for (const rel of ALLOWLISTED_FILES) {
    copyAllowlistedFile(rel, dist);
  }
  copyIcons(dist);
  if (target === 'firefox') writeFirefoxManifest(dist);

  const manifest = validateManifest(path.join(dist, 'manifest.json'), target);
  const loadHint = target === 'firefox'
    ? 'load it from about:debugging → This Firefox → Load Temporary Add-on, picking manifest.json in'
    : 'load unpacked from';
  console.log(`${path.relative(ROOT, dist)}/ ready (${target}): ${loadHint}\n  ${dist}`);

  if (!noZip) {
    await zipDist(manifest.version, dist, zipSuffix);
  }
  return manifest;
}

async function main() {
  const { noZip, skipCss, sign, targets } = parseArgs(process.argv.slice(2));

  if (!skipCss) {
    console.log('Running Tailwind (minify)…');
    runTailwindBuild();
  }

  for (const target of targets) {
    const manifest = await buildTarget(target, { noZip });
    if (sign && target === 'chrome') {
      await signExtension(manifest.version);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
