import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { Button, Input, Loading, Muted, Notice, Row, Stack } from '../../ui/index.js';
import { objectByName, QueryError, recordTitle, useDebounced } from '../state.js';
import { RecordName } from './run.js';

/**
 * Finds the record to test a routine on by searching its object's records,
 * so nobody has to copy a record's ID (routines spec §5.3).
 */
export function RecordChooser({
  object,
  value,
  onChange,
}: {
  /** The object's API name; undefined while it is looked up, null if it is gone. */
  object: string | null | undefined;
  value: string;
  onChange: (id: string) => void;
}) {
  const { session, schema } = useWorkspace();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim());
  const view = objectByName(schema, object ?? undefined);
  const plural = view?.labelPlural.toLowerCase() ?? 'records';
  const records = useQuery({
    queryKey: [session.workspace.id, 'routineTestRecords', object, query],
    queryFn: ({ signal }) =>
      api.queryRecords(object ?? '', { search: query || undefined, limit: 10 }, signal),
    enabled: !!object && !value,
    placeholderData: (previous) => previous,
  });
  if (object === null)
    return (
      <Notice error>
        The object this routine runs on is no longer in the workspace, so it can’t be tested.
        Describe it again to repair it.
      </Notice>
    );
  if (!object) return <Loading>Finding the records it runs on…</Loading>;
  if (value)
    return (
      <Row>
        <span className="text-sm">
          Test on: <span className="font-medium">{<RecordName id={value} />}</span>
        </span>
        <Button size="small" onClick={() => onChange('')}>
          Choose another
        </Button>
      </Row>
    );
  const list = records.data?.records ?? [];
  return (
    <Stack>
      <Input
        aria-label={`Search ${plural}`}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder={`Search ${plural}…`}
      />
      {records.error ? <QueryError error={records.error} /> : null}
      {records.isFetching && !list.length ? <Notice>Searching…</Notice> : null}
      {list.length ? (
        <ul aria-label={`Matching ${plural}`} className="flex flex-col gap-1">
          {list.map((record) => (
            <li key={record.id}>
              <Button size="small" onClick={() => onChange(record.id)}>
                {recordTitle(record)}
              </Button>
            </li>
          ))}
        </ul>
      ) : records.data ? (
        <Muted>No matching {plural}.</Muted>
      ) : null}
    </Stack>
  );
}
