import type { FieldView, ObjectView } from '@retainer/shared';
import { Asterisk, Link2 } from 'lucide-react';
import { Suspense, useCallback, useMemo } from 'react';
import { useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { objectColor } from '../../ui/colors.js';
import {
  Diagram,
  DiagramDashedKey,
  DiagramKey,
  type DiagramNode,
  Empty,
  Notice,
  objectIcon,
} from '../../ui/index.js';
import { sortObjects, useView } from '../state.js';
import {
  ABOUT_ROW,
  ANY_RECORD_NODE,
  aboutEdges,
  relationEdges,
  typeDetail,
} from './schema-model.js';

/** The objects as boxes and their relations as lines; both open in the Objects tab. */
export function DiagramTab() {
  const { schema } = useWorkspace(),
    { setSearch } = useView();
  const { nodes, edges, events } = useMemo(() => {
    const objects = sortObjects(schema.objects);
    const row = (f: FieldView, o: ObjectView) => ({
      id: f.name,
      icon: fields[f.type].icon,
      label: f.label,
      detail: f.type === 'relation' ? (typeDetail(f, objects) ?? undefined) : fields[f.type].label,
      isKey: f.name === o.labelField,
    });
    const events = objects.some((o) => o.class === 'event');
    return {
      events,
      nodes: [
        ...objects.map(
          (o): DiagramNode => ({
            id: o.nameSingular,
            icon: objectIcon(o.nameSingular, o.class),
            color: objectColor(o.nameSingular),
            label: o.labelPlural,
            meta: `${o.class === 'event' ? 'Event · ' : ''}${o.fields.length} ${o.fields.length === 1 ? 'field' : 'fields'}`,
            variant: o.class,
            // The field that names records, then the relations; an event type adds `about`.
            rows: [
              ...[
                ...o.fields.filter((f) => f.name === o.labelField),
                ...o.fields.filter((f) => f.type === 'relation' && f.name !== o.labelField),
              ].map((f) => row(f, o)),
              ...(o.class === 'event'
                ? [{ id: ABOUT_ROW, icon: Link2, label: 'About', detail: 'Any entities' }]
                : []),
            ],
          }),
        ),
        // Where every event type's `about` line ends.
        ...(events
          ? [
              {
                id: ANY_RECORD_NODE,
                icon: Asterisk,
                label: 'Any entity',
                meta: 'about',
                variant: 'any' as const,
                rows: [],
              },
            ]
          : []),
      ],
      edges: [...relationEdges(objects), ...aboutEdges(objects)],
    };
  }, [schema.objects]);
  // A polymorphic relation draws a line to each object it allows; count it once.
  const relations = new Set(edges.filter((e) => !e.dashed).map((e) => e.id.split(':')[0])).size;
  const open = useCallback(
    (object: string, field?: string) => {
      // "Any entity" and `about` are built in: there is no object or field to open.
      if (object === ANY_RECORD_NODE) return;
      void setSearch({
        tab: undefined,
        object,
        field: field === ABOUT_ROW ? undefined : field,
      });
    },
    [setSearch],
  );
  if (!nodes.length)
    return (
      <Empty
        title="No objects yet"
        description="The diagram appears once the workspace has objects."
      />
    );
  return (
    <Suspense fallback={<Notice>Loading diagram…</Notice>}>
      <Diagram
        label="Objects and their relations"
        nodes={nodes}
        edges={edges}
        onSelectNode={open}
        onSelectRow={open}
        legend={
          <>
            <DiagramKey end="many">Many</DiagramKey>
            <DiagramKey end="one">One</DiagramKey>
            {events ? <DiagramDashedKey>About (any entity)</DiagramDashedKey> : null}
            <span>
              {relations} {relations === 1 ? 'relation' : 'relations'}. Each card shows the field
              that names its records and its relations. Drag to move, use the controls to zoom, and
              click a card, a field or a line to open it.
            </span>
          </>
        }
      />
    </Suspense>
  );
}
