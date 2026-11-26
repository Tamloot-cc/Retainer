import '@xyflow/react/dist/style.css';
import './diagram.css';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  type Edge,
  type EdgeMouseHandler,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesState,
  useReactFlow,
  useViewportStore,
} from '@xyflow/react';
import { KeyRound } from 'lucide-react';
import {
  createContext,
  type FocusEvent,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cn } from './core.js';
import {
  layoutDiagram,
  linkSides,
  type Route,
  roundedPath,
  routePoints,
} from './diagram-layout.js';
import {
  type DiagramEdge,
  type DiagramEnd,
  type DiagramNode,
  lineStroke,
  MANY_PATH,
  ONE_PATH,
} from './diagram-parts.js';

// Card sizes, set inline on the card so the layout's estimate is exact.
const WIDTH = 248,
  HEADER = 45,
  ROW = 30,
  PADDING = 8;
const heightOf = (n: DiagramNode) =>
  2 + HEADER + (n.rows.length ? PADDING + n.rows.length * ROW : 0);
/** Middle of a row (or of the header), measured down from the card's top. */
function rowY(node: DiagramNode | undefined, row: string | undefined) {
  const i = node?.rows.findIndex((r) => r.id === row) ?? -1;
  return i < 0 ? 1 + HEADER / 2 : 1 + HEADER + PADDING / 2 + i * ROW + ROW / 2;
}
const handleId = (row: string | undefined, side: 'left' | 'right') =>
  `${row === undefined ? 'header' : `row:${row}`}:${side}`;
const markerId = (end: 'many' | 'one', lit: boolean) =>
  `retainer-diagram-${end}${lit ? '-lit' : ''}`;
// React Flow 13 reads a bare number as pixels; 3.7% per side is the margin
// the old proportional padding of 0.08 gave.
export const DIAGRAM_FIT_VIEW = { padding: '3.7%', maxZoom: 1 } as const;

const showFieldRows = (state: { transform: readonly number[] }) =>
  (state.transform[2] ?? 1) >= 0.58;

interface Actions {
  onSelectNode: (id: string) => void;
  onSelectRow: (node: string, row: string) => void;
}
const ActionsContext = createContext<Actions>({ onSelectNode: () => {}, onSelectRow: () => {} });

type CardNode = Node<
  { node: DiagramNode; active?: boolean; activeRow?: string; dimmed?: boolean },
  'card'
>;
const HIDDEN_HANDLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

/**
 * Invisible attachment points on both sides of a row. Loose connection mode
 * lets an edge end on a source handle, so one per side serves both ends.
 */
function Handles({ row }: { row?: string }) {
  return (
    <>
      {(['left', 'right'] as const).map((side) => (
        <Handle
          key={side}
          id={handleId(row, side)}
          type="source"
          position={side === 'left' ? Position.Left : Position.Right}
          isConnectable={false}
          style={HIDDEN_HANDLE}
        />
      ))}
    </>
  );
}

/**
 * Each card variant's classes. Event types read apart from records; "any
 * record" is a stand-in, not an object.
 */
const VARIANT_CLASSES = {
  entity: {
    card: 'border-border',
    header: 'bg-muted/40',
    icon: 'rounded-md bg-primary/10 text-primary',
  },
  event: {
    card: 'border-primary/35',
    header: 'bg-primary/5',
    icon: 'rounded-full bg-primary text-primary-foreground',
  },
  any: {
    card: 'border-dashed border-muted-foreground/50 bg-muted/30 shadow-none',
    header: '',
    icon: 'rounded-md text-muted-foreground',
  },
} satisfies Record<
  NonNullable<DiagramNode['variant']>,
  { card: string; header: string; icon: string }
>;

function Card({
  data: { node, active, activeRow, dimmed },
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<CardNode>) {
  const { onSelectNode, onSelectRow } = useContext(ActionsContext);
  const showFields = useViewportStore(showFieldRows);
  const { getZoom, setCenter } = useReactFlow();
  const variant = VARIANT_CLASSES[node.variant ?? 'entity'];
  function revealFocusedControl(event: FocusEvent<HTMLButtonElement>) {
    if (!event.target.matches(':focus-visible')) return;
    const pane = event.currentTarget.closest('.react-flow')?.getBoundingClientRect();
    const button = event.target.getBoundingClientRect();
    if (
      pane &&
      (button.left < pane.left ||
        button.right > pane.right ||
        button.top < pane.top ||
        button.bottom > pane.bottom)
    ) {
      void setCenter(
        positionAbsoluteX + WIDTH / 2,
        positionAbsoluteY + rowY(node, event.target.dataset.diagramRow),
        { zoom: Math.max(getZoom(), 0.75) },
      );
    }
  }
  return (
    <div
      style={{ width: WIDTH }}
      className={cn(
        'rounded-lg border bg-card text-foreground shadow-sm transition-[border-color,box-shadow] hover:border-primary/60 hover:shadow-md',
        variant.card,
        dimmed && 'opacity-50 focus-within:opacity-100 hover:opacity-100',
        active && 'border-primary ring-2 ring-primary/25',
      )}
    >
      <div className="relative" style={{ height: HEADER }}>
        <Handles />
        <button
          type="button"
          onFocus={revealFocusedControl}
          aria-pressed={!!active && activeRow === undefined}
          onClick={() => onSelectNode(node.id)}
          className={cn(
            'flex h-full w-full items-center gap-2.5 rounded-t-lg px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            node.rows.length ? 'border-b border-border' : 'rounded-b-lg',
            variant.header,
          )}
        >
          <span
            data-color={node.color}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-md',
              node.color ? 'category-tag' : variant.icon,
            )}
          >
            <node.icon size={14} aria-hidden />
          </span>
          <span className="truncate text-sm font-semibold" title={node.label}>
            {node.label}
          </span>
          {node.meta && showFields ? (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {node.meta}
            </span>
          ) : null}
        </button>
      </div>
      {node.rows.length ? (
        <ul style={{ paddingBlock: PADDING / 2 }}>
          {node.rows.map((row) => (
            <li key={row.id} className="relative" style={{ height: ROW }}>
              <Handles row={row.id} />
              {showFields ? (
                <button
                  type="button"
                  onFocus={revealFocusedControl}
                  data-diagram-row={row.id}
                  aria-pressed={activeRow === row.id}
                  onClick={() => onSelectRow(node.id, row.id)}
                  className={cn(
                    'flex h-full w-full items-center gap-2 px-3 text-left text-xs hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    activeRow === row.id && 'bg-primary/10 text-primary',
                  )}
                >
                  <row.icon size={13} aria-hidden className="shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{row.label}</span>
                  {row.isKey ? (
                    <KeyRound
                      size={11}
                      aria-label="Label field"
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  {row.detail ? (
                    <span
                      className="ml-auto max-w-[52%] shrink-0 truncate pl-2 text-muted-foreground"
                      title={row.detail}
                    >
                      {row.detail}
                    </span>
                  ) : null}
                </button>
              ) : (
                /* Keep row geometry and handles stable while zooming. */
                <div aria-hidden className="flex h-full items-center px-3">
                  <span
                    className={cn(
                      'h-1.5 w-20 rounded-full bg-border',
                      activeRow === row.id && 'bg-primary/60',
                    )}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const NODE_TYPES = { card: Card };

type LinkEdge = Edge<{ route?: Route }, 'link'>;

/**
 * A link line: along its route while the layout holds, otherwise a stepped
 * line (which is also how a self-link loops out and back on the right).
 */
function Link({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
}: EdgeProps<LinkEdge>) {
  const [path] = data?.route
    ? [roundedPath(routePoints({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, data.route))]
    : getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 12,
        offset: 28,
      });
  return (
    <BaseEdge
      path={path}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
}

const EDGE_TYPES = { link: Link };

function Markers() {
  return (
    <svg aria-hidden width={0} height={0} className="absolute">
      <defs>
        {(['many', 'one'] as const).flatMap((end) =>
          [false, true].map((lit) => (
            <marker
              key={markerId(end, lit)}
              id={markerId(end, lit)}
              viewBox="0 0 12 12"
              refX={12}
              refY={6}
              markerWidth={12}
              markerHeight={12}
              markerUnits="userSpaceOnUse"
              orient={end === 'many' ? 'auto-start-reverse' : 'auto'}
            >
              <path
                d={end === 'many' ? MANY_PATH : ONE_PATH}
                fill="none"
                strokeLinecap="round"
                style={lineStroke(lit)}
              />
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}

/**
 * Nodes as cards with a row per item, and links between rows, on a canvas
 * that pans, zooms and lets cards be dragged. Laid out in columns: what is
 * pointed at sits to the left. Hover and inspection highlight links;
 * field labels are revealed at a readable zoom without moving their handles.
 */
export function Diagram({
  nodes,
  edges,
  visibleNodes,
  visibleEdges,
  activeNode,
  activeRow,
  activeEdges,
  layoutReset,
  paneRef,
  onSelectNode,
  onSelectRow,
  onSelectEdge,
}: {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  visibleNodes: ReadonlySet<string>;
  visibleEdges: ReadonlySet<string>;
  activeNode?: string;
  activeRow?: string;
  activeEdges: ReadonlySet<string>;
  layoutReset: number;
  paneRef: Ref<HTMLDivElement>;
  onSelectNode: (id: string) => void;
  onSelectRow: (node: string, row: string) => void;
  onSelectEdge: (id: string) => void;
}) {
  const laidOut = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const yOf = (end: DiagramEnd) => rowY(byId.get(end.node), end.row);
    const { positions, routes } = layoutDiagram(
      nodes.map((n) => ({ id: n.id, width: WIDTH, height: heightOf(n) })),
      edges.map((e) => ({
        id: e.id,
        from: e.from.node,
        to: e.to.node,
        fromY: yOf(e.from),
        toY: yOf(e.to),
      })),
    );
    const cards = nodes.map(
      (n): CardNode => ({
        id: n.id,
        type: 'card',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n },
        width: WIDTH,
        height: heightOf(n),
      }),
    );
    return { cards, routes };
  }, [nodes, edges]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(laidOut.cards);
  const { fitView } = useReactFlow();
  // The routes fit the layout; once a card is dragged, lines take the stepped path.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    setFlowNodes(laidOut.cards);
    setMoved(false);
    if (layoutReset === 0) return;
    const frame = requestAnimationFrame(() => {
      void fitView(DIAGRAM_FIT_VIEW);
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, laidOut, layoutReset, setFlowNodes]);

  const cards = useMemo(() => {
    const highlighted = new Set([activeNode]);
    for (const edge of edges) {
      if (!activeEdges.has(edge.id)) continue;
      highlighted.add(edge.from.node);
      highlighted.add(edge.to.node);
    }
    return flowNodes.map(
      (card): CardNode => ({
        ...card,
        hidden: !visibleNodes.has(card.id),
        data: {
          ...card.data,
          active: card.id === activeNode,
          activeRow: card.id === activeNode ? activeRow : undefined,
          dimmed: !!activeNode && !highlighted.has(card.id),
        },
      }),
    );
  }, [activeEdges, activeNode, activeRow, edges, flowNodes, visibleNodes]);

  const [hover, setHover] = useState<{ node?: string; edge?: string } | null>(null);
  const flowEdges = useMemo(() => {
    const at = new Map(flowNodes.map((n) => [n.id, n.position]));
    return edges.flatMap((e): LinkEdge[] => {
      const a = at.get(e.from.node),
        b = at.get(e.to.node);
      if (!a || !b) return [];
      const sides =
        e.from.node === e.to.node
          ? { from: 'right' as const, to: 'right' as const }
          : linkSides({ ...a, width: WIDTH }, { ...b, width: WIDTH });
      const lit =
        activeEdges.has(e.id) ||
        hover?.edge === e.id ||
        (!!hover?.node && (hover.node === e.from.node || hover.node === e.to.node));
      return [
        {
          id: e.id,
          source: e.from.node,
          sourceHandle: handleId(e.from.row, sides.from),
          target: e.to.node,
          targetHandle: handleId(e.to.row, sides.to),
          type: 'link',
          hidden: !visibleEdges.has(e.id),
          data: { route: moved ? undefined : laidOut.routes.get(e.id) },
          zIndex: lit ? 1 : 0,
          markerStart: markerId('many', lit),
          markerEnd: markerId(e.toEnd ?? 'one', lit),
          interactionWidth: 14,
          style: {
            ...lineStroke(lit),
            opacity: (activeNode || hover) && !lit ? 0.22 : lit ? 1 : 0.7,
            ...(e.dashed ? { strokeDasharray: '5 4' } : {}),
          },
          ariaLabel: e.description,
        },
      ];
    });
  }, [activeEdges, activeNode, edges, flowNodes, hover, laidOut, moved, visibleEdges]);

  const enterNode = useCallback<NodeMouseHandler>((_, n) => setHover({ node: n.id }), []);
  const enterEdge = useCallback<EdgeMouseHandler>((_, e) => setHover({ edge: e.id }), []);
  const leave = useCallback(() => setHover(null), []);
  const dragStart = useCallback(() => setMoved(true), []);
  const clickEdge = useCallback<EdgeMouseHandler>(
    (_, clicked) => onSelectEdge(clicked.id),
    [onSelectEdge],
  );
  const actions = useMemo(() => ({ onSelectNode, onSelectRow }), [onSelectNode, onSelectRow]);
  return (
    <ActionsContext.Provider value={actions}>
      <div
        ref={paneRef}
        className="retainer-diagram relative min-h-0 min-w-0 overflow-clip bg-card"
      >
        <Markers />
        <ReactFlow
          nodes={cards}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          connectionMode={ConnectionMode.Loose}
          onNodesChange={onNodesChange}
          onNodeDragStart={dragStart}
          onNodeMouseEnter={enterNode}
          onNodeMouseLeave={leave}
          onEdgeMouseEnter={enterEdge}
          onEdgeMouseLeave={leave}
          onEdgeClick={clickEdge}
          fitView
          fitViewOptions={DIAGRAM_FIT_VIEW}
          minZoom={0.25}
          maxZoom={1.75}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          nodesFocusable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          zoomOnDoubleClick={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
          <Controls
            fitViewOptions={DIAGRAM_FIT_VIEW}
            showInteractive={false}
            position="bottom-left"
          />
          {nodes.length > 6 ? (
            <MiniMap<CardNode>
              pannable
              zoomable
              position="bottom-right"
              className="hidden md:block"
              nodeColor={(node) =>
                node.id === activeNode
                  ? 'var(--color-primary)'
                  : node.data.node.variant === 'event'
                    ? 'color-mix(in srgb, var(--primary) 48%, var(--card))'
                    : 'color-mix(in srgb, var(--muted-foreground) 46%, var(--card))'
              }
              maskStrokeWidth={1}
              onNodeClick={(_, node) => onSelectNode(node.id)}
              nodeBorderRadius={6}
              style={{ width: 140, height: 96 }}
            />
          ) : null}
        </ReactFlow>
      </div>
    </ActionsContext.Provider>
  );
}
