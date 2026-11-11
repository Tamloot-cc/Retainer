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
