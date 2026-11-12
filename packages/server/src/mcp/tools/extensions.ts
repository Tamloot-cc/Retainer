import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import { type Extensions, installInputSchema } from '../../extensions/service.js';
import { run } from '../shared.js';

export function registerExtensionTools(server: McpServer, extensions: Extensions, caller: Caller) {
  server.registerTool(
    'list_extensions',
    {
      description:
        'List workspace extension installations, current lifecycle state, connection health and approved grants.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => extensions.list(caller)),
  );
  server.registerTool(
    'get_extension',
    {
      description:
        'Read an installed extension, grants and schema/view contributions. No secrets are returned.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => extensions.get(caller, id)),
  );
  server.registerTool(
    'list_extension_runs',
    {
      description:
        'List paginated extension run status and safe error codes. Provider payloads, tokens and inputs are omitted.',
      inputSchema: z.strictObject({
        id: z.uuid(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id, limit, cursor }) =>
      run(caller, 'read', () => extensions.runs(caller, id, limit, cursor)),
  );
  server.registerTool(
    'preview_extension',
    {
      description:
        'Preview a bundled extension installation without changes. Human admin approval is required through the admin API. Does not enable triggers. ' +
        'For a release with a mapping (its outputs are in the extension catalog), pass mapping with one choice per output key: ' +
        '{"action":"existing","field":"<API name from describe_schema>"}, {"action":"create"} for its suggested field, or {"action":"skip"}. ' +
        'Use this to check a mapping draft you propose; the admin imports, edits and approves it.',
      inputSchema: installInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'schema:write', () => extensions.preview(caller, input)),
  );
}
