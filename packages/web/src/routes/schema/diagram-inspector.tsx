import type { ObjectView } from '@retainer/shared';
import { ArrowUpRight, Focus, X } from 'lucide-react';
import { type Ref, useId } from 'react';
import {
  Button,
  Code,
  type DiagramEdge,
  type DiagramEnd,
  Muted,
  TextButton,
} from '../../ui/index.js';
import { type DiagramSelection, diagramEdgeSelection } from './diagram-model.js';
import { FieldDetails } from './field-sheet.js';
import { ABOUT_ROW, ANY_RECORD_NODE } from './schema-model.js';

function endpointLabel(end: DiagramEnd, objects: Map<string, ObjectView>) {
  if (end.node === ANY_RECORD_NODE) return 'Any entity';
  const object = objects.get(end.node);
  const row =
    end.row === ABOUT_ROW ? 'About' : object?.fields.find((f) => f.name === end.row)?.label;
  const name = object?.labelPlural ?? end.node;
  return row ? `${name} · ${row}` : name;
}

export function DiagramInspector({
  selection,
  objects,
  related,
  activeEdges,
  focused,
  headingRef,
  onFocusRelated,
  onInspect,
  onInspectEdge,
  onOpen,
  onClose,
}: {
  selection: DiagramSelection;
  objects: Map<string, ObjectView>;
  related: DiagramEdge[];
  activeEdges: ReadonlySet<string>;
  focused: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onFocusRelated: () => void;
  onInspect: (node: string, row?: string) => void;
  onInspectEdge: (edge: string) => void;
  onOpen: (node: string, row?: string) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const object = objects.get(selection.node);
  const field = object?.fields.find((f) => f.name === selection.row);
  const about = selection.row === ABOUT_ROW && object?.class === 'event';
  const title = about ? 'About' : (field?.label ?? object?.labelPlural ?? 'Any entity');
  const connections = selection.row ? related.filter((edge) => activeEdges.has(edge.id)) : related;

  return (
    <aside className="diagram-inspector" aria-labelledby={headingId}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          {selection.row && object ? (
            <TextButton
              className="wrap-anywhere text-xs"
              onClick={() => onInspect(object.nameSingular)}
            >
              {object.labelPlural}
            </TextButton>
          ) : (
            <p className="text-xs text-muted-foreground">
              {object?.class === 'event' ? 'Event type' : object ? 'Object' : 'Built-in link'}
            </p>
          )}
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="w-fit rounded-sm wrap-anywhere text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 pointer-coarse:size-11"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </header>
      <div
        key={JSON.stringify([selection.node, selection.row, selection.edge])}
        className="diagram-inspector-content flex flex-col gap-4 p-3"
      >
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="small"
            className="pointer-coarse:min-h-11 aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary"
            aria-pressed={focused}
            onClick={onFocusRelated}
          >
            <Focus size={14} aria-hidden />
            Focus on related objects
          </Button>
          {object ? (
            <Button
              size="small"
              className="pointer-coarse:min-h-11"
              onClick={() => onOpen(object.nameSingular, field?.name)}
            >
              <ArrowUpRight size={14} aria-hidden />
              Open in Objects
            </Button>
          ) : null}
        </div>

        {about ? <Muted>An event can be about any number of entities.</Muted> : null}
        {!object ? (
          <Muted>Events can be about records of any entity type in this workspace.</Muted>
        ) : null}
        {connections.length ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Relationships</h3>
            <ul className="grid gap-2">
              {connections.map((edge) => {
                const end = diagramEdgeSelection(edge);
                const neighbor = edge.from.node === selection.node ? edge.to : edge.from;
                return (
                  <li key={edge.id} className="rounded-md border border-border bg-card p-2 text-xs">
                    <p className="wrap-anywhere font-medium text-foreground">
                      {endpointLabel(edge.from, objects)} <span aria-hidden>→</span>{' '}
                      {endpointLabel(edge.to, objects)}
                    </p>
                    <p className="mt-1 text-muted-foreground">{edge.description}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {!selection.row ? (
                        <Button
                          size="small"
                          variant="ghost"
                          className="pointer-coarse:min-h-11"
                          onClick={() => onInspectEdge(edge.id)}
                        >
                          Inspect{' '}
                          {end.row === ABOUT_ROW
                            ? 'About'
                            : (objects.get(end.node)?.fields.find((f) => f.name === end.row)
                                ?.label ?? 'field')}
                        </Button>
                      ) : null}
                      {neighbor.node !== selection.node ? (
                        <Button
                          size="small"
                          variant="ghost"
                          className="pointer-coarse:min-h-11"
                          onClick={() => onInspect(neighbor.node)}
                        >
                          Go to {objects.get(neighbor.node)?.labelPlural ?? 'Any entity'}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : !selection.row ? (
          <Muted>No relationships shown.</Muted>
        ) : null}

        {object && field ? (
          <FieldDetails object={object} field={field} onNavigate={onInspect} />
        ) : null}
        {object && !selection.row && object.fields.length ? (
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-2.5 py-2 text-sm font-semibold pointer-coarse:min-h-11">
              Fields ({object.fields.length})
            </summary>
            <ul className="grid gap-0.5 border-t border-border p-1">
              {object.fields.map((item) => (
                <li key={item.name}>
                  <Button
                    size="small"
                    variant="ghost"
                    className="h-auto min-h-8 w-full justify-start whitespace-normal text-left pointer-coarse:min-h-11"
                    onClick={() => onInspect(object.nameSingular, item.name)}
                  >
                    {item.label}
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {object && !selection.row ? (
          <div className="space-y-1">
            <Code>{object.nameSingular}</Code>
            {object.description ? <Muted>{object.description}</Muted> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
