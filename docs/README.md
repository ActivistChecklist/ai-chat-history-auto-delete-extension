# GitHub Pages (project site)

This folder is the **static marketing site** and the **canonical privacy policy URL** for the Chrome Web Store, Firefox Add-ons (AMO) and other listings.

## Live URLs (after Pages is enabled)

With the default GitHub Pages setup for this repo:

- Site: `https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/`
- Privacy policy: `https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html`

Use the privacy URL in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) under **Privacy practices**. AMO only requires a privacy policy for add-ons that collect or transmit user data, but one can still be added on the listing's **Edit Product Page**.

## Enable GitHub Pages

1. Repo **Settings** → **Pages**.
2. **Build and deployment** → **Source**: *Deploy from a branch*.
3. **Branch**: `main` (or your default), folder **`/docs`**, Save.

The site uses [Tailwind CSS](https://tailwindcss.com/) via the Play CDN in each HTML file (no separate build step for `docs/`).

## Store links

The big button on `index.html` is chosen by `store-cta.js`: Firefox (and forks) get **Add to Firefox** linking to AMO, everything else gets the Chromium label for that browser linking to the Chrome Web Store. A plain line under the button links to both stores so the page works without JavaScript. If a listing URL changes, update `STORE_URL` in `store-cta.js` and the links in `index.html`.

- Chrome Web Store: `https://chromewebstore.google.com/detail/ai-chat-history-auto-dele/ipmoefogkkpbgpbniklknonnmbmcbnpk`
- Firefox Add-ons: `https://addons.mozilla.org/firefox/addon/ai-chat-history-auto-delete/` (slug set by `store/amo-metadata.json` on first submission)

Keep `privacy.html` in sync with `PRIVACY.md` at the repo root when policy text changes.
