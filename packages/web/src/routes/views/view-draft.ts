import type { CreateViewInput, SavedView, UpdateViewInput } from '@retainer/shared';

export type ViewDraft =
  | (CreateViewInput & { object: string })
  | (UpdateViewInput & { view: string });

/** Parse the envelope. The server validates the settings against the current schema. */
export function parseViewDraft(raw: string): ViewDraft {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The draft must be a JSON object.');
  if ('visibility' in value || 'position' in value || 'expectedUpdatedAt' in value)
    throw new Error('A draft cannot set visibility, position or a revision.');
  if (
    !('view' in value
      ? typeof value.view === 'string'
      : 'object' in value && typeof value.object === 'string')
  )
    throw new Error('The draft must name an object or saved view.');
  return value as ViewDraft;
}

export function viewSettings(view: SavedView): CreateViewInput {
  const {
    name,
    kind,
    description,
    filter,
    sort,
    columns,
    search,
    groupBy,
    granularity,
    groupOrder,
    hideEmptyGroups,
    hiddenGroups,
    groupAggregate,
    dateField,
  } = view;
  return {
    name,
    kind,
    description,
    filter,
    sort,
    columns,
    search: search?.trim() || null,
    groupBy,
    granularity,
    groupOrder,
    hideEmptyGroups,
    hiddenGroups: hiddenGroups.length ? hiddenGroups : null,
    groupAggregate,
    dateField,
  };
}
