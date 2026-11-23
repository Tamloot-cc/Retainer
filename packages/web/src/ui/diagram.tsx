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
} from '@xyflow/react';
import { KeyRound } from 'lucide-react';
import {
  createContext,
  type ReactNode,
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
const FIT_VIEW = { padding: '3.7%', maxZoom: 1 } as const;

interface Actions {
  onSelectNode: (id: string) => void;
  onSelectRow: (node: string, row: string) => void;
}
const ActionsContext = createContext<Actions>({ onSelectNode: () => {}, onSelectRow: () => {} });

type CardNode = Node<{ node: DiagramNode }, 'card'>;
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

function Card({ data: { node } }: NodeProps<CardNode>) {
  const { onSelectNode, onSelectRow } = useContext(ActionsContext);
  const variant = VARIANT_CLASSES[node.variant ?? 'entity'];
  return (
    <div
      style={{ width: WIDTH }}
      className={cn(
        'rounded-lg border bg-card text-foreground shadow-sm transition-[border-color,box-shadow] hover:border-primary/60 hover:shadow-md',
        variant.card,
      )}
    >
      <div className="relative" style={{ height: HEADER }}>
        <Handles />
        <button
          type="button"
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
          <span className="truncate text-sm font-semibold">{node.label}</span>
          {node.meta ? (
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
              <button
                type="button"
                onClick={() => onSelectRow(node.id, row.id)}
                className="flex h-full w-full items-center gap-2 px-3 text-left text-xs hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
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
                  <span className="ml-auto shrink-0 pl-2 text-muted-foreground">{row.detail}</span>
                ) : null}
              </button>
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
 * pointed at sits to the left. Hovering a card or a link highlights its links;
 * clicking a link selects the row that defines it.
 */
export function Diagram({
  label,
  nodes,
  edges,
  legend,
  onSelectNode,
  onSelectRow,
}: {
  /** Accessible name of the figure. */
  label: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  legend?: ReactNode;
  onSelectNode: (id: string) => void;
  onSelectRow: (node: string, row: string) => void;
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
    const bottom = Math.max(0, ...cards.map((c) => c.position.y + (c.height ?? 0)));
    return { cards, routes, height: Math.min(680, Math.max(360, bottom + 112)) };
  }, [nodes, edges]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(laidOut.cards);
  // The routes fit the layout; once a card is dragged, lines take the stepped path.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    setFlowNodes(laidOut.cards);
    setMoved(false);
  }, [laidOut, setFlowNodes]);

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
          data: { route: moved ? undefined : laidOut.routes.get(e.id) },
          animated: lit,
          zIndex: lit ? 1 : 0,
          markerStart: markerId('many', lit),
          markerEnd: markerId(e.toEnd ?? 'one', lit),
          interactionWidth: 14,
          style: {
            ...lineStroke(lit),
            opacity: hover && !lit ? 0.25 : lit ? 1 : 0.7,
            ...(e.dashed ? { strokeDasharray: '5 4' } : {}),
          },
          ariaLabel: e.description,
        },
      ];
    });
  }, [edges, flowNodes, hover, laidOut, moved]);

  const enterNode = useCallback<NodeMouseHandler>((_, n) => setHover({ node: n.id }), []);
  const enterEdge = useCallback<EdgeMouseHandler>((_, e) => setHover({ edge: e.id }), []);
  const leave = useCallback(() => setHover(null), []);
  const dragStart = useCallback(() => setMoved(true), []);
  const clickEdge = useCallback<EdgeMouseHandler>(
    (_, clicked) => {
      const e = edges.find((x) => x.id === clicked.id);
      const end = e?.from.row !== undefined ? e.from : e?.to;
      if (end?.row !== undefined) onSelectRow(end.node, end.row);
    },
    [edges, onSelectRow],
  );
  const actions = useMemo(() => ({ onSelectNode, onSelectRow }), [onSelectNode, onSelectRow]);
  return (
    <figure aria-label={label} className="m-0 flex flex-col gap-2">
      <ActionsContext.Provider value={actions}>
        <div
          style={{ height: laidOut.height }}
          className="retainer-diagram relative max-h-[72dvh] overflow-hidden rounded-lg border border-border bg-card"
        >
          <Markers />
          <ReactFlow
            nodes={flowNodes}
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
            fitViewOptions={FIT_VIEW}
            minZoom={0.25}
            maxZoom={1.75}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            zoomOnScroll={false}
            preventScrolling={false}
            zoomOnDoubleClick={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
            <Controls showInteractive={false} position="bottom-left" />
            {nodes.length > 6 ? (
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="hidden md:block"
                nodeBorderRadius={6}
                style={{ width: 140, height: 96 }}
              />
            ) : null}
          </ReactFlow>
        </div>
      </ActionsContext.Provider>
      {legend ? (
        <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {legend}
        </figcaption>
      ) : null}
    </figure>
  );
}
