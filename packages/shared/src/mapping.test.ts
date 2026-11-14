import { describe, expect, it } from 'vitest';
import { compatibleFields, mappingFieldIssue } from './mapping.js';
import { BASE_FIELD_IDS } from './schema.js';

const links = { types: ['links'] as const };
const domain = BASE_FIELD_IDS.companyDomain;

describe('compatibleFields', () => {
  // The schema API's view: base fields say which they are, others don't.
  const viewed = [
    { name: 'name', type: 'text' },
    { name: 'domain', type: 'links', baseField: 'companyDomain' },
    { name: 'profile', type: 'links' },
    { name: 'headcount', type: 'number' },
    { name: 'score', type: 'number', readOnly: true },
  ];

  it('offers writable fields of an accepted type, never the lookup field', () => {
    expect(compatibleFields(viewed, links, domain).map((f) => f.name)).toEqual(['profile']);
    expect(compatibleFields(viewed, links).map((f) => f.name)).toEqual(['domain', 'profile']);
    expect(
      compatibleFields(viewed, { types: ['number', 'text'] }, domain).map((f) => f.name),
    ).toEqual(['name', 'headcount']);
  });

  it('finds the lookup field by universal ID in the server’s schema state', () => {
    const state = [
      { universalId: domain, type: 'links' },
      { universalId: 'b8d9c2f4-0b5e-4a57-9d3c-7d1f9e2a6c11', type: 'links' },
    ];
    expect(compatibleFields(state, links, domain)).toEqual([state[1]]);
    const inverse = { type: 'links', settings: { isInverse: true } };
    expect(compatibleFields([inverse], links)).toEqual([]);
  });
});

describe('mappingFieldIssue', () => {
  it('reports the lookup field first, then a read-only field, then the type', () => {
    expect(mappingFieldIssue({ universalId: domain, type: 'links' }, links, domain)).toBe(
      'lookup_field',
    );
    expect(
      mappingFieldIssue({ universalId: domain, type: 'links' }, { types: ['number'] }, domain),
    ).toBe('lookup_field');
    expect(mappingFieldIssue({ type: 'links', readOnly: true }, links)).toBe('read_only');
    expect(mappingFieldIssue({ type: 'text' }, links, domain)).toBe('incompatible_type');
    expect(mappingFieldIssue({ type: 'links' }, links, domain)).toBeUndefined();
  });
});
