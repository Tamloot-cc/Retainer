import type {
  AggregateGroup,
  AggregateInput,
  FieldView,
  ObjectView,
  PresentedRecord,
  QueryInput,
  RecordReference,
  SavedView,
} from '@retainer/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { categoryColor } from '../../ui/colors.js';
import {
  Board,
  BoardCard,
  BoardColumn,
  type CardField,
  CardPreview,
  ColumnMore,
  ColumnNote,
  DragArea,
  Inset,
  Notice,
} from '../../ui/index.js';
import { withEventValues } from '../events/event-list.js';
import type { MoveNotice } from '../records/record-move.js';
import { useRecordMoves } from '../records/record-move.js';
import { isWritable } from '../records/write-model.js';
import { QueryError, recordTitle } from '../state.js';
import { defaultColumnOrder, formatAggregate } from './list-state.js';
import { MissingLayoutField } from './view-bar.js';
import {
  andFilter,
  type BoardGroup,
  boardGroups,
  groupCondition,
  groupKey,
} from './views-state.js';

const PAGE_SIZE = 25;
/** How many of the view's fields a card shows under its title. */
const CARD_FIELDS = 4;

/** A card's record, with the labels of the records it links to. */
type Card = { record: PresentedRecord; references: Record<string, RecordReference> | undefined };
/** Records on the move: the value each is moving to, and its card. */
type Moving = Record<string, { value: unknown; item: Card }>;

/**
 * A board: one column per option of the view's group field, then "No
 * value", each a filtered query of its own with "Show more". Dragging a card
 * to another column changes the record's group field.
 */
export function BoardView({
  object,
  view,
  filter,
  sort,
  order,
  writable,
  selected,
  onOpen,
  onChangeView,
}: {
  object: ObjectView;
  view: SavedView;
  filter: Record<string, unknown> | undefined;
  sort: QueryInput['sort'];
  /** The view's visible fields, in order; cards show the first few. */
  order: string[] | undefined;
  /** Can write: cards can be dragged, and the view changed. */
  writable: boolean;
  selected: string | undefined;
  onOpen: (id: string) => void;
  onChangeView: (change: { groupBy: string }) => void;
}) {
  const field = object.fields.find((f) => f.name === view.groupBy);
  const moves = useRecordMoves<Card>();

  const { session } = useWorkspace();
  const name = object.nameSingular;
  // Each column's count and header total, over the view's filter.
  const totalsInput: AggregateInput = {
    filter,
    ...(field ? { groupBy: field.name, limit: 200 } : {}),
    aggregates: view.groupAggregate ? [view.groupAggregate] : [],
  };
  const totals = useQuery({
    queryKey: [session.workspace.id, 'aggregate', name, totalsInput],
    queryFn: ({ signal }) => api.aggregate(name, totalsInput, signal),
    enabled: !!field,
    placeholderData: (previous) => previous,
  });

  if (!field)
    return (
      <MissingLayoutField
        object={object}
        view={view}
        kind="board"
        writable={writable}
        onChoose={(groupBy) => onChangeView({ groupBy })}
      />
    );

  const groups = boardGroups(field).filter((g) => !view.hiddenGroups.includes(g.value));
  const byValue = new Map(totals.data?.groups?.map((g) => [g.value, g]));
  const cardFields = (order ?? defaultColumnOrder(object))
    .filter((n) => n !== field.name && n !== object.labelField)
    .map((n) => object.fields.find((f) => f.name === n))
    .filter((f): f is FieldView => !!f);
  const aggregateField = view.groupAggregate
    ? object.fields.find((f) => f.name === view.groupAggregate?.field)
    : undefined;
  const draggable = writable && isWritable(field);

  const toCard = ({ record, references }: Card) => ({
    title: recordTitle(record),
    fields: cardFields
      .filter((f) => !fields[f.type].isEmpty(record.fields[f.name]))
      .slice(0, CARD_FIELDS)
      .map((f): CardField => {
        const Display = fields[f.type].Display;
        return {
          name: f.name,
          label: f.label,
          value: (
            <Display field={f} value={record.fields[f.name]} compact references={references} />
          ),
        };
      }),
  });
  const groupOf = (key: string) => groups.find((g) => g.key === key);

  return (
    <>
      {moves.notice ? <MoveNoticeBar notice={moves.notice} onDismiss={moves.dismiss} /> : null}
      {totals.error ? (
        <Inset>
          <QueryError error={totals.error} retry={() => void totals.refetch()} />
        </Inset>
      ) : null}
      <DragArea<Card>
        names={{
          item: (card) => recordTitle(card.record),
          target: (key) => `the ${groupOf(key)?.label ?? ''} column`,
        }}
        overlay={(card) => <CardPreview {...toCard(card)} />}
        onMove={(card, key) => {
          const group = groupOf(key);
          if (group) void moves.move(card, field, group.value, group.label);
        }}
      >
        <Board label={`${object.labelPlural} by ${field.label.toLowerCase()}`}>
          {groups.map((group) => (
            <Column
              key={group.key}
              object={object}
              field={field}
              group={group}
              filter={filter}
              sort={sort}
              total={totals.data ? (byValue.get(group.value)?.total ?? 0) : undefined}
              meta={
                aggregateField && view.groupAggregate ? (
                  <ColumnTotal field={aggregateField} group={byValue.get(group.value)} />
                ) : undefined
              }
              moving={moves.moving}
              draggable={draggable}
              selected={selected}
              onOpen={onOpen}
              toCard={toCard}
            />
          ))}
        </Board>
      </DragArea>
    </>
  );
}

function ColumnTotal({ field, group }: { field: FieldView; group: AggregateGroup | undefined }) {
  const value = group?.values[0];
  return value ? formatAggregate(field, value) : null;
}

function MoveNoticeBar({ notice, onDismiss }: { notice: MoveNotice; onDismiss: () => void }) {
  return (
    <Inset>
      <Notice error={notice.error} onDismiss={onDismiss}>
        {notice.text}
      </Notice>
    </Inset>
  );
}

/** One column's records: its own query, plus cards moving in, minus cards moving out. */
function Column({
  object,
  field,
  group,
  filter,
  sort,
  total,
  meta,
  moving,
  draggable,
  selected,
  onOpen,
  toCard,
}: {
  object: ObjectView;
  field: FieldView;
  group: BoardGroup;
  filter: Record<string, unknown> | undefined;
  sort: QueryInput['sort'];
  total: number | undefined;
  meta: React.ReactNode;
  moving: Moving;
  draggable: boolean;
  selected: string | undefined;
  onOpen: (id: string) => void;
  toCard: (card: Card) => { title: string; fields: CardField[] };
}) {
  const { session } = useWorkspace();
  const name = object.nameSingular;
  const input = {
    filter: andFilter(filter, groupCondition(field, group.value)),
    ...(sort ? { sort } : {}),
    limit: PAGE_SIZE,
    include: ['relationReferences'],
  };
  const query = useInfiniteQuery({
    queryKey: [session.workspace.id, 'records', name, 'board', input],
    queryFn: ({ signal, pageParam }) =>
      api.queryRecords(name, pageParam ? { ...input, cursor: pageParam } : input, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const cards: Card[] = (query.data?.pages ?? []).flatMap((page) =>
    // An event's built-in columns read like fields on its card.
    page.records.map((record) => ({
      record: withEventValues(record),
      references: page.relationReferences,
    })),
  );
  const here = new Set(cards.map((c) => c.record.id));
  // Cards on the move show where they are going while the move saves.
  const isHere = (id: string) => groupKey(moving[id]?.value as string | null) === group.key;
  const incoming = Object.entries(moving)
    .filter(([id]) => isHere(id) && !here.has(id))
    .map(([, m]) => m.item);
  const outgoing = new Set(Object.keys(moving).filter((id) => here.has(id) && !isHere(id)));
  const shown = [...incoming, ...cards.filter((c) => !outgoing.has(c.record.id))];
  const count = total === undefined ? undefined : total + incoming.length - outgoing.size;

  return (
    <BoardColumn
      id={group.key}
      title={group.label}
      color={group.value === null ? undefined : categoryColor(group.value)}
      count={count}
      meta={meta}
      locked={!draggable}
      footer={
        query.hasNextPage ? (
          <ColumnMore loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </ColumnMore>
        ) : null
      }
    >
      {query.error ? (
        <ColumnNote>{query.error.message}</ColumnNote>
      ) : query.isPending ? (
        <ColumnNote>Loading…</ColumnNote>
      ) : shown.length ? (
        shown.map((card) => (
          <BoardCard
            key={card.record.id}
            id={card.record.id}
            column={group.key}
            item={card}
            {...toCard(card)}
            // One move at a time: a card saving its move can't be moved again.
            draggable={draggable && !Object.hasOwn(moving, card.record.id)}
            selected={selected === card.record.id}
            pending={Object.hasOwn(moving, card.record.id)}
            onOpen={() => onOpen(card.record.id)}
          />
        ))
      ) : (
        <ColumnNote>No {object.labelPlural.toLowerCase()}</ColumnNote>
      )}
    </BoardColumn>
  );
}
