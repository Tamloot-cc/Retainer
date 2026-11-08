import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import type { Sql } from '../../db/client.js';
import { describeSchema } from '../../schema-engine/service.js';
import { applyTemplateFor, templatesFor } from '../../templates/service.js';
import { GUIDE_NAMES, GUIDES } from '../guides.js';
import { run } from '../shared.js';

const applyTemplateInput = z.strictObject({
  name: z.string().min(1).describe('Template name from list_templates, e.g. "sales" or "blank".'),
});

const GUIDE_LIST = GUIDE_NAMES.map((name) => `"${name}": ${GUIDES[name].description}`).join(' ');

const getGuideInput = z.strictObject({
  name: z.enum(GUIDE_NAMES).describe('The guide to read, e.g. "discover_schema".'),
});

const noInput = z.strictObject({});

export function registerSetupTools(server: McpServer, sql: Sql, caller: Caller): void {
  server.registerTool(
    'describe_schema',
    {
      title: 'Describe the workspace schema',
      description:
        'Returns the workspace (id, name, applied templates, initialized, schemaVersion) and ' +
        'every object with its fields: type, options, and whether it is unique, filterable or ' +
        'required. valueFormats shows how to write a value of each field type they use, ' +
        'e.g. full_name as { first, last }. isProtected marks objects that cannot be deleted and fields that cannot be ' +
        'deleted or reshaped; protectedOptions lists option values that cannot be removed. ' +
        'Renames, labels and descriptions remain allowed under the usual approval rules. ' +
        'baseObject and baseField identify built-ins after renames: use their current API ' +
        "names in calls. coreRole identifies an event type's protected title and summary " +
        'fields. Objects of class "event" are event types (conversation, ...): ' +
        'log them with log_event, never create them with upsert_record. Every event has a ' +
        'channel (eventColumns): the source system or account, part of its identity. A ' +
        "conversation's medium field says what kind it was (meeting, call, email, message) " +
        'and can be corrected later. builtIns lists facts, written with remember, and ' +
        'comments, which only people write. Call it first, ' +
        'and again after a schema change. If initialized is false, ' +
        'the schema has not been set up yet: follow get_guide("discover_schema"), or see ' +
        'list_templates.',
      inputSchema: noInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => describeSchema(sql, caller)),
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'Lists the templates a workspace can apply (sales, services, clinic, real_estate, ' +
        'recruiting, blank), what objects and fields each adds, and which are applied. ' +
        'Pick the one closest to the business; if unsure, ask your user rather than guess. ' +
        'Check it before creating an object, even in an initialized workspace: a template ' +
        'may already define it.',
      inputSchema: noInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => templatesFor(sql, caller)),
  );

  server.registerTool(
    'apply_template',
    {
      title: 'Apply a template',
      description:
        "Adds a template's objects and fields to the workspace and marks it initialized. " +
        'Templates only add, so this applies at once. Applying one twice does nothing; ' +
        '"blank" adds nothing and only marks the workspace initialized. Needs the ' +
        'schema:write scope.',
      inputSchema: applyTemplateInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ name }) => run(caller, 'schema:write', () => applyTemplateFor(sql, caller, name)),
  );

  server.registerTool(
    'get_guide',
    {
      title: 'Read a guide',
      description:
        `Returns step-by-step instructions, as markdown, for a task you do rarely. ${GUIDE_LIST} ` +
        'Read "discover_schema" when describe_schema says initialized: false, or when your ' +
        'user asks you to set up or redesign the workspace.',
      inputSchema: getGuideInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) => run(caller, 'read', async () => GUIDES[name].text),
  );

  for (const name of GUIDE_NAMES) {
    const guide = GUIDES[name];
    const args = 'promptArgs' in guide ? { argsSchema: guide.promptArgs } : {};
    server.registerPrompt(
      name,
      { title: guide.title, description: guide.description, ...args },
      ({ sources }: { sources?: string }) => ({
        description: guide.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `${guide.promptIntro} Follow this guide.\n\n${guide.text}` +
                (sources ? `\n\nStart with these sources: ${sources}` : ''),
            },
          },
        ],
      }),
    );
  }
}
