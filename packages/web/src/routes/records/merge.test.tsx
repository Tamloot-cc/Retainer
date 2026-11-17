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

it('shows full long titles and keeps the older ID while allowing the newer value to win', async () => {
  const originalTitle =
    "Schedule Orchid's presentation of its AI-security solution and internal AI use to Team8 (Matt to present)";
  const updatedTitle =
    'Schedule a session for Orchid to present its AI-security solution and internal AI use back to the Team8 AI team.';
  const object = {
    nameSingular: 'task',
    fields: [{ name: 'title', label: 'Title', type: 'text', settings: {} }],
  } as ObjectView;
  const older = {
    id: 'older',
    object: 'task',
    label: originalTitle,
    fields: { title: originalTitle },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: { type: 'user', id: 'user' },
    updatedBy: { type: 'user', id: 'user' },
  } as PresentedRecord;
  const newer = {
    ...older,
    id: 'newer',
    label: updatedTitle,
    fields: { title: updatedTitle },
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
  expect(screen.getByText(originalTitle, { exact: true })).toBeTruthy();
  expect(screen.getByText(updatedTitle, { exact: true })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /Value for Title/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Newer record’s' }));
  await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
  await waitFor(() =>
    expect(merge).toHaveBeenCalledWith(
      older.id,
      { recordId: newer.id, values: { title: updatedTitle } },
      expect.any(String),
    ),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
