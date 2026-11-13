# AI Chat History Auto-Delete (AI CHAD)

Chrome and Firefox extension for **claude.ai**: **delete chats older than X days** (you choose X; 30 is the default). Runs in your browser only. Nothing is sent to us.


**[Install the extension -->](https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/)**

Made by [Activist Checklist](https://activistchecklist.org/).

## Install

- **Chrome, Edge, Brave and other Chromium browsers:** [Chrome Web Store](https://chromewebstore.google.com/detail/ai-chat-history-auto-dele/ipmoefogkkpbgpbniklknonnmbmcbnpk)
- **Firefox 140 or newer (desktop):** [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/ai-chat-history-auto-delete/)
- Privacy policy: [activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html](https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html)


## Features

- **Delete chats older than X days** — You set X (e.g. 30). The extension deletes conversations **older than that many days**. That is the whole point.
- **Run on a schedule or not** — Once a day, once a week, once a month, or **never automatically** until you click Run. Out of the box it stays **manual-only** until you finish setup or change it.
- **“Run now”** — Kick off a delete pass whenever you want from Settings (or from the bar on claude.ai when something needs you).
- **Bar on claude.ai** — When a run is happening, just finished, or chats are waiting for you to confirm, you get a small top bar on the page. Dismiss it when you’re done reading it.
- **No list of what got deleted** — You might see a number (e.g. how many were removed last time). It doesn’t save chat names or links.

## Usage

1. **Click the extension icon** — Opens [claude.ai](https://claude.ai) (or focuses a tab you already have). If something is running, just finished, or needs you to confirm deletes, a **thin bar** appears at the top of the page. Close it when you’re done reading.
2. **Keep claude.ai open when you want work to happen** — Signed in, normal browser tab. The extension uses **your** login. It does **not** open Claude for you when a scheduled time hits—you have to have the site open.
3. **Make it go** — Use **Run now** in Settings, or wait for your schedule, or use the bar when it says there’s pending stuff.

### You need claude.ai open in a tab

If no **claude.ai** tab is open, the extension does **nothing**—it can’t see your session. When you **do** have a tab open and a run happens (scheduled or **Run now**), it deletes **every chat that is older than X days** based on the number you set—including chats that “became” older than X while you didn’t have a tab open.

## Security — What we don't store

No data ever leaves your computer. We don't record anything about the deleted chats except the total number deleted each time the extension runs.

We do NOT store:

- **Deleted chat IDs** — Never stored. Used only in memory during the API call to delete, then discarded.
- **Deleted chat names/titles** — Never stored. The activity log records only how many chats were deleted.
- **No external transmission** — All storage is local (the browser's `storage.local` extension storage). Nothing is sent to us or any third party.

**Privacy policy:** [PRIVACY.md](PRIVACY.md) (source) · [Web version](https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html)

## Build & packaging

Chrome extensions don’t compile to a single binary: you ship the **same files the browser loads** (manifest, JS modules, HTML, CSS, icons), usually as a **zip** for the Web Store or **unpacked folder** for local testing.

This repo uses an **allowlist-only** pack step so `dist/` and release zips never pick up tests, `discovery/`, source Tailwind input, env files, or other dev-only artifacts.

```bash
yarn install
yarn build
```

- Runs **Tailwind** (`build:css`) so `src/styles/auto-delete.css` is minified, then copies only listed runtime files into **`dist/`** (Chrome) and **`dist-firefox/`** (Firefox).
- Writes **`release/ai-chat-history-auto-delete-<version>-chrome.zip`** for Chrome and **`release/ai-chat-history-auto-delete-<version>-firefox.zip`** for Firefox Add-ons (version from `manifest.json`). A signed build adds **`-chrome.crx`**, which is what the Chrome Web Store takes. Releases up to 1.1.1 used the older names without `-chrome`.

Both builds ship the same files. Only `manifest.json` differs: the Firefox one is generated from the Chrome one by `scripts/lib/firefox-manifest.mjs`, which swaps the service worker for a background script, uses `options_ui`, and adds the Firefox add-on ID and "collects no data" declaration that addons.mozilla.org (AMO) requires.

To try a build locally:

- **Chrome:** `chrome://extensions` → **Load unpacked** → pick **`dist/`**.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick **`dist-firefox/manifest.json`**. It stays until Firefox restarts. `yarn web-ext run --source-dir dist-firefox` does the same in a fresh profile.

Options:

- `yarn build --target chrome` or `yarn build --target firefox` builds one browser only.
- `yarn build --no-zip` populates the build folders only.
- `yarn build --skip-css` skips Tailwind if you already ran `yarn build:css`.
- `yarn lint:firefox` builds the Firefox folder and runs Mozilla's `web-ext lint` on it, the same checks AMO runs on upload. `yarn release` runs it too.

When you add a new imported module or static asset, add its path to **`ALLOWLISTED_FILES`** in `scripts/build-extension.mjs` or the build will fail on purpose (so nothing is shipped by accident).

## Versioning & releasing

Versions are derived from **[Conventional Commits](https://www.conventionalcommits.org/)**. The commit type decides the bump:

| Commit | Bump | Example |
| --- | --- | --- |
| `fix:` | patch | `1.0.0` → `1.0.1` |
| `feat:` | minor | `1.0.0` → `1.1.0` |
| `feat!:` / `BREAKING CHANGE:` footer | major | `1.0.0` → `2.0.0` |
| `chore:` `docs:` `refactor:` `test:` `build:` `ci:` `style:` | none | — |

A **`commit-msg` hook runs commitlint**, so non-conforming messages are rejected at commit time. `manifest.json` is the source of truth for the version; `package.json` is kept in sync automatically.

Changelog and release-note links are hard-coded to github.com in `.versionrc.json`. Left to its defaults, the changelog tool builds them from the git remote, whose SSH host alias (`github.com-ac`) would end up in every link.

### One-time setup

CRX signing is **required** for a release, so point the build at your 1Password signing key:

```bash
cp .env.example .env
```

Then edit `.env` and paste your secret reference (in 1Password: right-click the field → **Copy Secret Reference**):

```
OP_SIGNING_KEY_REF="op://<vault>/<item>/private key"
```

`.env` is gitignored and holds only a *pointer* — the private key stays in 1Password and never lands in the repo. `yarn build` and `yarn release` load it automatically, so it does not need to be in your shell profile. A real environment variable still overrides it. You also need `op signin` and `gh auth login`.

### Releasing

```bash
yarn release
```

`yarn release` does the whole thing:

1. **Preflight** — clean tree, `gh` authenticated, `op` signed in, and the signing key actually resolves; then lint, tests and the Firefox lint. Every check runs *before* the version bump, so a misconfiguration can't leave a half-finished release behind.
2. **Bumps** the version from the commits since the last tag, writes `CHANGELOG.md`, commits, and tags.
3. **Validates** the new version against Chrome's rules (see the caveat below).
4. **Builds** the Chrome zip, the signed `.crx`, and the Firefox zip.
5. **Prompts**, then pushes the current branch + tag (`main` is fine for this project) and creates the GitHub release with the artifacts attached.
6. Prints what's left: `yarn publish:chrome` and `yarn publish:firefox`.

Flags:

- `yarn release:dry` — print every step and change nothing. It reads nothing from 1Password, so it builds without signing. **Run this first.**
- `yarn release --release-as minor` — override the inferred bump.
- `yarn release --first-release` — tag the *current* version as a baseline without bumping (needed once, since the repo has no tags yet).
- `yarn release --no-sign` — skip the CRX. The Web Store won't accept that release, because this listing only takes a signed CRX.
- `yarn release --yes` — skip the confirmation prompt.

Signing is on by default and the release **fails** if the key is missing or unresolvable — shipping unsigned should be a deliberate choice (`--no-sign`), not the side effect of an unset variable.

### Publishing to the Chrome Web Store

Run this after `yarn release`:

```bash
yarn publish:chrome
```

This listing uses verified uploads, so the store only accepts a CRX signed with the extension's key. That's why every release signs one. The script takes the release's `.crx`, checks that every file inside it matches the release tag, uploads it with the [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api), and submits it for review. The signing key isn't needed again, and commits after the release that only touch tooling or docs don't get in the way. The new version goes live when review passes. It refuses a version the store already has. `yarn publish:chrome:dry` does everything except reading the key and uploading, and `yarn publish:chrome --status` shows what the store has published and in review.

The API only updates the existing listing. Edit the listing text, screenshots and privacy answers in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).

**One-time setup:**

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project and enable the **Chrome Web Store API**.
2. [Create a service account](https://console.cloud.google.com/iam-admin/serviceaccounts) in that project. It needs no roles. Then create a JSON key for it.
3. In the Developer Dashboard, add the service account's email to your publisher, in the Account section. A publisher can have only one service account.
4. Paste the whole JSON key into one concealed field of a 1Password item, then delete the downloaded file.
5. In `.env`, set `CWS_PUBLISHER_ID` (from the dashboard's publisher settings) and `OP_CWS_SERVICE_ACCOUNT_REF` (that field's secret reference). See `.env.example`.

### Publishing to Firefox Add-ons (AMO)

Run this after `yarn release`:

```bash
yarn publish:firefox
```

It rebuilds the Firefox package, checks that every file in it matches the release tag, lints it, archives the tag's source for AMO's reviewers (they ask for it because the CSS is generated by Tailwind), and submits the version as a listed update with `web-ext sign`. Commits after the release that only touch tooling or docs don't get in the way. AMO signs it and reviews it; the new version goes live when review passes. `yarn publish:firefox:dry` does everything except the upload.

**One-time setup:**

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and accept the developer agreement.
2. Create an API key at [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/). Save the "JWT issuer" and "JWT secret" in 1Password.
3. Add their secret references to `.env` as `OP_AMO_API_KEY_REF` and `OP_AMO_API_SECRET_REF` (see `.env.example`). Or export `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` instead.

The very first submission also has to create the listing, so run it once as `yarn publish:firefox --first`. That sends the summary, description, category and license in [`store/amo-metadata.json`](store/amo-metadata.json). Later updates reuse the listing, so edit it on AMO from then on.

The add-on ID `ai-chat-history-auto-delete@activistchecklist.org` (in `scripts/lib/firefox-manifest.mjs`) is permanent once the add-on is listed. Never change it, or Firefox will treat updates as a different add-on.

### Chrome versions are not semver

The manifest accepts only **one to four dot-separated integers, each 0–65535** — no prerelease or build metadata. `1.1.0-beta.1` and `1.0.0+build5` are invalid and the Web Store rejects them. So follow semver's *major.minor.patch* shape but never its prerelease syntax; `--prerelease` is deliberately unsupported here.

Both `yarn build` and `yarn release` validate this (`scripts/lib/chrome-version.mjs`) so a bad version fails locally instead of at upload.

To inspect the bump without releasing: `yarn bump:dry`. Its closing hint mentions `yarn publish`, which this repo does not have — use `yarn release` instead.

## Architecture

- **Background**: Orchestrates flow, uses `chrome.scripting.executeScript` with `world: "MAIN"` to run fetch in page context (inherits your session). Chrome runs it as a service worker, Firefox as an event page; the code is the same and uses the `chrome.*` namespace, which Firefox supports with promises in MV3.
- **Provider interface**: Generic `loadChatsPage` / `deleteChats` so other chat providers can be added behind the same shape
- **Storage**: `chrome.storage.local` for settings and activity history

## Permissions

| Permission / access | Why |
|---------------------|-----|
| `storage` | Save your “older than X days” number, schedule, and local run counts on your device only. |
| `alarms` | Run scheduled deletion checks. |
| `tabs` | Find or focus claude.ai so work runs in your signed-in session. |
| `scripting` | Run logic in the page context on claude.ai as designed. |
| `notifications` | Optional browser notifications when chats are pending confirmation or need attention. |
| `https://claude.ai/*` | Only this origin—list/delete conversations per your settings. No other domains, no analytics. |
