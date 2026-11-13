import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { listFiles, filesChangedSinceTag } from '../../scripts/lib/tagged-build.mjs';

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
