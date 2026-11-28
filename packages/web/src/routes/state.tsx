import type { FieldView, ObjectView, SchemaDescription } from '@retainer/shared';
import { isInverseRelation, relationTargets } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, useWorkspace } from '../api/client.js';
import { Button, Notice, Row } from '../ui/index.js';
export type ViewSearch = {
  tab?: string;
  /** Home feed search. */
  q?: string;
  /** Extension page, after an OAuth return: what the Connections tab says about it. */
  connect?: string;
  cursor?: string;
  filter?: string;
  sort?: string;
  assertion?: string;
  /** Fact selected from workspace search. */
  fact?: string;
  /** A record open in the side sheet over an object list. */
  record?: string;
  /** Object list: the saved view shown; absent for all records. */
  view?: string;
  draft?: string;
  /** Calendar view: the month shown, `yyyy-MM`. */
  month?: string;
  /** Schema page: the selected object (singular API name). */
  object?: string;
  /** Schema page: the field open in the side sheet. */
  field?: string;
  /** Schema page: the change-history status filter. */
  status?: string;
  /** Record history: field API names to show changes of, comma-separated. */
  fields?: string;
  /** Activity feed: event type API names to show, comma-separated. */
  eventTypes?: string;
  /** Activity feed: the one source (`channel`) shown. */
  channel?: string;
  /** Activity feed: the first day shown, `yyyy-MM-dd`. */
  from?: string;
  /** Activity feed: the last day shown, `yyyy-MM-dd`. */
  to?: string;
  /** Activity feed: the one record events are attached to. */
  linked?: string;
  /** Event type list without a saved view: `calendar` places events by when they happened. */
  layout?: string;
};
/** How a record is named on screen. */
export const recordTitle = (r: { label: string | null }) => r.label || 'Untitled record';
/** "Record · Company" or "Activity · Conversation": a record's class, then its object. */
export const classLabel = (object: Pick<ObjectView, 'class' | 'labelSingular'> | undefined) =>
  object
    ? `${object.class === 'event' ? 'Activity' : 'Record'} · ${object.labelSingular}`
    : undefined;
/** How an event is named on screen. */
export const eventTitle = (e: { title: string | null }) => e.title || 'Untitled event';
/** The object (or event type) by its singular API name. */
export const objectByName = (
  schema: Pick<SchemaDescription, 'objects'>,
  name: string | undefined,
): ObjectView | undefined => schema.objects.find((o) => o.nameSingular === name);
/** An object's (or event type's) singular name for people, falling back to its API name. */
export const objectLabel = (schema: Pick<SchemaDescription, 'objects'>, name: string) =>
  objectByName(schema, name)?.labelSingular ?? name;
/**
 * The owning relation fields among `fields` that may point at records of
 * `object` (a singular API name), polymorphic ones included. A record finds
 * what links to it by filtering on these.
 */
export const relationsTo = (fields: FieldView[], object: string) =>
  fields.filter(
    (f) => f.type === 'relation' && !isInverseRelation(f) && relationTargets(f).includes(object),
  );

/**
 * A record fetched only to name it (no relation references): one cached
 * query per record, shared by every place that labels it.
 */
export function useRecordLabel(id: string, enabled = true) {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [session.workspace.id, 'record', id, 'label'],
    queryFn: ({ signal }) => api.record(id, [], signal),
    enabled,
  });
}

/** `value` once it has stopped changing for `ms`, so typing is not a request per key. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
/** Standard (system) objects first, then the rest in schema order: the sidebar and schema page order. */
export function sortObjects(objects: ObjectView[]) {
  return [...objects].sort((a, b) => Number(b.owner === 'system') - Number(a.owner === 'system'));
}
export function useView() {
  const search = useSearch({ strict: false }) as ViewSearch;
  const navigate = useNavigate();
  // Stable, so it can be a dependency of memoized callbacks.
  // `replace` changes the address without a new history entry.
  const setSearch = useCallback(
    (change: Partial<ViewSearch>, options: { replace?: boolean } = {}) =>
      navigate({ search: (prev) => ({ ...prev, ...change }) as never, ...options }),
    [navigate],
  );
  return { search, setSearch };
}
/** A comma list from the address, empty parts dropped. */
export const list = (raw: string | undefined) => (raw ? raw.split(',').filter(Boolean) : []);
/** Values as a comma list for the address; none clears the parameter. */
export const joined = (values: string[]) => (values.length ? values.join(',') : undefined);
/** `useInfiniteQuery` options for a list paged by `nextCursor`. */
export const byCursor = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
};
export function QueryError({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <Notice error>
      <Row>
        {error.message}
        {retry ? <Button onClick={retry}>Try again</Button> : null}
      </Row>
    </Notice>
  );
}

/**
 * Reports the outcome of an action whose screen goes away with it (a
 * deleted, merged or erased record): the shell shows it above the next
 * screen until dismissed. `thisPage` keeps it to the page it was made on,
 * for an outcome that means nothing elsewhere.
 */
export type ReportFn = (report: ReactNode, options?: { thisPage?: boolean }) => void;
export const ReportContext = createContext<ReportFn>(() => {});
export const useReport = () => useContext(ReportContext);
