import type { ObjectView, PresentedRecord } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { MergeDialog } from './merge.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps the older ID when opened from the newer record and allows its value to win', async () => {
  const object = {
    nameSingular: 'task',
    fields: [{ name: 'title', label: 'Title', type: 'text', settings: {} }],
  } as ObjectView;
  const older = {
    id: 'older',
    object: 'task',
    label: 'Original title',
    fields: { title: 'Original title' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: { type: 'user', id: 'user' },
    updatedBy: { type: 'user', id: 'user' },
  } as PresentedRecord;
  const newer = {
    ...older,
    id: 'newer',
    label: 'Updated title',
    fields: { title: 'Updated title' },
    createdAt: '2026-02-01T00:00:00Z',
  };
  vi.spyOn(api, 'record').mockImplementation(async (id) => (id === older.id ? older : newer));
  const merge = vi.spyOn(api, 'mergeRecords').mockResolvedValue({
    id: older.id,
    merged: true,
    record: older,
  } as never);
  const onClose = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{ session: { workspace: { id: 'w1' } }, schema: { objects: [object] } } as never}
      >
        <MergeDialog ids={[newer.id, older.id]} onClose={onClose} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: /Value for Title/ });
  expect(screen.queryByRole('radio')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Value for Title/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Newer record’s' }));
  await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
  await waitFor(() =>
    expect(merge).toHaveBeenCalledWith(
      older.id,
      { recordId: newer.id, values: { title: 'Updated title' } },
      expect.any(String),
    ),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
