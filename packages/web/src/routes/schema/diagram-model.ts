import type { FieldView, ObjectView } from '@retainer/shared';
import { Asterisk, Link2 } from 'lucide-react';
import { fields } from '../../fields/index.js';
import { objectColor } from '../../ui/colors.js';
import { type DiagramEdge, type DiagramNode, objectIcon } from '../../ui/index.js';
import { sortObjects } from '../state.js';
import {
  ABOUT_ROW,
  ANY_RECORD_NODE,
  aboutEdges,
  relationEdges,
  typeDetail,
} from './schema-model.js';

export function buildDiagram(schemaObjects: ObjectView[]) {
  const objects = sortObjects(schemaObjects);
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
}

export interface DiagramSelection {
  node: string;
  row?: string;
  edge?: string;
}

const touches = (edge: DiagramEdge, node: string) =>
  edge.from.node === node || edge.to.node === node;

export function diagramView(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  showEvents: boolean,
  selection: DiagramSelection | null,
  focusRelated: boolean,
) {
  const availableNodes = new Set(
    nodes
      .filter((node) => showEvents || !node.variant || node.variant === 'entity')
      .map(({ id }) => id),
  );
  const availableEdges = edges.filter(
    (edge) => availableNodes.has(edge.from.node) && availableNodes.has(edge.to.node),
  );
  const related = selection ? availableEdges.filter((edge) => touches(edge, selection.node)) : [];
  const activeEdges = new Set(
    related
      .filter((edge) =>
        selection?.edge
          ? edge.id === selection.edge
          : selection?.row === undefined ||
            [edge.from, edge.to].some(
              (end) => end.node === selection.node && end.row === selection.row,
            ),
      )
      .map(({ id }) => id),
  );
  const focused = focusRelated && selection && availableNodes.has(selection.node);
  const visibleNodes = focused
    ? new Set([selection.node, ...related.flatMap((edge) => [edge.from.node, edge.to.node])])
    : availableNodes;
  const visibleEdges = new Set((focused ? related : availableEdges).map(({ id }) => id));
  return { related, activeEdges, visibleNodes, visibleEdges };
}

export function diagramEdgeSelection(edge: DiagramEdge): DiagramSelection {
  const end = edge.from.row === undefined ? edge.to : edge.from;
  return { node: end.node, row: end.row, edge: edge.id };
}
