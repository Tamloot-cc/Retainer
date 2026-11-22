import { BASE_OBJECT_IDS } from './base.js';
import type { Template } from './types.js';

const PROPERTY = 'a367961a-005c-49e8-80ef-596d622edd63';
const VIEWING = 'dc61b186-fb5d-40fd-9d50-941668198e60';

export const realEstate: Template = {
  name: 'real_estate',
  extends: 'starter',
  version: 2,
  label: 'Real estate',
  description:
    'Real-estate agents and brokers: properties for sale or rent, their owners, and viewings ' +
    'with buyers or tenants.',
  operations: [
    {
      op: 'create_object',
      object: {
        universalId: PROPERTY,
        nameSingular: 'property',
        namePlural: 'properties',
        labelSingular: 'Property',
        labelPlural: 'Properties',
        description: 'A property for sale or rent.',
        labelField: 'name',
        fields: [
          {
            universalId: 'ff29647d-733d-4bfd-88aa-83276f898aff',
            name: 'name',
            label: 'Name',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: '34fef2d4-0916-427c-8d04-17686e42e00f',
            name: 'address',
            label: 'Address',
            type: 'address',
          },
          {
            universalId: '864fb0f1-2dd9-4dba-a2d3-cabbca46ae3a',
            name: 'type',
            label: 'Type',
            type: 'select',
            settings: {
              options: [
                { value: 'apartment', label: 'Apartment' },
                { value: 'house', label: 'House' },
                { value: 'commercial', label: 'Commercial' },
                { value: 'land', label: 'Land' },
                { value: 'other', label: 'Other' },
              ],
            },
          },
          {
            universalId: 'c4012b67-6da0-4e6a-975c-c1f1383555c5',
            name: 'price',
            label: 'Price',
            type: 'money',
          },
          {
            universalId: '947fb35c-7a9d-4d6c-a28d-3b87869b4dac',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'available', label: 'Available' },
                { value: 'under_offer', label: 'Under offer' },
                { value: 'sold', label: 'Sold' },
                { value: 'rented', label: 'Rented' },
                { value: 'off_market', label: 'Off market' },
              ],
            },
          },
          {
            universalId: 'f0987999-8338-4825-bf88-734a1c387175',
            name: 'owner',
            label: 'Owner',
            description: 'The person selling or letting the property.',
            type: 'relation',
            settings: { targetObject: BASE_OBJECT_IDS.person, inverseField: 'properties' },
          },
        ],
      },
    },
    {
      op: 'create_object',
      object: {
        universalId: VIEWING,
        nameSingular: 'viewing',
        namePlural: 'viewings',
        labelSingular: 'Viewing',
        labelPlural: 'Viewings',
        description: 'A visit to a property with a prospective buyer or tenant.',
        labelField: 'title',
        fields: [
          {
            universalId: '98c8bb77-84e9-4ea9-b406-d0806a0b939b',
            name: 'title',
            label: 'Title',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: '3196809a-7791-479a-b36e-751bf6193a7f',
            name: 'date',
            label: 'Date',
            type: 'date_time',
          },
          {
            universalId: '67487f99-bf63-460d-aff4-255c0b23ed7c',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'completed', label: 'Completed' },
                { value: 'cancelled', label: 'Cancelled' },
                { value: 'no_show', label: 'No-show' },
              ],
            },
          },
          {
            universalId: '705b958f-6035-4f10-98f1-5674db0ffb30',
            name: 'property',
            label: 'Property',
            type: 'relation',
            settings: { targetObject: PROPERTY, inverseField: 'viewings', rollUpEvents: true },
          },
          {
            universalId: '3bf3dccd-d40c-4080-ad43-9c33dd75089f',
            name: 'person',
            label: 'Visitor',
            type: 'relation',
            settings: {
              targetObject: BASE_OBJECT_IDS.person,
              inverseField: 'viewings',
              rollUpEvents: true,
            },
          },
          {
            universalId: 'bd095ab1-c943-4dc2-a398-c10dcfa0a4a1',
            name: 'feedback',
            label: 'Feedback',
            type: 'text',
            isSearchable: true,
          },
        ],
      },
    },
  ],
};
