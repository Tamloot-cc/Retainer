import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { Button, Notice } from '../../ui/index.js';
import { DraftCard } from '../agent/draft-card.js';
import { objectByName, recordTitle } from '../state.js';
import { describeFilter, SettingsSummary } from './settings-summary.js';
import { parseViewDraft, viewSettings } from './view-draft.js';
import { viewsKey } from './views-state.js';

export default function ViewChatBlock({
  code,
  streaming,
  complete,
}: {
  code: string;
  streaming: boolean;
  complete: boolean;
}) {
  const { session, schema } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const parsed = useMemo(() => {
    if (!complete || streaming) return {};
    try {
      return { draft: parseViewDraft(code) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [code, complete, streaming]);
  const { draft } = parsed;
  const checked = useQuery({
    queryKey: [session.workspace.id, 'view-check', code],
    queryFn: ({ signal }) =>
      api.checkView(draft, draft && 'object' in draft ? draft.object : undefined, signal),
    enabled: !!draft,
    retry: false,
  });
  const check = checked.data;
  const preview = check?.ok ? check.preview : undefined;
  const object = objectByName(schema, preview?.object);
  const id = draft && 'view' in draft ? draft.view : undefined;
  const readOnly = !!id && Object.keys(draft ?? {}).length === 1;
  const records = useQuery({
    queryKey: [
      session.workspace.id,
      'records',
      preview?.object,
      'view-preview',
      preview?.filter,
      preview?.sort,
      preview?.search,
    ],
    queryFn: ({ signal }) => {
      if (!preview) throw new Error('Check the draft before previewing records.');
      return api.queryRecords(
        preview.object,
        {
          filter: preview.filter ?? undefined,
          sort: preview.sort ?? undefined,
          search: preview.search ?? undefined,
          limit: 5,
        },
        signal,
      );
    },
    enabled: !!preview && !preview.groupBy,
  });
  const nav = (object: string, search: { view?: string; draft?: string }) =>
    navigate({ to: '/o/$object', params: { object }, search });
  const keep = useMutation({
    mutationFn: async (mode: 'update' | 'new') => {
      if (!draft || !preview) throw new Error('Check the draft before saving.');
      if (mode === 'update' && 'view' in draft) {
        const { view, ...patch } = draft;
        return api.updateView(view, { ...patch, expectedUpdatedAt: preview.updatedAt });
      }
      return api.createView(preview.object, { ...viewSettings(preview), visibility: 'private' });
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: viewsKey(session.workspace.id, saved.object) });
      void nav(saved.object, { view: saved.id });
    },
    onError: async (error) => {
      if ('status' in error && error.status === 409) await checked.refetch();
    },
  });
  const message =
    parsed.error ??
    checked.error?.message ??
    (complete ? undefined : 'The view draft is incomplete.');
  return (
    <DraftCard
      notice={keep.error && <Notice error>{keep.error.message}</Notice>}
      actions={
        preview &&
        object && (
          <>
            <Button
              size="small"
              onClick={() =>
                void nav(preview.object, readOnly ? { view: id } : { draft: JSON.stringify(draft) })
              }
            >
              Open
            </Button>
            {canMutate(session) && !readOnly && (
              <>
                {id && (
                  <Button
                    size="small"
                    disabled={keep.isPending}
                    onClick={() => keep.mutate('update')}
                  >
                    Update “{preview.name}”
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="small"
                  disabled={keep.isPending}
                  onClick={() => keep.mutate('new')}
                >
                  {id ? 'Save as new' : 'Save view'}
                </Button>
              </>
            )}
          </>
        )
      }
    >
      <div>
        <h3 className="text-sm font-medium">{preview?.name ?? 'View draft'}</h3>
        {preview?.description && (
          <p className="text-sm text-muted-foreground">{preview.description}</p>
        )}
      </div>
      {streaming ? (
        <p className="text-xs text-muted-foreground">Drafting view…</p>
      ) : message ? (
        <Notice error>{message}</Notice>
      ) : check && !check.ok ? (
        <Notice error>
          <ul>
            {check.problems.map(({ path, message }) => (
              <li key={`${path}:${message}`}>
                {path.replaceAll('.', ' · ')} — {message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : preview && object ? (
        <>
          {preview.issues.length > 0 && <Notice>{preview.issues.join(' ')}</Notice>}
          <SettingsSummary
            view={preview}
            object={object}
            filters={preview.filter ? [{ text: describeFilter(preview.filter, object) }] : []}
          />
          <p className="text-xs font-medium">
            {check?.ok &&
              `${check.count.toLocaleString()} matching ${check.count === 1 ? 'record' : 'records'}`}
          </p>
          {records.error && <Notice error>{records.error.message}</Notice>}
          <ul className="space-y-1 text-sm">
            {preview.groupBy && check?.ok
              ? check.groups?.slice(0, 5).map((group) => (
                  <li key={group.overflow ? 'overflow' : (group.value ?? 'empty')}>
                    {group.label} · {group.total.toLocaleString()}
                  </li>
                ))
              : records.data?.records.map((record) => (
                  <li key={record.id}>{recordTitle(record)}</li>
                ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Checking view…</p>
      )}
    </DraftCard>
  );
}
