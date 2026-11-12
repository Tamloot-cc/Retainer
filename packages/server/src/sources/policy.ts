import type { ExtensionManifest } from '@retainer/extension';
import { isoDateTimeSchema } from '@retainer/shared';
import { AppError } from '../errors.js';

export type SourcePolicy = NonNullable<ExtensionManifest['source']>;
/** A release-pinned ordering contract, never lexical ordering of unknown provider strings. */
export function compareRevision(
  policy: SourcePolicy['revisionOrder'],
  incoming?: string,
  current?: string | null,
): number | null {
  if (policy === 'opaque') return incoming && incoming === current ? 0 : null;
  const parse = (value: string | undefined | null) => {
    if (!value)
      throw new AppError(
        422,
        'invalid_provider_revision',
        'this provider requires an ordering marker',
      );
    if (policy === 'integer') {
      if (!/^(0|[1-9][0-9]{0,99})$/.test(value))
        throw new AppError(
          422,
          'invalid_provider_revision',
          'provider revision must be a nonnegative integer',
        );
      return BigInt(value);
    }
    // Require an explicit timezone; Date.parse must not infer local time.
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
    if (!match || !isoDateTimeSchema.safeParse(value).success)
      throw new AppError(
        422,
        'invalid_provider_revision',
        'provider revision must be an ISO timestamp with timezone',
      );
    return (
      BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1000000n +
      BigInt((match[2] ?? '').padEnd(9, '0'))
    );
  };
  const a = parse(incoming);
  if (current == null) return null;
  const b = parse(current);
  return a < b ? -1 : a > b ? 1 : 0;
}
/** JSON boundaries avoid ambiguous concatenation and keep registration/account identity stable. */
export const sourceIdentityChannel = (registration: string, provider: string, namespace: string) =>
  `retainer-source:${JSON.stringify([registration, provider, namespace])}`;
