import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  toFirefoxManifest,
  GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_ANDROID_MIN_VERSION
} from '../../scripts/lib/firefox-manifest.mjs';

const chromeManifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../manifest.json'), 'utf8')
);

describe('toFirefoxManifest', () => {
  const ff = toFirefoxManifest(chromeManifest);

  it('runs the same background file as a module script instead of a service worker', () => {
    expect(ff.background).toEqual({
      scripts: [chromeManifest.background.service_worker],
      type: 'module'
    });
  });

  it('moves options_page to options_ui opened in a tab', () => {
    expect(ff.options_page).toBeUndefined();
    expect(ff.options_ui).toEqual({ page: chromeManifest.options_page, open_in_tab: true });
  });

  it('declares the stable gecko id, minimum versions and no data collection', () => {
    expect(ff.browser_specific_settings).toEqual({
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: { required: ['none'] }
      },
      gecko_android: { strict_min_version: FIREFOX_ANDROID_MIN_VERSION }
    });
  });

  it('keeps version, permissions and content scripts identical', () => {
    for (const key of [
      'version',
      'name',
      'permissions',
      'host_permissions',
      'content_scripts',
      'web_accessible_resources',
      'content_security_policy',
      'icons',
      'action'
    ]) {
      expect(ff[key]).toEqual(chromeManifest[key]);
    }
  });

  it('does not modify its input', () => {
    const input = structuredClone(chromeManifest);
    toFirefoxManifest(input);
    expect(input).toEqual(chromeManifest);
  });

  it('fails loudly if the Chrome manifest stops using a service worker', () => {
    expect(() => toFirefoxManifest({ ...chromeManifest, background: {} })).toThrow(/service_worker/);
  });
});
