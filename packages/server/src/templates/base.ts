import {
  BASE_EVENT_FIELD_IDS,
  BASE_EVENT_TYPE_IDS,
  BASE_FIELD_IDS,
  BASE_OBJECT_IDS,
  INTERNAL_NOTE_TYPE_ID,
  MEMBER_PROFILE_TYPE_ID,
  WORKSPACE_PROFILE_TYPE_ID,
} from '@retainer/shared';
import type { SchemaOperation } from '../schema-engine/operations.js';

/**
 * The three objects every workspace starts with (ARCHITECTURE.md 3.1).
 * Universal IDs are fixed forever: upgrades and templates find these
 * objects and fields by them in every workspace.
 */
export { BASE_EVENT_TYPE_IDS, BASE_FIELD_IDS, BASE_OBJECT_IDS, INTERNAL_NOTE_TYPE_ID };

/**
 * The event type every workspace starts with (C5). Meetings, calls, emails
 * and chats are all conversations: `medium` says which, and stays editable
 * after logging. Every other event type comes from a template or an agent: one
 * for events whose fields a conversation would never use, such as a payment
 * or a form submission. `note` keeps its universal ID, but is not seeded. The
 * schema engine adds its core title and summary fields (6.1). It is not
 * protected: a workspace can delete it if it does not use it.
 */
export const BASE_EVENT_OPERATIONS: SchemaOperation[] = [
  {
    op: 'create_object',
    object: {
      universalId: BASE_EVENT_TYPE_IDS.conversation,
      class: 'event',
      nameSingular: 'conversation',
      namePlural: 'conversations',
      labelSingular: 'Conversation',
      labelPlural: 'Conversations',
      description: 'A meeting, call, email thread or chat between people.',
      fields: [
        {
          universalId: BASE_EVENT_FIELD_IDS.conversationMedium,
          name: 'medium',
          label: 'Medium',
          description:
            'What kind of conversation it was. Leave it empty when unsure; it can be corrected ' +
            'later. Where it came from (gmail, zoom) is the channel, not the medium.',
          type: 'select',
          isFilterable: true,
          settings: {
            options: [
              { value: 'meeting', label: 'Meeting' },
              { value: 'call', label: 'Call' },
              { value: 'email', label: 'Email' },
              { value: 'message', label: 'Message' },
            ],
          },
        },
      ],
    },
  },
];

/**
 * The hidden, protected types (6.4, personal memory spec 4.1): the event
 * type of the notes `remember` creates for facts with no source, and the
 * two profile types. No client operation names them and nothing lists them.
 */
export const INTERNAL_OPERATIONS: SchemaOperation[] = [
  {
    op: 'create_object',
    object: {
      universalId: INTERNAL_NOTE_TYPE_ID,
      class: 'event',
      nameSingular: 'internalNote',
      namePlural: 'internalNotes',
      labelSingular: 'Internal note',
      labelPlural: 'Internal notes',
      description: 'A note remember created for a fact that cites no source.',
      fields: [],
    },
  },
  // Workspace memory and personal memory (personal memory spec 4.1): hidden,
  // protected entities that hold facts only. Agents name their records
  // `workspace` and `me`, never by ID or type name.
  {
    op: 'create_object',
    object: {
      universalId: WORKSPACE_PROFILE_TYPE_ID,
      nameSingular: 'workspaceProfile',
      namePlural: 'workspaceProfiles',
      labelSingular: 'Workspace memory',
      labelPlural: 'Workspace memories',
      description: 'What the business is and how it works, shared by the whole workspace.',
      fields: [],
    },
  },
  {
    op: 'create_object',
    object: {
      universalId: MEMBER_PROFILE_TYPE_ID,
      nameSingular: 'memberProfile',
      namePlural: 'memberProfiles',
      labelSingular: 'Personal memory',
      labelPlural: 'Personal memories',
      description: 'What agents learn about the person they work for, private to that person.',
      fields: [],
    },
  },
];

export const BASE_OPERATIONS: SchemaOperation[] = [
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.company,
      nameSingular: 'company',
      namePlural: 'companies',
      labelSingular: 'Company',
      labelPlural: 'Companies',
      description: 'An organization: a customer, prospect, partner or supplier.',
      labelField: 'name',
      fields: [
        {
          universalId: 'ba596fe8-a75f-4a88-9d80-ca22d51d7c72',
          name: 'name',
          label: 'Name',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641',
          name: 'domain',
          label: 'Domain',
          description: "The company's website. Its domain helps match people to the company.",
          type: 'links',
          isSearchable: true,
        },
        {
          universalId: '4154cec6-8f15-4996-8502-61fd53699980',
          name: 'address',
          label: 'Address',
          type: 'address',
        },
      ],
    },
  },
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.person,
      nameSingular: 'person',
      namePlural: 'people',
      labelSingular: 'Person',
      labelPlural: 'People',
      description: 'A person the business works with.',
      labelField: 'name',
      fields: [
        {
          universalId: '5c672ecf-9048-42c2-9213-0a6078980071',
          name: 'name',
          label: 'Name',
          type: 'full_name',
          isSearchable: true,
        },
        {
          universalId: '6eb2edf7-5e1d-48d8-9d61-a701d6c2a37d',
          name: 'emails',
          label: 'Emails',
          description: 'Unique: an email identifies exactly one person.',
          type: 'emails',
          isUnique: true,
          isSearchable: true,
        },
        {
          universalId: 'f285544b-087c-40bc-95df-1e201708794c',
          name: 'phones',
          label: 'Phones',
          description: 'Not unique: numbers are shared and reassigned.',
          type: 'phones',
          isSearchable: true,
        },
        {
          universalId: 'aaea856d-d526-49c7-93b1-4cff91c3862a',
          name: 'address',
          label: 'Address',
          type: 'address',
        },
        {
          universalId: 'bd5ac6d4-9054-462f-8c28-ba9536aa2618',
          name: 'jobTitle',
          label: 'Job title',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: '42465fa9-9116-480f-b8e4-7905d40d245f',
          name: 'company',
          label: 'Company',
          description: 'Where the person works.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.company, inverseField: 'people' },
        },
      ],
    },
  },
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.task,
      nameSingular: 'task',
      namePlural: 'tasks',
      labelSingular: 'Task',
      labelPlural: 'Tasks',
      description: 'Something someone committed to do.',
      labelField: 'title',
      fields: [
        {
          universalId: '5f37aa96-fac8-4572-9647-6b0da5d6d0c8',
          name: 'title',
          label: 'Title',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: BASE_FIELD_IDS.taskStatus,
          name: 'status',
          label: 'Status',
          type: 'select',
          settings: {
            options: [
              { value: 'todo', label: 'To do' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'done', label: 'Done' },
            ],
          },
        },
        {
          universalId: BASE_FIELD_IDS.taskDueDate,
          name: 'dueDate',
          label: 'Due date',
          type: 'date',
        },
        {
          universalId: 'b13c51c0-5902-47f2-9e5f-5582f9f311d1',
          name: 'assignee',
          label: 'Assignee',
          description: 'Who on the team owns the task.',
          type: 'text',
        },
        {
          universalId: '3d66fcfe-2e9c-4aeb-a88a-7d6b3c2194ba',
          name: 'person',
          label: 'Person',
          description: 'The person the task is about.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.person, inverseField: 'tasks' },
        },
        {
          universalId: 'f6b83a8c-c809-4af4-b03a-f4753e10df32',
          name: 'company',
          label: 'Company',
          description: 'The company the task is about.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.company, inverseField: 'tasks' },
        },
      ],
    },
  },
];

/** Everything a new workspace is seeded with, and what upgrades bring older ones to (3). */
export const SEED_OPERATIONS: SchemaOperation[] = [
  ...BASE_OPERATIONS,
  ...BASE_EVENT_OPERATIONS,
  ...INTERNAL_OPERATIONS,
];
