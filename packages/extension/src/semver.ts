/**
 * The small semver subset a reviewed release may use to declare the servers
 * it supports, like Twenty's `engines.twenty` but stricter: release versions
 * only (no prereleases, wildcards, carets or tildes), comparators separated by
 * one space, alternatives by ` || `, and every alternative bounded above, so
 * a release never claims servers nobody has reviewed it on.
 */
type Version = readonly [number, number, number];
type Comparator = { op: '>=' | '<=' | '>' | '<' | '='; version: Version };

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const COMPARATOR = /^(>=|<=|>|<|=)?((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))$/;
const MAX_LENGTH = 200,
  MAX_ALTERNATIVES = 8,
  MAX_COMPARATORS = 4;

function parseVersion(value: string): Version | null {
  const match = VERSION.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}
const holds = (version: Version, { op, version: bound }: Comparator) => {
  const c = compare(version, bound);
  return op === '>='
    ? c >= 0
    : op === '<='
      ? c <= 0
      : op === '>'
        ? c > 0
        : op === '<'
          ? c < 0
          : c === 0;
};
const invalid = (why: string): never => {
  throw new Error(`unsupported_manifest: serverRange ${why}`);
};

const MAX_COMPONENT = 999_999_999;
/** The next version VERSION accepts, carrying at the nine-digit ceiling; null past the last one. */
function successor([major, minor, patch]: Version): Version | null {
  if (patch < MAX_COMPONENT) return [major, minor, patch + 1];
  if (minor < MAX_COMPONENT) return [major, minor + 1, 0];
  if (major < MAX_COMPONENT) return [major + 1, 0, 0];
  return null;
}

/** Parses and checks a range; throws `unsupported_manifest` when it is not one a release may declare. */
export function parseServerRange(range: string): Comparator[][] {
  if (!range || range.length > MAX_LENGTH) invalid('must be 1 to 200 characters');
  const alternatives = range.split(' || ');
  if (alternatives.length > MAX_ALTERNATIVES)
    invalid(`allows at most ${MAX_ALTERNATIVES} alternatives`);
  return alternatives.map((alternative) => {
    const parts = alternative.split(' ');
    if (parts.length > MAX_COMPARATORS)
      invalid(`allows at most ${MAX_COMPARATORS} comparators each`);
    const set = parts.map((part) => {
      const match = COMPARATOR.exec(part);
      if (!match) return invalid(`has an unsupported comparator "${part}"`);
      const version = parseVersion(match[2] as string) as Version;
      return { op: (match[1] ?? '=') as Comparator['op'], version };
    });
    if (!set.some((c) => c.op === '<' || c.op === '<=' || c.op === '='))
      invalid('needs an upper bound in every alternative');
    if (!set.some((c) => c.op === '>' || c.op === '>=' || c.op === '='))
      invalid('needs a lower bound in every alternative');
    // A set no release version satisfies is a mistake, not a range. Versions
    // are integers, so a strict lower bound `>v` is the inclusive `>=` the next
    // patch; the set is empty when that lowest version is above the tightest
    // upper bound, or equal to a strict one.
    const floors = set
      .filter((c) => c.op !== '<' && c.op !== '<=')
      .map((c) => (c.op === '>' ? successor(c.version) : c.version));
    if (floors.includes(null)) invalid('is empty');
    const lowest = (floors as Version[]).sort(compare).at(-1) as Version;
    if (!set.every((c) => holds(lowest, c))) invalid('is empty');
    return set;
  });
}

/** Whether a server version is inside a range. A malformed or prerelease version never is. */
export function satisfiesServerRange(serverVersion: string, range: string): boolean {
  const version = parseVersion(serverVersion);
  if (!version) return false;
  return parseServerRange(range).some((set) => set.every((c) => holds(version, c)));
}
