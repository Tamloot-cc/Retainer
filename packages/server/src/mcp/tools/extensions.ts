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
        'List workspace extension installations and their disabled state. Runtime activation is not available yet.',
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
    'preview_extension',
    {
      description:
        'Preview a bundled extension installation without changes. Human admin approval is required through the admin API. Does not enable triggers.',
      inputSchema: installInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'schema:write', () => extensions.preview(caller, input)),
  );
}
