import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { listFiles, filesChangedSinceTag, derivedManifestMatches } from '../../scripts/lib/tagged-build.mjs';
import { toFirefoxManifest } from '../../scripts/lib/firefox-manifest.mjs';

describe('listFiles', () => {
  it('lists nested files as sorted forward-slash paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagged-build-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(dir, 'src', 'shared', 'dom.js'), '');
      fs.writeFileSync(path.join(dir, 'src', 'background.js'), '');
      expect(listFiles(dir)).toEqual(['manifest.json', 'src/background.js', 'src/shared/dom.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filesChangedSinceTag', () => {
  const built = { 'manifest.json': '{"version":"1.1.1"}', 'src/a.js': 'a', 'src/new.js': 'n' };
  const readBuilt = (p) => Buffer.from(built[p]);

  it('passes when every file matches the tag', () => {
    const tagged = { ...built };
    const readTagged = (p) => (p in tagged ? Buffer.from(tagged[p]) : null);
    expect(filesChangedSinceTag(Object.keys(built), readBuilt, readTagged)).toEqual([]);
  });

  it('flags files whose bytes differ and files the tag does not have', () => {
    const tagged = { 'manifest.json': '{"version":"1.1.0"}', 'src/a.js': 'a' };
    const readTagged = (p) => (p in tagged ? Buffer.from(tagged[p]) : null);
    expect(filesChangedSinceTag(Object.keys(built), readBuilt, readTagged))
      .toEqual(['manifest.json', 'src/new.js']);
  });
});

describe('derivedManifestMatches', () => {
  const tagged = {
    manifest_version: 3,
    version: '1.1.1',
    background: { service_worker: 'src/background.js', type: 'module' },
    options_page: 'src/options/options.html'
  };
  const taggedText = JSON.stringify(tagged, null, 2);

  it('matches the manifest generated from the tag, whatever the formatting', () => {
    const built = JSON.stringify(toFirefoxManifest(tagged));
    expect(derivedManifestMatches(built, taggedText, toFirefoxManifest)).toBe(true);
  });

  it('flags a generated manifest from a different version', () => {
    const built = JSON.stringify(toFirefoxManifest({ ...tagged, version: '1.1.2' }));
    expect(derivedManifestMatches(built, taggedText, toFirefoxManifest)).toBe(false);
  });

  it('flags a tag without a manifest', () => {
    expect(derivedManifestMatches('{}', null, toFirefoxManifest)).toBe(false);
  });
});
