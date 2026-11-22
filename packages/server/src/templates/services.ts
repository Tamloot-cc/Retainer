import { STARTER_OBJECT_IDS } from './base.js';
import type { Template } from './types.js';

const PROJECT = '8ed633e3-7356-4174-b090-8780fd291f31';
const PROPOSAL = '33883890-1e98-4591-8859-c6d6ed7e8ecd';

export const services: Template = {
  name: 'services',
  extends: 'starter',
  version: 1,
  label: 'Services',
  description:
    'Agencies, consultants, advisors and freelancers: projects or engagements delivered for ' +
    'clients, and the proposals that win them.',
  operations: [
    {
      op: 'create_object',
      object: {
        universalId: PROJECT,
        nameSingular: 'project',
        namePlural: 'projects',
        labelSingular: 'Project',
        labelPlural: 'Projects',
        description: 'Work delivered for a client.',
        labelField: 'name',
        fields: [
          {
            universalId: '5c09f030-9751-4dcf-8b85-08d98fd5d6d8',
            name: 'name',
            label: 'Name',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: '1295ea09-4e33-4853-85dd-3c1ede76b4ef',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'planned', label: 'Planned' },
                { value: 'active', label: 'Active' },
                { value: 'on_hold', label: 'On hold' },
                { value: 'completed', label: 'Completed' },
                { value: 'cancelled', label: 'Cancelled' },
              ],
            },
          },
          {
            universalId: 'f19c7dbe-6a30-4a07-9ff2-da8f9d6fa366',
            name: 'budget',
            label: 'Budget',
            type: 'money',
          },
          {
            universalId: '1ace1098-e185-4cd8-aad3-4ca21f6d1614',
            name: 'startDate',
            label: 'Start date',
            type: 'date',
          },
          {
            universalId: '75723c10-0f19-4b03-b217-1cc4243dd5c3',
            name: 'endDate',
            label: 'End date',
            type: 'date',
          },
          {
            universalId: '7416e2a4-861d-43a0-8373-793489c4d0bb',
            name: 'company',
            label: 'Client',
            type: 'relation',
            settings: { targetObject: STARTER_OBJECT_IDS.company, inverseField: 'projects' },
          },
          {
            universalId: '0467b648-12ca-4fb5-88aa-b6b2bd15eeb0',
            name: 'primaryContact',
            label: 'Primary contact',
            description: "The client's main contact for the project.",
            type: 'relation',
            settings: { targetObject: STARTER_OBJECT_IDS.person, inverseField: 'projects' },
          },
        ],
      },
    },
    {
      op: 'create_object',
      object: {
        universalId: PROPOSAL,
        nameSingular: 'proposal',
        namePlural: 'proposals',
        labelSingular: 'Proposal',
        labelPlural: 'Proposals',
        description: 'An offer sent to a client.',
        labelField: 'name',
        fields: [
          {
            universalId: 'eb528f5c-f4f5-4999-b5e4-55367c283308',
            name: 'name',
            label: 'Name',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: '4d8e587b-4981-42b6-bfc7-c6662660e0c2',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'sent', label: 'Sent' },
                { value: 'accepted', label: 'Accepted' },
                { value: 'rejected', label: 'Rejected' },
              ],
            },
          },
          {
            universalId: '30fac3ec-0fd4-48ea-b0b4-8b04f71a8a0c',
            name: 'amount',
            label: 'Amount',
            type: 'money',
          },
          {
            universalId: '2a98281d-7650-4a22-8f56-e61bc4e2cdb5',
            name: 'sentDate',
            label: 'Sent date',
            type: 'date',
          },
          {
            universalId: '6fe351c5-2e34-4110-8d59-dd7ebaafb60a',
            name: 'company',
            label: 'Client',
            type: 'relation',
            settings: { targetObject: STARTER_OBJECT_IDS.company, inverseField: 'proposals' },
          },
          {
            universalId: '5543d8b0-3393-4e37-8aa0-5d85f009e9a8',
            name: 'project',
            label: 'Project',
            type: 'relation',
            settings: { targetObject: PROJECT, inverseField: 'proposals', rollUpEvents: true },
          },
        ],
      },
    },
  ],
};
