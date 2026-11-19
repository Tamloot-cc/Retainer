import type { SchemaDiffOperation } from '@retainer/shared';
import { useMemo } from 'react';
import { ObjectIcon } from '../../ui/index.js';
import { ChangeBadge, ChangeField, ChangeGroup, ChangeList } from '../../ui/review.js';
import { groupSchemaDiff, type ObjectChange } from './schema-model.js';

/**
 * What a schema change does, as the engine computed it, grouped by object and
 * then by field, each part marked new, edited or deleted, with every property
 * before and after.
 */
export function SchemaChangeDetails({ groups }: { groups: ObjectChange[] }) {
  return (
    <ChangeList label="What changes">
      {groups.map((g) => (
        <ChangeGroup
          key={g.id}
          icon={<ObjectIcon name={g.object} objectClass={g.objectClass} size={15} />}
          title={g.label}
          badge={g.kind === 'changed' ? null : <ChangeBadge kind={g.kind} />}
          lines={g.details}
        >
          {g.fields.map((f) => (
            <ChangeField
              key={f.id}
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

/** A change's diff grouped by object and field. */
export function useSchemaChangeGroups(operations: SchemaDiffOperation[]) {
  return useMemo(() => groupSchemaDiff(operations), [operations]);
}
