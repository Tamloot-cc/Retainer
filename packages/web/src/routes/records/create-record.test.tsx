import type { FieldView, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WorkspaceContext } from '../../api/client.js';
import { CreateRecordDialog } from './create-record.js';

const title: FieldView = {
  name: 'subject',
  label: 'Subject',
  type: 'text',
  description: null,
  settings: {},
  readOnly: false,
  owner: 'system',
  isProtected: false,
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: true,
};
const object: ObjectView = {
  nameSingular: 'ticket',
  namePlural: 'tickets',
  labelSingular: 'Ticket',
  labelPlural: 'Tickets',
  description: null,
  class: 'entity',
  owner: 'system',
  isProtected: false,
  labelField: title.name,
  fields: [
    { ...title, name: 'queue', label: 'Queue', isNullable: false },
    title,
    { ...title, name: 'description', label: 'Description' },
    { ...title, name: 'assignee', label: 'Assignee' },
  ],
};
const session: Session = {
  workspace: { id: 'w1', name: 'Test', slug: 'test' },
  actor: { type: 'user', id: 'dana' },
  scopes: ['read', 'write'],
  person: true,
};
const schema: SchemaDescription = {
  workspace: { ...session.workspace, schemaVersion: 1, initialized: true, templates: [] },
  objects: [object],
  valueFormats: {},
  builtIns: [],
};

function renderComposer() {
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={{ session, schema }}>
        <CreateRecordDialog object={object} onClose={vi.fn()} onCreated={onCreated} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onCreated };
}

it('focuses the schema label first and returns to a required property on invalid submit', async () => {
  const { user, onCreated } = renderComposer();

  const subject = await screen.findByRole('textbox', { name: 'Subject' });
  expect(document.activeElement).toBe(subject);
  await user.type(subject, 'Follow up');
  const create = screen.getByRole('button', { name: 'Create ticket' });
  await user.click(create);
  expect(screen.getByText('Queue is required')).toBeTruthy();
  const queue = screen.getByRole('textbox', { name: 'Queue', description: 'Queue is required' });
  expect(document.activeElement).toBe(queue);
  expect(queue.getAttribute('aria-invalid')).toBe('true');
  await user.type(queue, 'Support');
  expect(queue.getAttribute('aria-invalid')).toBe('false');
  expect(queue.hasAttribute('aria-describedby')).toBe(false);
  expect(subject).toHaveProperty('value', 'Follow up');
  expect(onCreated).not.toHaveBeenCalled();
});

it('shows a schema description in the writing area and keeps property edits when collapsed', async () => {
  const { user } = renderComposer();
  const description = await screen.findByRole('textbox', { name: 'Description' });
  await user.type(description, 'First line{Enter}Second line');
  expect(description).toHaveProperty('value', 'First line\nSecond line');
  expect(screen.queryByRole('textbox', { name: 'Assignee' })).toBeNull();

  await user.click(screen.getByRole('button', { name: /^Assignee$/ }));
  const assignee = screen.getByRole('textbox', { name: 'Assignee' });
  expect(document.activeElement).toBe(assignee);
  await user.type(assignee, 'Dana');
  const property = screen.getByRole('button', { name: 'Assignee Dana' });
  await user.click(property);
  expect(screen.queryByRole('textbox', { name: 'Assignee' })).toBeNull();
  await user.click(property);
  expect(screen.getByRole('textbox', { name: 'Assignee' })).toHaveProperty('value', 'Dana');
});
