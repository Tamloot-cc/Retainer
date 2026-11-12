import { describe, expect, it } from 'vitest';
import { ENRICHMENT, enrichmentManifest } from './enrichment-contract.js';
import { companyFromSearch } from './enrichment-provider.js';

const entity = (properties: Record<string, unknown>) => ({ type: 'company', properties });
const search = (url: string, text: string, properties: Record<string, unknown> = {}) => ({
  results: [{ url, text, entities: [entity(properties)] }],
});

describe('Exa company matching', () => {
  it('matches through www and reads the count, LinkedIn page and headquarters', () => {
    expect(
      companyFromSearch(
        'acme.example',
        search(
          'https://www.acme.example/',
          '## Company Details\n- Homepage: acme.example\n- LinkedIn: linkedin.com/company/acme\n',
          {
            workforce: { total: 12.6 },
            headquarters: {
              address: 'City, ST, US',
              city: ' City ',
              postalCode: '',
              country: 'US',
            },
          },
        ),
      ),
    ).toEqual({
      status: 'match',
      values: {
        employee_count: 13,
        linkedin_url: {
          primary: { url: 'https://www.linkedin.com/company/acme' },
          additional: [],
        },
        headquarters: { city: 'City', country: 'US' },
      },
    });
  });

  it.each([
    ['another homepage domain', search('https://other.example/', '')],
    ['a contradicting Homepage line', search('https://acme.example/', '- Homepage: other.example')],
    ['no company entity', { results: [{ url: 'https://acme.example/', entities: [] }] }],
    [
      'a person entity',
      { results: [{ url: 'https://acme.example/', entities: [{ type: 'person' }] }] },
    ],
    ['no results', { results: [] }],
  ])('is no match for %s', (_case, body) => {
    expect(companyFromSearch('acme.example', body)).toEqual({ status: 'no_match' });
  });

  it.each([
    ['- LinkedIn: https://www.linkedin.com/company/acme-inc/', 'acme-inc'],
    ['- LinkedIn: uk.linkedin.com/company/acme_2', 'acme_2'],
    ['- LinkedIn: linkedin.com/in/a-person', undefined],
    ['- LinkedIn: linkedin.com.evil.example/company/acme', undefined],
    ['LinkedIn: linkedin.com/company/acme', undefined],
    ['- LinkedIn: linkedin.com/company/acme?trk=x', undefined],
  ])('reads %j strictly', (line, slug) => {
    const result = companyFromSearch('acme.example', search('https://acme.example/', line));
    expect(result.status).toBe('match');
    const url = result.status === 'match' ? result.values.linkedin_url : undefined;
    expect(url).toEqual(
      slug
        ? { primary: { url: `https://www.linkedin.com/company/${slug}` }, additional: [] }
        : undefined,
    );
  });

  it.each([[-1], [10_000_001], [Number.NaN], [null]])('drops an employee count of %s', (total) => {
    const result = companyFromSearch(
      'acme.example',
      search('https://acme.example/', '', { workforce: { total } }),
    );
    expect(result.status === 'match' && 'employee_count' in result.values).toBe(false);
  });
});

describe('enrichment manifest', () => {
  it('declares the reviewed outputs, the domain lookup and a narrow mapped-write trigger', () => {
    const manifest = enrichmentManifest({
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    });
    expect(manifest.requestedActor).toBe('agent');
    expect(manifest.mapping?.outputs.map((o) => [o.key, o.types, o.field?.universalId])).toEqual([
      ['employee_count', ['number'], ENRICHMENT.employeeCountField],
      ['linkedin_url', ['links'], ENRICHMENT.linkedinField],
      ['headquarters', ['address'], ENRICHMENT.headquartersField],
    ]);
    const enrich = manifest.functions.find((f) => f.universalId === ENRICHMENT.enrich);
    expect(enrich).toMatchObject({
      mappedWrite: true,
      secrets: ['apiKey'],
      trigger: {
        fieldIds: [ENRICHMENT.domainField],
        related: false,
        operations: ['create', 'update'],
      },
    });
    expect(manifest.settings.shareDomains).toMatchObject({ consent: true, required: true });
  });
});
