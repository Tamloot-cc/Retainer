import {
  type FieldView,
  dashboardValue as plainValue,
  type SchemaDescription,
} from '@retainer/shared';
import { expect, it, vi } from 'vitest';
import { dashboardTools, isDashboardResult } from './tools.js';

const field = (type: FieldView['type'], settings = {}) => ({ type, settings }) as FieldView;

it('converts composite values, options and relations for display', () => {
  expect(plainValue({ amountMicros: -12_500_000, currency: 'EUR' })).toEqual({
    amount: -12.5,
    currency: 'EUR',
  });
  expect(plainValue({ first: 'Dana', last: 'Doe' })).toBe('Dana Doe');
  expect(plainValue({ primary: 'dana@example.test', additional: [] }, field('emails'))).toBe(
    'dana@example.test',
  );
  expect(plainValue({ primary: { number: '+15551234567' }, additional: [] }, field('phones'))).toBe(
    '+15551234567',
  );
  expect(
    plainValue({ primary: { url: 'https://dana.example' }, additional: [] }, field('links')),
  ).toBe('https://dana.example');
  expect(plainValue({ primary: null, additional: [] }, field('emails'))).toBeNull();
  const options = [
    { value: 'open', label: 'In progress' },
    { value: 'won', label: 'Won' },
  ];
  expect(plainValue('open', field('select', { options }))).toBe('In progress');
  expect(plainValue(['open', 'won'], field('multi_select', { options }))).toBe('In progress, Won');
  expect(
    plainValue('company-1', field('relation'), {
      'company-1': { id: 'company-1', label: 'Acme', object: 'company' },
    }),
  ).toBe('Acme');
  expect(plainValue('company-1', field('relation'))).toBeNull();
});

it('projects record fields and group measures under the program’s aliases', async () => {
  const api = {
    queryRecords: vi.fn().mockResolvedValue({
      records: [
        {
          id: 'deal-1',
          label: 'Renewal',
          object: 'deal',
          fields: {
            amount: { amountMicros: 3_000_000, currency: 'USD' },
            other: 'Omit',
            stage: 'lead',
          },
        },
      ],
    }),
    aggregate: vi.fn().mockResolvedValue({
      total: 1,
      values: [{ field: 'amount', op: 'sum', as: 'pipeline', value: null, mixedCurrencies: true }],
      groups: [
        {
          value: 'lead',
          label: 'Lead',
          total: 1,
          values: [
            {
              field: 'amount',
              op: 'sum',
              as: 'pipeline',
              value: { amountMicros: 3_000_000, currency: 'USD' },
            },
          ],
        },
      ],
      tooManyGroups: true,
    }),
  };
  const schema = {
    objects: [
      {
        nameSingular: 'deal',
        fields: [
          {
            ...field('select', { options: [{ value: 'lead', label: 'Lead' }] }),
            name: 'stage',
          },
        ],
      },
    ],
  } as SchemaDescription;
  const reads = dashboardTools(api, schema);
  const result = await reads.query_records({
    object: 'deal',
    fields: { dealAmount: 'amount', stageName: 'stage' },
  });
  expect(isDashboardResult(result)).toBe(true);
  expect(isDashboardResult({ records: [] })).toBe(false);
  expect(result).toEqual({
    records: [
      {
        id: 'deal-1',
        label: 'Renewal',
        dealAmount: { amount: 3, currency: 'USD' },
        stageName: 'Lead',
      },
    ],
  });
  expect(api.queryRecords).toHaveBeenCalledWith('deal', { include: ['relationReferences'] });
  expect(
    await reads.aggregate_records({
      object: 'deal',
      groupBy: 'stage',
      aggregates: [{ field: 'amount', op: 'sum', as: 'pipeline' }],
    }),
  ).toEqual({
    total: 1,
    values: { pipeline: { mixedCurrencies: true } },
    groups: [{ value: 'lead', label: 'Lead', total: 1, pipeline: { amount: 3, currency: 'USD' } }],
    tooManyGroups: true,
  });
});
