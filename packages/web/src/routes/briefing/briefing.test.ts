import type { SchemaDescription } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { firstSentence, missingCount, missingDescriptions, toolInputs } from './briefing.js';

const schema = {
  objects: [
    {
      nameSingular: 'company',
      description: 'A business we sell to.',
      fields: [
        { name: 'name', description: 'The company’s legal name.', settings: {} },
        { name: 'category', description: null, settings: {} },
        { name: 'notes', description: '   ', settings: {} },
        // Inverse: read only and described by its other side.
        { name: 'people', description: null, type: 'relation', settings: { isInverse: true } },
      ],
    },
    {
      nameSingular: 'person',
      description: 'Someone we know.',
      fields: [{ name: 'email', description: 'Work email.', settings: {} }],
    },
    {
      nameSingular: 'market',
      description: null,
      fields: [{ name: 'region', description: null, settings: {} }],
    },
  ],
} as unknown as SchemaDescription;

describe('the missing descriptions list', () => {
  it('groups objects and fields with no description, leaving out inverse relations', () => {
    const groups = missingDescriptions(schema);
    expect(
      groups.map((g) => [g.object.nameSingular, g.objectMissing, g.fields.map((f) => f.name)]),
    ).toEqual([
      ['company', false, ['category', 'notes']],
      ['market', true, ['region']],
    ]);
    expect(missingCount(groups)).toBe(4);
  });

  it('is empty when everything is described', () => {
    const described = {
      objects: [schema.objects[1]],
    } as unknown as SchemaDescription;
    expect(missingDescriptions(described)).toEqual([]);
  });
});

describe('the tools list', () => {
  it('collapses a description to its first sentence', () => {
    expect(firstSentence('Returns a record. Use it to read one.')).toBe('Returns a record.');
    expect(firstSentence('No full stop')).toBe('No full stop');
    expect(firstSentence('Reads v1.2 records. Then more.')).toBe('Reads v1.2 records.');
    expect(firstSentence('Changes the type of logged events, e.g. calls to meetings. More.')).toBe(
      'Changes the type of logged events, e.g. calls to meetings.',
    );
  });

  it('lists inputs with type, whether required and their own description', () => {
    expect(
      toolInputs({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The record ID.' },
          tokenBudget: { type: 'integer' },
          fields: { type: 'array', items: { type: 'string' } },
          mode: { enum: ['a', 'b'] },
          record: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'string' }] },
        },
        required: ['id'],
      }),
    ).toEqual([
      { name: 'id', type: 'string', required: true, description: 'The record ID.' },
      { name: 'tokenBudget', type: 'integer', required: false, description: '' },
      { name: 'fields', type: 'array of string', required: false, description: '' },
      { name: 'mode', type: '"a" | "b"', required: false, description: '' },
      { name: 'record', type: 'string', required: false, description: '' },
    ]);
  });
});
