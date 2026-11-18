import type { ObjectView } from '@retainer/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  Clock3,
  CornerDownLeft,
  Home,
  Layers,
  Lightbulb,
  Loader2,
  Plus,
  Puzzle,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useRef, useState } from 'react';
import { useAccount } from '../accounts/context.js';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command.js';
import { ObjectIcon, RecordAvatar } from '../ui/index.js';
import {
  type RecentCommand,
  readRecentCommands,
  recentCommandsKey,
  rememberCommand,
} from './command-recents.js';
import {
  eventTitle,
  objectLabel,
  recordTitle,
  sortObjects,
  useDebounced,
  type ViewSearch,
} from './state.js';

const CreateRecordDialog = lazy(() =>
  import('./records/create-record.js').then((m) => ({ default: m.CreateRecordDialog })),
);

type Item = {
  id: string;
  title: string;
  detail?: string;
  icon: ReactNode;
  to?: string;
  search?: ViewSearch;
  create?: ObjectView;
  recent?: RecentCommand;
  hint?: string;
};

/** Text highlighting is presentation only; the server owns data matching and ranking. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.join('|')})`, 'gi');
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(offset, match.index));
    parts.push(
      <mark key={match.index} className="bg-transparent font-semibold text-inherit">
        {match[0]}
      </mark>,
    );
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session } = useWorkspace();
  const [creating, setCreating] = useState<ObjectView | null>(null);
  const navigate = useNavigate();
  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        {open ? (
          <PaletteContents onClose={() => onOpenChange(false)} onCreate={setCreating} />
        ) : null}
      </CommandDialog>
      {creating && canMutate(session) ? (
        <Suspense fallback={null}>
          <CreateRecordDialog
            key={`${session.workspace.id}:${creating.nameSingular}`}
            object={creating}
            onClose={() => setCreating(null)}
            onCreated={(id) => {
              setCreating(null);
              void navigate({ to: '/r/$id', params: { id } });
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function PaletteContents({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (object: ObjectView) => void;
}) {
  const { session, schema } = useWorkspace();
  const account = useAccount();
  const router = useRouter();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('');
  const newTab = useRef(false);
  const typed = text.trim();
  const query = useDebounced(typed);
  const limit = expanded ? 50 : 5;
  const results = useQuery({
    queryKey: [session.workspace.id, 'search', 'command', query, limit],
    enabled: !!query && typed === query,
    queryFn: ({ signal }) => api.search({ query, limit, includeContext: true }, signal),
    retry: false,
  });
  // Never let hits for the previous query be selected while the debounce settles.
  const data = typed === query && typed ? results.data : undefined;
  const searching = !!typed && (typed !== query || results.isFetching);
  const key = recentCommandsKey(session);
  const [recent] = useState(() => readRecentCommands(key));
  const recentRecords = recent.filter((r) => r.kind === 'record');
  const checked = useQueries({
    queries: recentRecords.map((r) => ({
      queryKey: [session.workspace.id, 'command-recent', r.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.record(r.id, [], signal),
      enabled: !typed,
      staleTime: 0,
      retry: false,
    })),
  });
  const objects = sortObjects(schema.objects);
  const destinations: Item[] = [
    { id: 'home', title: 'Home', detail: 'Workspace overview', icon: <Home size={17} />, to: '/' },
    {
      id: 'review',
      title: 'Review',
      detail: 'Conflicts and suggestions',
      icon: <ShieldCheck size={17} />,
      to: '/review',
    },
    {
      id: 'activity',
      title: 'Activity',
      detail: 'Events across your workspace',
      icon: <CalendarDays size={17} />,
      to: '/activity',
    },
    {
      id: 'schema',
      title: 'Schema',
      detail: 'Objects and fields',
      icon: <Layers size={17} />,
      to: '/schema',
    },
    {
      id: 'extensions',
      title: 'Extensions',
      detail: 'Connected apps and integrations',
      icon: <Puzzle size={17} />,
      to: '/extensions',
    },
    ...(account
      ? [
          {
            id: 'settings',
            title: 'Settings',
            detail: 'Workspace and personal settings',
            icon: <Settings size={17} />,
            to: '/settings',
          },
        ]
      : []),
  ];
  const objectItems: Item[] = objects.map((o) => ({
    id: `object:${o.nameSingular}`,
    title: o.labelPlural,
    detail: o.class === 'event' ? 'Browse events' : 'Browse records',
    icon: <ObjectIcon name={o.nameSingular} objectClass={o.class} />,
    to: `/o/${o.nameSingular}`,
    recent: { kind: 'object', id: o.nameSingular },
  }));
  const actions: Item[] = canMutate(session)
    ? objects
        .filter((o) => o.class === 'entity')
        .map((o) => ({
          id: `create:${o.nameSingular}`,
          title: `Create ${o.labelSingular.toLowerCase()}`,
          detail: 'Add a record',
          icon: <Plus size={17} />,
          create: o,
        }))
    : [];
  const normalizedQuery = normalize(typed);
  const match = (item: Item) =>
    !typed || normalize(`${item.title} ${item.id} ${item.detail ?? ''}`).includes(normalizedQuery);
  const recents: Item[] = recent
    .flatMap((r) => {
      if (r.kind === 'object')
        return objectItems
          .filter((o) => o.recent?.id === r.id)
          .map((o) => ({ ...o, id: `recent:${o.id}` }));
      const check = checked[recentRecords.findIndex((v) => v.id === r.id)];
      // A failed revalidation must not expose an earlier cached label.
      const record = check?.isSuccess && !check.isFetching ? check.data : undefined;
      if (!record || !schema.objects.some((o) => o.nameSingular === record.object)) return [];
      return [
        {
          id: `recent:${record.id}`,
          title: recordTitle(record),
          detail: objectLabel(schema, record.object),
          icon: (
            <RecordAvatar
              id={record.id}
              name={recordTitle(record)}
              object={record.object}
              objectClass={record.event ? 'event' : 'entity'}
            />
          ),
          to: `${record.event ? '/e' : '/r'}/${record.id}`,
          recent: { kind: 'record' as const, id: record.id },
        },
      ];
    })
    .filter((item, index, items) => items.findIndex((other) => other.id === item.id) === index);
  const records: Item[] = (data?.records ?? []).map((r) => ({
    id: `record:${r.id}`,
    title: recordTitle(r),
    detail: [objectLabel(schema, r.object), r.detail].filter(Boolean).join(' · '),
    icon: <RecordAvatar id={r.id} name={recordTitle(r)} object={r.object} />,
    to: `/r/${r.id}`,
    recent: { kind: 'record', id: r.id },
    hint: r.match === 'similar_label' ? 'Similar name' : undefined,
  }));
  const facts: Item[] = (data?.facts ?? []).flatMap((f) => {
    const record = f.record ? data?.references?.[f.record] : undefined;
    if (!record && (!account || !f.profile)) return [];
    return [
      {
        id: `fact:${f.id}`,
        title: f.content,
        detail: record
          ? `${recordTitle(record)} · ${objectLabel(schema, record.object)}`
          : f.profile === 'me'
            ? 'Personal memory'
            : 'Workspace memory',
        icon: <Lightbulb size={17} />,
        to: record ? `/r/${record.id}` : '/settings',
        search: record ? { tab: 'facts', fact: f.id } : { tab: 'memory' },
      },
    ];
  });
  const events: Item[] = (data?.events ?? []).map((e) => ({
    id: `event:${e.id}`,
    title: eventTitle(e),
    detail: [
      objectLabel(schema, e.type),
      new Date(e.occurredAt).toLocaleDateString(),
      ...e.records.slice(0, 2).flatMap((id) => {
        const record = data?.references?.[id];
        return record ? [recordTitle(record)] : [];
      }),
    ].join(' · '),
    icon: <ObjectIcon name={e.type} objectClass="event" />,
    to: `/e/${e.id}`,
    recent: { kind: 'record', id: e.id },
  }));
  const groups = [
    { title: 'Recent', items: typed ? [] : recents },
    { title: 'Go to', items: [...objectItems, ...destinations].filter(match) },
    { title: 'Records', items: records },
    { title: 'Facts', items: facts },
    { title: 'Events', items: events },
    { title: 'Actions', items: actions.filter(match) },
  ];
  const items = groups.flatMap((group) => group.items);
  const more =
    !expanded &&
    data &&
    [data.records, data.facts, data.events].some((hits) => hits.length === limit);
  const activate = (item: Item) => {
    if (item.create) {
      onClose();
      onCreate(item.create);
      return;
    }
    if (!item.to) return;
    if (item.recent) rememberCommand(key, item.recent);
    if (newTab.current) {
      window.open(
        router.buildLocation({ to: item.to, search: item.search ?? {} }).href,
        '_blank',
        'noopener,noreferrer',
      );
    } else {
      onClose();
      void navigate({ to: item.to, search: item.search ?? {} });
    }
  };
  const current = items.find((item) => item.id === selected);
  return (
    <Command
      label="Search the workspace"
      shouldFilter={false}
      loop
      value={selected}
      onValueChange={setSelected}
      onKeyDownCapture={(e) => {
        newTab.current = e.metaKey || e.ctrlKey;
      }}
      onClickCapture={(e) => {
        newTab.current = e.metaKey || e.ctrlKey;
      }}
    >
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search size={19} className="shrink-0 text-muted-foreground" />
        <CommandInput
          autoFocus
          aria-label="Search the workspace"
          placeholder="Search or run a command…"
          maxLength={500}
          value={text}
          onValueChange={(value) => {
            setText(value);
            setExpanded(false);
            setSelected('');
          }}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {searching ? (
          <Loader2
            size={16}
            className="text-muted-foreground motion-safe:animate-spin"
            aria-label="Searching"
          />
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-hover"
        >
          Esc
        </button>
      </div>
      <CommandList aria-label="Search results" aria-busy={searching}>
        {groups.map((group) =>
          group.items.length ? (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((item) => (
                <CommandItem key={item.id} value={item.id} onSelect={() => activate(item)}>
                  <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <Highlight text={item.title} query={typed} />
                    </span>
                    {item.detail ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        <Highlight text={item.detail} query={typed} />
                      </span>
                    ) : null}
                  </span>
                  {item.hint ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>
                  ) : null}
                  <ArrowRight size={14} className="text-muted-foreground opacity-50" />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null,
        )}
        {typed === query && results.error ? (
          <div role="alert" className="px-3 py-4 text-sm text-destructive">
            Search couldn’t load.{' '}
            <button type="button" className="underline" onClick={() => void results.refetch()}>
              Try again
            </button>
          </div>
        ) : null}
        {!items.length && !searching && !results.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Search size={24} className="text-muted-foreground" />
            <p className="text-sm font-medium">No results for “{typed}”</p>
            <p className="text-xs text-muted-foreground">
              Try a name, email, keyword, or page name.
            </p>
          </div>
        ) : null}
        {more ? (
          <CommandGroup>
            <CommandItem value="more" onSelect={() => setExpanded(true)}>
              <Search size={16} /> Show more results{' '}
              <span className="ml-auto text-xs text-muted-foreground">Up to 50 per category</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="flex h-10 items-center justify-between gap-2 border-t border-border px-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <ArrowUp size={12} />
          <ArrowDown size={12} /> Navigate <CornerDownLeft size={12} className="ml-2" />{' '}
          {current?.create ? 'Create' : 'Open'}
        </span>
        {current?.to ? (
          <span className="hidden sm:inline">⌘ / Ctrl + Enter · Open in new tab</span>
        ) : (
          <span className="flex items-center gap-1">
            <Clock3 size={12} /> {session.workspace.name}
          </span>
        )}
      </div>
    </Command>
  );
}
function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
