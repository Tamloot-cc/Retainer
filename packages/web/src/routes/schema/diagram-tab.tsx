import * as Popover from '@radix-ui/react-popover';
import { ReactFlowProvider, useReactFlow, type Viewport } from '@xyflow/react';
import { Command as CommandPrimitive } from 'cmdk';
import { Maximize, Minimize, RotateCcw, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../api/client.js';
import { Command, CommandInput, CommandItem } from '../../ui/command.js';
import { DIAGRAM_FIT_VIEW, Diagram } from '../../ui/diagram.js';
import {
  Button,
  Checkbox,
  DiagramDashedKey,
  DiagramKey,
  type DiagramNode,
  Empty,
} from '../../ui/index.js';
import { useView } from '../state.js';
import { DiagramInspector } from './diagram-inspector.js';
import {
  buildDiagram,
  type DiagramSelection,
  diagramEdgeSelection,
  diagramView,
} from './diagram-model.js';
import { ABOUT_ROW, ANY_RECORD_NODE } from './schema-model.js';

function FindObject({
  entries,
  onPick,
}: {
  entries: { node: DiagramNode; names: string[] }[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picked = useRef(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button className="pointer-coarse:min-h-11" size="default">
          <Search size={15} aria-hidden />
          Find object…
        </Button>
      </Popover.Trigger>
      <Popover.Content
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label="Find an object on the diagram"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          picked.current = false;
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (picked.current) event.preventDefault();
        }}
        className="z-30 w-[min(22rem,calc(100dvw-2rem))] rounded-lg border border-border bg-background shadow-lg"
      >
        <Command
          label="Find object"
          filter={(value, search, keywords) =>
            [value, ...(keywords ?? [])].some((text) =>
              text.toLowerCase().includes(search.trim().toLowerCase()),
            )
              ? 1
              : 0
          }
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search size={15} aria-hidden className="shrink-0 text-muted-foreground" />
            <CommandInput
              ref={input}
              aria-label="Find object"
              placeholder="Search by name"
              className="h-11 min-w-0 flex-1 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-[min(18rem,var(--radix-popover-content-available-height)-3rem)] overflow-y-auto overscroll-contain p-1.5">
            <CommandPrimitive.Empty className="px-2 py-3 text-sm text-muted-foreground">
              No objects found.
            </CommandPrimitive.Empty>
            {entries.map(({ node, names }) => (
              <CommandItem
                key={node.id}
                value={node.id}
                keywords={names}
                onSelect={() => {
                  picked.current = true;
                  setOpen(false);
                  onPick(node.id);
                }}
              >
                <node.icon size={16} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{node.label}</span>
                <span className="max-w-[40%] truncate font-mono text-xs opacity-75">{node.id}</span>
              </CommandItem>
            ))}
          </CommandPrimitive.List>
        </Command>
      </Popover.Content>
    </Popover.Root>
  );
}

export function DiagramTab() {
  const { schema } = useWorkspace();
  if (!schema.objects.length) {
    return (
      <Empty
        title="No objects yet"
        description="The diagram appears once the workspace has objects."
      />
    );
  }
  return (
    <ReactFlowProvider>
      <DiagramWorkspace />
    </ReactFlowProvider>
  );
}

function DiagramWorkspace() {
  const { schema } = useWorkspace();
  const { setSearch } = useView();
  const flow = useReactFlow();
  const { nodes, edges, events } = useMemo(() => buildDiagram(schema.objects), [schema.objects]);
  const objects = useMemo(
    () => new Map(schema.objects.map((o) => [o.nameSingular, o])),
    [schema.objects],
  );
  const searchable = useMemo(
    () =>
      nodes.flatMap((node) => {
        const object = objects.get(node.id);
        return object
          ? [{ node, names: [object.labelSingular, object.labelPlural, object.namePlural] }]
          : [];
      }),
    [nodes, objects],
  );
  const [selection, setSelection] = useState<DiagramSelection | null>(null);
  const [showEvents, setShowEvents] = useState(true);
  const [focusRelated, setFocusRelated] = useState(false);
  const [layoutReset, setLayoutReset] = useState(0);
  const selected = useMemo(() => {
    if (!selection) return null;
    if (selection.node === ANY_RECORD_NODE) return events ? selection : null;
    const object = objects.get(selection.node);
    if (!object) return null;
    if (selection.row === undefined || (selection.row === ABOUT_ROW && object.class === 'event')) {
      return selection;
    }
    return object.fields.some((field) => field.name === selection.row)
      ? selection
      : { node: selection.node };
  }, [events, objects, selection]);
  const focused = !!selected && focusRelated;
  const { visibleNodes, visibleEdges, related, activeEdges } = useMemo(
    () => diagramView(nodes, edges, showEvents, selected, focused),
    [nodes, edges, showEvents, selected, focused],
  );
  const relationCount = new Set(
    edges
      .filter((edge) => !edge.dashed && visibleEdges.has(edge.id))
      .map((edge) => edge.id.split(':')[0]),
  ).size;

  const graphPane = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const inspectorOpener = useRef<HTMLElement | null>(null);
  const frame = useRef(0);

  const inlineHost = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const pageView = useRef<Viewport | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  // A stable portal keeps the React Flow tree mounted when its host moves to the dialog.
  const [host] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    inlineHost.current?.append(host);
    return () => host.remove();
  }, [host]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function nextFrame(action: () => void) {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(action);
  }

  function toggleFullScreen() {
    const modal = dialog.current;
    const anchor = inlineHost.current;
    const pane = graphPane.current;
    if (!modal || !anchor || !pane) return;
    if (modal.open) {
      modal.close();
      return;
    }
    const viewport = flow.getViewport();
    const width = pane.clientWidth;
    const height = pane.clientHeight;
    pageView.current = viewport;
    anchor.style.minBlockSize = `${anchor.offsetHeight}px`;
    modal.append(host);
    modal.showModal();
    setFullScreen(true);
    nextFrame(() => {
      void flow.setViewport({
        ...viewport,
        x: viewport.x + (pane.clientWidth - width) / 2,
        y: viewport.y + (pane.clientHeight - height) / 2,
      });
      fullscreenButton.current?.focus({ preventScroll: true });
    });
  }

  function restorePageView() {
    const anchor = inlineHost.current;
    if (!anchor) return;
    anchor.append(host);
    anchor.style.minBlockSize = '';
    setFullScreen(false);
    const original = pageView.current;
    nextFrame(() => {
      if (original) void flow.setViewport(original);
      // The invoker moved into the dialog, so the browser cannot restore it.
      fullscreenButton.current?.focus({ preventScroll: true });
    });
  }

  function select(next: DiagramSelection) {
    const opener = document.activeElement;
    if (opener instanceof HTMLElement && !opener.closest('.diagram-inspector')) {
      inspectorOpener.current = opener;
    }
    if (next.node === ANY_RECORD_NODE || objects.get(next.node)?.class === 'event') {
      setShowEvents(true);
    }
    setSelection(next);
    nextFrame(() => {
      const node = flow.getNode(next.node);
      const pane = graphPane.current;
      if (node && pane && (next.row === undefined || next.node !== selected?.node)) {
        const width = node.width ?? 0;
        const height = node.height ?? 0;
        const zoom = Math.min(1, Math.max(0.65, (pane.clientWidth - 24) / width));
        void flow.setViewport({
          zoom,
          x: (pane.clientWidth - width * zoom) / 2 - node.position.x * zoom,
          y: Math.max(24, (pane.clientHeight - height * zoom) / 2) - node.position.y * zoom,
        });
      }
      heading.current?.focus({ preventScroll: true });
    });
  }

  function closeInspector() {
    setSelection(null);
    setFocusRelated(false);
    nextFrame(() => {
      const opener = inspectorOpener.current;
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
      else host.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    });
  }

  function selectEdge(id: string) {
    const edge = edges.find((item) => item.id === id);
    if (edge) select(diagramEdgeSelection(edge));
  }

  function toggleEvents(checked: boolean) {
    setShowEvents(checked);
    if (
      !checked &&
      selected &&
      (selected.node === ANY_RECORD_NODE || objects.get(selected.node)?.class === 'event')
    ) {
      setSelection(null);
      setFocusRelated(false);
    }
  }

  function toggleFocusRelated() {
    setFocusRelated(!focused);
    nextFrame(() => {
      void flow.fitView(DIAGRAM_FIT_VIEW);
    });
  }

  return (
    <>
      <div ref={inlineHost} />
      <dialog
        ref={dialog}
        className="diagram-fullscreen"
        aria-label="Schema diagram full screen"
        onClose={restorePageView}
      />
      {createPortal(
        <figure
          aria-label="Objects and their relations"
          className="diagram-workspace"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented && !fullScreen && selected) {
              closeInspector();
            }
          }}
        >
          <div className="diagram-actions">
            <div className="me-auto">
              <FindObject entries={searchable} onPick={(node) => select({ node })} />
            </div>
            <Button
              ref={fullscreenButton}
              className="pointer-coarse:min-h-11"
              onClick={toggleFullScreen}
            >
              {fullScreen ? <Minimize size={15} aria-hidden /> : <Maximize size={15} aria-hidden />}
              {fullScreen ? 'Exit full screen' : 'Full screen'}
            </Button>
            {events ? (
              <div className="diagram-events">
                <Checkbox
                  label="Show event types"
                  checked={showEvents}
                  onChange={(event) => toggleEvents(event.target.checked)}
                />
              </div>
            ) : null}
            <Button
              className="pointer-coarse:min-h-11"
              onClick={() => setLayoutReset((count) => count + 1)}
            >
              <RotateCcw size={15} aria-hidden />
              Reset layout
            </Button>
          </div>
          <div className="diagram-body" data-inspector={selected ? '' : undefined}>
            <Diagram
              nodes={nodes}
              edges={edges}
              visibleNodes={visibleNodes}
              visibleEdges={visibleEdges}
              activeNode={selected?.node}
              activeRow={selected?.row}
              activeEdges={activeEdges}
              paneRef={graphPane}
              layoutReset={layoutReset}
              onSelectNode={(node) => select({ node })}
              onSelectRow={(node, row) => select({ node, row })}
              onSelectEdge={selectEdge}
            />
            {visibleNodes.size === 0 ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted-foreground">
                Show event types to see the objects in this workspace.
              </div>
            ) : null}
            {selected ? (
              <DiagramInspector
                selection={selected}
                objects={objects}
                related={related}
                activeEdges={activeEdges}
                focused={focused}
                headingRef={heading}
                onFocusRelated={toggleFocusRelated}
                onInspect={(node, row) => select({ node, row })}
                onInspectEdge={selectEdge}
                onOpen={(object, field) => void setSearch({ tab: undefined, object, field })}
                onClose={closeInspector}
              />
            ) : null}
          </div>
          <figcaption className="diagram-legend">
            <DiagramKey end="many">Many</DiagramKey>
            <DiagramKey end="one">One</DiagramKey>
            {events && showEvents ? <DiagramDashedKey>About (any entity)</DiagramDashedKey> : null}
            <span className="ml-auto tabular-nums">
              {relationCount} {relationCount === 1 ? 'relation' : 'relations'}
            </span>
          </figcaption>
        </figure>,
        host,
      )}
    </>
  );
}
