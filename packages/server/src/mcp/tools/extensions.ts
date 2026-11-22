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
    'list_extension_connections',
    {
      description:
        'Read member extension connections and their health. Returns only connections this credential may inspect; no secrets. People connect their accounts through the web app.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => extensions.connections.list(caller, id)),
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
        connection: z.uuid().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id, limit, cursor, connection }) =>
      run(caller, 'read', () => extensions.runs(caller, id, limit, cursor, connection)),
  );
  server.registerTool(
    'preview_extension',
    {
      description:
        'Preview a bundled extension and propose its binding choices for an admin to review. ' +
        'Use bindings with an existing object from describe_schema, create from the release suggestion, ' +
        'or skip an optional binding. Provide field and select value choices when needed. ' +
        'A human admin approves any change to schema or installation.',
      inputSchema: installInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (input) => run(caller, 'schema:write', () => extensions.preview(caller, input, true)),
  );
}
