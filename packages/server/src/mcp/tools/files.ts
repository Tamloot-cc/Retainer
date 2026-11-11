import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import { type Files, fileMetadataSchema } from '../../files/service.js';
import { run } from '../shared.js';
export function registerFileTools(server: McpServer, files: Files, caller: Caller) {
  server.registerTool(
    'create_file_upload',
    {
      description:
        'Reserve an immutable file upload (up to 25 MiB) against workspace quota. Upload bytes to the returned signed URL with its headers, then call finalize_file. Never send bytes in tool JSON.',
      inputSchema: fileMetadataSchema.extend({ idempotencyKey: z.string().min(1).max(200) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...metadata }) =>
      run(caller, 'write', () => files.intent(caller, metadata, idempotencyKey)),
  );
  server.registerTool(
    'finalize_file',
    {
      description:
        'Verify uploaded length, SHA-256, media type and ownership. Only a ready file ID can enter a files field or source import.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) => run(caller, 'write', () => files.finalize(caller, id)),
  );
  server.registerTool(
    'get_file',
    {
      description:
        'Read display metadata for a file attached to a currently visible record. Does not return bytes or a public URL.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => files.get(caller, id)),
  );
  server.registerTool(
    'download_file',
    {
      description:
        'Issue an attachment download URL valid for at most 60 seconds, after checking current record visibility. Treat the URL as a temporary bearer capability.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => files.download(caller, id)),
  );
}
