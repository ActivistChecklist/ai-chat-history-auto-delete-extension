/**
 * Derives the Firefox manifest from the Chrome one.
 *
 * manifest.json stays the single source of truth (version, permissions, content scripts).
 * The Firefox build only rewrites the keys Firefox treats differently:
 *
 * - background: Firefox MV3 has no service workers for extensions. It runs the same file
 *   as a non-persistent background script ("event page"), still as an ES module.
 * - options_page: Firefox documents options_ui; open_in_tab keeps the Chrome behavior of a
 *   full tab instead of an embedded about:addons panel.
 * - browser_specific_settings.gecko: AMO requires a stable add-on ID for MV3, and since
 *   2025-11-03 every new listing must declare its data collection. This extension collects
 *   nothing, so it declares "none".
 *
 * strict_min_version 140 is the first desktop release with built-in data collection
 * consent. It also clears the 128 floor for scripting.executeScript({ world: 'MAIN' }),
 * which the background relies on to fetch with the user's claude.ai session.
 */

/** Permanent once the add-on is listed on AMO. Never change it after the first upload. */
export const GECKO_ID = 'ai-chat-history-auto-delete@activistchecklist.org';
export const FIREFOX_MIN_VERSION = '140.0';
export const FIREFOX_ANDROID_MIN_VERSION = '142.0';

/**
 * @param {Record<string, any>} chromeManifest parsed manifest.json
 * @returns {Record<string, any>} a new object; the input is not modified
 */
export function toFirefoxManifest(chromeManifest) {
  const m = structuredClone(chromeManifest);

  const worker = m.background?.service_worker;
  if (!worker) {
    throw new Error('Expected background.service_worker in manifest.json to derive the Firefox build');
  }
  m.background = { scripts: [worker] };
  if (chromeManifest.background.type) m.background.type = chromeManifest.background.type;

  if (m.options_page) {
    m.options_ui = { page: m.options_page, open_in_tab: true };
    delete m.options_page;
  }

  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      data_collection_permissions: { required: ['none'] }
    },
    // Android reads its own floor; data_collection_permissions needs 142 there. This does
    // not opt the listing into Android, which is a separate switch on AMO.
    gecko_android: {
      strict_min_version: FIREFOX_ANDROID_MIN_VERSION
    }
  };

  return m;
}
