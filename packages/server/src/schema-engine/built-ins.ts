import type { BuiltInView, ProfileAlias } from '@retainer/shared';

/**
 * Facts, comments and workspace and personal memory, as describe_schema lists them beside the workspace's objects (1.3).
 * They are part of every workspace and fixed by Retainer: listed separately
 * from `objects` so no client mistakes them for something upsert_record can
 * write. Events are ordinary objects of class `event` (6.1).
 */
export const BUILT_INS: BuiltInView[] = [
  {
    name: 'fact',
    labelSingular: 'Fact',
    labelPlural: 'Facts',
    description:
      'A plain-language claim about one record that does not fit a field, such as "Legal ' +
      'review at Acme usually takes two weeks", with the event it came from.',
    fields: [
      { name: 'record', type: 'relation', description: 'The record the fact is about' },
      { name: 'content', type: 'text', description: 'The fact, in plain language' },
      { name: 'validFrom', type: 'date_time', description: 'When it became true at the source' },
      { name: 'sources', type: 'events', description: 'The events it rests on' },
    ],
    writeWith: ['remember', 'POST /v1/records/:id/facts'],
    readWith: ['get_context', 'search', 'GET /v1/records/:id/facts'],
  },
  {
    name: 'comment',
    labelSingular: 'Comment',
    labelPlural: 'Comments',
    description:
      'A remark a person wrote on a record for the team, such as "don\'t contact him before ' +
      'January". Context for deciding what to do, never a source to cite. Only people write them.',
    fields: [
      { name: 'record', type: 'relation', description: 'The record it is on' },
      { name: 'body', type: 'text', description: 'Plain text, line breaks kept' },
      { name: 'author', type: 'actor', description: 'The person who wrote it' },
      { name: 'createdAt', type: 'date_time', description: 'When it was written' },
      { name: 'editedAt', type: 'date_time', description: 'When its body last changed, if it did' },
    ],
    writeWith: ['POST /v1/records/:id/comments'],
    readWith: ['get_record', 'list_comments', 'GET /v1/records/:id/comments'],
  },
];

/**
 * Workspace and personal memory (personal memory spec 4.4): facts that are
 * not about a CRM record, named `workspace` and `me` instead of a record ID.
 * `profiles` says which this credential has.
 */
export function memoryBuiltIn(profiles: ProfileAlias[]): BuiltInView {
  return {
    name: 'memory',
    labelSingular: 'Memory',
    labelPlural: 'Memories',
    description:
      'Facts that are not about a CRM record. "workspace" holds what the business is and how ' +
      'it works, shared by everyone in the workspace. "me" holds what you learn about the ' +
      'person you work for (preferences, style, goals), private to them and their agents. ' +
      'Pass either instead of a record ID; read both at the start of a session.',
    fields: [
      { name: 'content', type: 'text', description: 'The fact, in plain language' },
      { name: 'writtenBy', type: 'actor', description: 'Who wrote it' },
      { name: 'sources', type: 'events', description: 'The events it rests on' },
    ],
    profiles,
    writeWith: ['remember', 'POST /v1/records/:id/facts'],
    readWith: ['get_context', 'get_timeline', 'search', 'GET /v1/records/:id/facts'],
  };
}
