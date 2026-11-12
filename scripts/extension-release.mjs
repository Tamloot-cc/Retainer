import { satisfiesServerRange } from '../packages/extension/dist/index.js';

/** Release policy shared by artifact generation and its real-Git tests. */
export function extensionRelease(git, development) {
  const commit = git('rev-parse', 'HEAD');
  if (!development) {
    if (git('status', '--porcelain'))
      throw new Error('production extension artifacts require a clean main commit');
    try {
      // CI checks out a SHA in detached HEAD; a branch's name alone proves nothing.
      git('merge-base', '--is-ancestor', commit, 'origin/main');
    } catch {
      throw new Error('production extension artifacts require a commit on origin/main');
    }
  }
  const ordinal = Number(git('rev-list', '--count', 'HEAD'));
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new Error('cannot establish an immutable extension release version');
  // Main is append-only. A new main commit never republishes a prior version.
  return { commit, development, version: development ? '1.0.0' : `1.0.${ordinal}` };
}

// The reviewed server range first-party releases declare. Widen it only after
// testing the releases on the new server line; a patch inside it needs no new
// release. Moving to a new line (0.2.0) is the bridge: a release whose range
// covers both lines, installed while the old server still runs, retained across
// the upgrade. The packaged server must be inside the range.
export const REVIEWED_SERVER_RANGE = '>=0.1.0 <0.2.0';
export function extensionServerRange(currentVersion, range = REVIEWED_SERVER_RANGE) {
  if (!satisfiesServerRange(currentVersion, range))
    throw new Error('first-party extension compatibility must be reviewed for this server version');
  return range;
}
