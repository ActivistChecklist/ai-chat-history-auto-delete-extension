# Project instructions

## Git

**Committing directly to `main` is allowed in this project.** This overrides the global
"never commit directly to main" rule in the user-level CLAUDE.md — that rule does not
apply here. Release commits and tags may be made on `main`.

## Releasing

Versions come from Conventional Commits (`fix:` → patch, `feat:` → minor, `feat!:` /
`BREAKING CHANGE:` → major). A `commit-msg` hook runs commitlint, so commit messages
must carry a valid type prefix.

Only the **prefix** is enforced. Subject prose is not policed — this repo's style is
sentence-case (`feat: Add conventional commits`), which is fine; only ALL-CAPS subjects
are rejected. Merge, revert, `fixup!` and `squash!` commits are exempt.

- `yarn release:dry` — always run this first; it changes nothing and reads nothing from
  1Password.
- `yarn release` — bump, changelog, commit, tag, build, push, GitHub release.
- `yarn publish:chrome` and `yarn publish:firefox` then submit the tagged build to each
  store. Both read API credentials from 1Password; `:dry` variants read nothing.

`manifest.json` is the source of truth for the version. `package.json` is kept in sync
by `.versionrc.json`.

**Chrome versions are not semver.** One to four dot-separated integers, each 0–65535,
no prerelease or build metadata. `1.1.0-beta.1` is valid semver and *invalid* here.
Enforced by `scripts/lib/chrome-version.mjs` in both `yarn build` and `yarn release`.

**CRX signing is expected for every release.** The signing key reference lives in
`OP_SIGNING_KEY_REF` (see `.env.example`); `yarn release` fails without it rather than
silently shipping an unsigned release. Use `--no-sign` only deliberately.

## Build

`scripts/build-extension.mjs` copies an **allowlist** into `dist/`. When you add a new
runtime module or asset, add its path to `ALLOWLISTED_FILES` or the build fails on
purpose — that is what keeps tests, `discovery/`, and dev files out of shipped zips.

## Architecture notes

- **Deletion is API-based**, not DOM scraping: `POST /api/organizations/{org}/chat_conversations/delete_many`.
  Claude UI redesigns do not break deletion; they break *injection*.
- **The sidebar badge's DOM anchor is the fragile part.** `src/shared/badge-insertion.js`
  targets `[data-testid="sidebar-recents"]` → `[data-row-key="label:recents"]` with five
  layered fallbacks, and is unit-tested. If the badge stops appearing after a Claude
  redesign, look there first.
- Content scripts must stay **classic scripts** (no `"type": "module"` in the manifest);
  the ES module graph is pulled in via dynamic `import()` of web-accessible resources.
