import { BASE_OBJECT_IDS } from './base.js';
import type { Template } from './types.js';

const JOB = 'cefe888f-9349-4493-8f38-3f92aeca03bd';
const APPLICATION = '46ac1b30-b6c5-403e-b7cb-a75166beb2a3';

export const recruiting: Template = {
  name: 'recruiting',
  extends: 'starter',
  version: 1,
  label: 'Recruiting',
  description:
    'Recruiters and hiring teams: open jobs and the applications that move through stages.',
  operations: [
    {
      op: 'create_object',
      object: {
        universalId: JOB,
        nameSingular: 'job',
        namePlural: 'jobs',
        labelSingular: 'Job',
        labelPlural: 'Jobs',
        description: 'An open position.',
        labelField: 'title',
        fields: [
          {
            universalId: '8ab7d404-426a-4b4a-aa05-3d51e82361da',
            name: 'title',
            label: 'Title',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: '8a3f1d87-4dd7-4542-988a-596e94368e1f',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'open', label: 'Open' },
                { value: 'on_hold', label: 'On hold' },
                { value: 'filled', label: 'Filled' },
                { value: 'closed', label: 'Closed' },
              ],
            },
          },
          {
            universalId: '9684eb84-0c75-4f01-a784-add01eebc4b0',
            name: 'company',
            label: 'Company',
            type: 'relation',
            settings: { targetObject: BASE_OBJECT_IDS.company, inverseField: 'jobs' },
          },
        ],
      },
    },
    {
      op: 'create_object',
      object: {
        universalId: APPLICATION,
        nameSingular: 'application',
        namePlural: 'applications',
        labelSingular: 'Application',
        labelPlural: 'Applications',
        description: "A candidate's application to a job.",
        labelField: 'title',
        fields: [
          {
            universalId: '28c0bab0-7a79-432f-8ed1-2fc364921347',
            name: 'title',
            label: 'Title',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: 'b794940e-4a1a-4b11-8d87-44b4f38b522d',
            name: 'person',
            label: 'Candidate',
            type: 'relation',
            settings: {
              targetObject: BASE_OBJECT_IDS.person,
              inverseField: 'applications',
              rollUpEvents: true,
            },
          },
          {
            universalId: 'a250a782-d640-4d51-b4a3-10b5385c93c7',
            name: 'job',
            label: 'Job',
            type: 'relation',
            settings: { targetObject: JOB, inverseField: 'applications', rollUpEvents: true },
          },
          {
            universalId: '4ec7bf6c-1368-4926-b92d-560b95752b8c',
            name: 'stage',
            label: 'Stage',
            type: 'select',
            settings: {
              options: [
                { value: 'applied', label: 'Applied' },
                { value: 'screening', label: 'Screening' },
                { value: 'interview', label: 'Interview' },
                { value: 'offer', label: 'Offer' },
                { value: 'hired', label: 'Hired' },
                { value: 'rejected', label: 'Rejected' },
              ],
            },
          },
          {
            universalId: '37d78185-971e-4d39-be05-2d14bb8ab6f9',
            name: 'source',
            label: 'Source',
            description: 'Where the candidate came from, e.g. a referral or a job board.',
            type: 'text',
          },
        ],
      },
    },
  ],
};
