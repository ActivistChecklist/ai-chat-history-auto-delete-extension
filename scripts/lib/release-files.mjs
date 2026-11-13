/**
 * Names of the files a release puts in release/. The build, release and both publish
 * scripts all take them from here, so every file says which store it is for and the
 * names cannot drift apart between scripts.
 */
export const PKG_NAME = 'ai-chat-history-auto-delete';

/** Chrome versions are digits and dots already; this only guards a malformed one. */
function fileVersion(version) {
  return String(version).replace(/[^0-9a-z._-]+/gi, '-');
}

export function releaseFileNames(version) {
  const base = `${PKG_NAME}-${fileVersion(version)}`;
  return {
    chromeZip: `${base}-chrome.zip`,
    chromeCrx: `${base}-chrome.crx`,
    firefoxZip: `${base}-firefox.zip`,
    firefoxSource: `${base}-firefox-source.zip`
  };
}
