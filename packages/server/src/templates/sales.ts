import { STARTER_OBJECT_IDS } from './base.js';
import type { Template } from './types.js';

const DEAL = 'b33dc227-3182-494c-b671-536abda83205';

export const sales: Template = {
  name: 'sales',
  extends: 'starter',
  version: 1,
  label: 'Sales',
  description:
    'B2B sales teams and founders selling: deals that move through stages to won or lost.',
  operations: [
    {
      op: 'create_object',
      object: {
        universalId: DEAL,
        nameSingular: 'deal',
        namePlural: 'deals',
        labelSingular: 'Deal',
        labelPlural: 'Deals',
        description: 'A sales opportunity.',
        labelField: 'name',
        fields: [
          {
            universalId: '94ef68e7-fab5-4e20-930e-60a89aa3fa52',
            name: 'name',
            label: 'Name',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: 'b2eacbe7-f068-4fe7-9c0a-5e092edaae29',
            name: 'stage',
            label: 'Stage',
            type: 'select',
            settings: {
              options: [
                { value: 'lead', label: 'Lead' },
                { value: 'qualified', label: 'Qualified' },
                { value: 'proposal', label: 'Proposal' },
                { value: 'negotiation', label: 'Negotiation' },
                { value: 'won', label: 'Won' },
                { value: 'lost', label: 'Lost' },
              ],
            },
          },
          {
            universalId: 'f402722b-d359-4c41-a674-910260cdae77',
            name: 'amount',
            label: 'Amount',
            type: 'money',
          },
          {
            universalId: 'fb5e9ab8-c154-446d-89fd-0f1b277c7dce',
            name: 'closeDate',
            label: 'Close date',
            type: 'date',
          },
          {
            universalId: '0b658abb-884b-40b0-ae38-04012be9becb',
            name: 'company',
            label: 'Company',
            type: 'relation',
            settings: { targetObject: STARTER_OBJECT_IDS.company, inverseField: 'deals' },
          },
          {
            universalId: '84c1da70-cc05-4a3b-8630-2ab67d799693',
            name: 'pointOfContact',
            label: 'Point of contact',
            type: 'relation',
            settings: { targetObject: STARTER_OBJECT_IDS.person, inverseField: 'deals' },
          },
        ],
      },
    },
    {
      op: 'create_field',
      object: STARTER_OBJECT_IDS.company,
      field: {
        universalId: '7a05d786-a047-4782-9c00-8c72d0e793bf',
        name: 'industry',
        label: 'Industry',
        type: 'text',
        isSearchable: true,
      },
    },
    {
      op: 'create_field',
      object: STARTER_OBJECT_IDS.company,
      field: {
        universalId: '0dc97bea-8bbe-4bd8-9713-0c6628049268',
        name: 'employeeCount',
        label: 'Employees',
        type: 'number',
      },
    },
  ],
};
