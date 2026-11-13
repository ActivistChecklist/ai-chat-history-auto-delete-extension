/**
 * Checks that a built package is exactly the tagged release, file by file.
 *
 * Publishing must ship what was released, but commits after a release that only touch
 * tooling or docs should not block it. Comparing the built files against the tag allows
 * both: the build output has the same paths as the repo, so each file is compared with
 * the same path at the tag.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('');
  return out.sort();
}

/**
 * @param {string[]} files package paths, which are also repo paths
 * @param {(p: string) => Buffer} readBuilt
 * @param {(p: string) => Buffer|null} readTagged null when the tag has no such file
 * @returns {string[]} the paths whose bytes differ from the tag, or that the tag lacks
 */
export function filesChangedSinceTag(files, readBuilt, readTagged) {
  return files.filter((p) => {
    const tagged = readTagged(p);
    return !tagged || !tagged.equals(readBuilt(p));
  });
}
