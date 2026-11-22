import { BASE_OBJECT_IDS } from './base.js';
import type { Template } from './types.js';

const APPOINTMENT = '9f1ffdb1-bdf6-46eb-af1e-1409586d26ee';

export const clinic: Template = {
  name: 'clinic',
  extends: 'starter',
  version: 1,
  label: 'Clinic',
  description:
    'Clinics, therapists and wellness practices: appointments with patients or clients, each ' +
    'with a status.',
  operations: [
    {
      op: 'create_object',
      object: {
        universalId: APPOINTMENT,
        nameSingular: 'appointment',
        namePlural: 'appointments',
        labelSingular: 'Appointment',
        labelPlural: 'Appointments',
        description: 'A scheduled visit or session.',
        labelField: 'title',
        fields: [
          {
            universalId: '3f245e38-3f19-4c4c-a298-9f24b7b9f28d',
            name: 'title',
            label: 'Title',
            type: 'text',
            isSearchable: true,
          },
          {
            universalId: 'ecce0ffe-5ec6-447f-9343-2be697c8435a',
            name: 'startsAt',
            label: 'Date and time',
            type: 'date_time',
          },
          {
            universalId: '440c9b78-b8d4-4cd4-b339-f324d859510b',
            name: 'type',
            label: 'Type',
            type: 'select',
            settings: {
              options: [
                { value: 'consultation', label: 'Consultation' },
                { value: 'follow_up', label: 'Follow-up' },
                { value: 'treatment', label: 'Treatment' },
                { value: 'other', label: 'Other' },
              ],
            },
          },
          {
            universalId: '5d6607df-408a-457c-8654-be982e4618a6',
            name: 'status',
            label: 'Status',
            type: 'select',
            settings: {
              options: [
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'confirmed', label: 'Confirmed' },
                { value: 'completed', label: 'Completed' },
                { value: 'cancelled', label: 'Cancelled' },
                { value: 'no_show', label: 'No-show' },
              ],
            },
          },
          {
            universalId: '55192539-f132-45f3-ad32-744e696b5f97',
            name: 'person',
            label: 'Patient',
            type: 'relation',
            settings: {
              targetObject: BASE_OBJECT_IDS.person,
              inverseField: 'appointments',
              rollUpEvents: true,
            },
          },
        ],
      },
    },
    {
      op: 'create_field',
      object: BASE_OBJECT_IDS.person,
      field: {
        universalId: '1cf4ff48-f7c1-4f44-8eb3-49319b05c3f3',
        name: 'dateOfBirth',
        label: 'Date of birth',
        type: 'date',
      },
    },
    {
      op: 'create_field',
      object: BASE_OBJECT_IDS.person,
      field: {
        universalId: '9cb83cb0-7eed-4f61-b3a0-789322543ca4',
        name: 'preferredChannel',
        label: 'Preferred channel',
        type: 'select',
        settings: {
          options: [
            { value: 'email', label: 'Email' },
            { value: 'phone', label: 'Phone' },
            { value: 'sms', label: 'SMS' },
            { value: 'whatsapp', label: 'WhatsApp' },
          ],
        },
      },
    },
  ],
};
