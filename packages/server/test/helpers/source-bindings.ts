import type { ExtensionBinding } from '@retainer/extension';

export const sourceTestBindings: ExtensionBinding[] = [
  {
    key: 'conversation',
    creates: true,
    label: 'Conversations',
    description: 'Events from the test source.',
    class: 'event',
    access: 'write',
    required: true,
    fields: [
      {
        description: 'Fixture description.',
        key: 'transcript',
        label: 'Transcript',
        types: ['files'],
        required: false,
      },
      {
        description: 'Fixture description.',
        key: 'tag',
        label: 'Tag',
        types: ['text'],
        required: false,
      },
    ],
  },
  {
    key: 'person',
    label: 'People',
    description: 'Test source participants.',
    class: 'entity',
    access: 'write',
    required: true,
    match: 'emails',
    fields: [
      {
        description: 'Fixture description.',
        key: 'emails',
        label: 'Emails',
        types: ['emails'],
        required: true,
      },
      {
        description: 'Fixture description.',
        key: 'name',
        label: 'Name',
        types: ['full_name', 'text'],
        required: false,
      },
    ],
  },
];
