import type { ObjectView, PresentedRecord } from '@retainer/shared';
import { type CategoryColor, categoryColor, objectColor } from './colors.js';

/** Calendars use the first populated select category, with object identity as fallback. */
export function recordCategory(
  object: Pick<ObjectView, 'nameSingular' | 'labelSingular' | 'fields'>,
  record: Pick<PresentedRecord, 'fields'>,
): { color: CategoryColor; label: string } {
  for (const field of object.fields) {
    if (field.type !== 'select') continue;
    const value = record.fields[field.name];
    const option = field.settings.options?.find((candidate) => candidate.value === value);
    if (option)
      return { color: categoryColor(option.value), label: `${field.label}: ${option.label}` };
  }
  return { color: objectColor(object.nameSingular), label: object.labelSingular };
}
