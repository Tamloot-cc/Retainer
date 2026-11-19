import type { SchemaOperation } from '@retainer/shared';
import { useMemo } from 'react';
import { useWorkspace } from '../../api/client.js';
import { ObjectIcon } from '../../ui/index.js';
import { ChangeBadge, ChangeField, ChangeGroup, ChangeList } from '../../ui/review.js';
import { groupSchemaChange, type ObjectChange } from './schema-model.js';

/**
 * What a schema change does, grouped by object and then by field, each part
 * marked new, edited or deleted, with every property before and after.
 */
export function SchemaChangeDetails({ groups }: { groups: ObjectChange[] }) {
  return (
    <ChangeList label="What changes">
      {groups.map((g) => (
        <ChangeGroup
          key={g.object}
          icon={<ObjectIcon name={g.object} objectClass={g.objectClass} size={15} />}
          title={g.label}
          badge={g.kind === 'changed' ? null : <ChangeBadge kind={g.kind} />}
          lines={g.details}
        >
          {g.fields.map((f) => (
            <ChangeField
              key={f.name}
              title={f.label}
              type={f.type}
              badge={<ChangeBadge kind={f.kind} />}
              lines={f.details}
            />
          ))}
        </ChangeGroup>
      ))}
    </ChangeList>
  );
}

/** The grouped form of a change's operations against the workspace's current schema. */
export function useSchemaChangeGroups(request: SchemaOperation[]) {
  const { objects } = useWorkspace().schema;
  return useMemo(() => groupSchemaChange(request, objects), [request, objects]);
}
