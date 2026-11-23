import type { EmailsValue, FieldType, LinksValue, PhonesValue } from '@retainer/shared';

/** The primary contact value, in the form expected by the clipboard. */
export function primaryCopyValue(type: FieldType, value: unknown): string | undefined {
  switch (type) {
    case 'emails':
      return (value as EmailsValue | null | undefined)?.primary ?? undefined;
    case 'phones':
      return (value as PhonesValue | null | undefined)?.primary?.number;
    case 'links':
      return (value as LinksValue | null | undefined)?.primary?.url;
    default:
      return undefined;
  }
}
