import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import {
  prepareSourceSchema,
  reserveSourceSchema,
  sourceBindingSchema,
  sourceEventSchema,
} from '../../sources/contract.js';
import type { Sources } from '../../sources/service.js';
import { run } from '../shared.js';

export function registerSourceTools(server: McpServer, sources: Sources, caller: Caller) {
  server.registerTool(
    'prepare_source_item',
    {
      description:
        'Stage the provider participant emails before uploading source bytes. Required once per item job attempt; makes unattached uploads discoverable by privacy erasure before the first event exists.',
      inputSchema: prepareSourceSchema.extend({ installationId: z.uuid(), sourceItemId: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ installationId, sourceItemId, ...input }) =>
      run(caller, 'write', () => sources.prepare(caller, installationId, sourceItemId, input)),
  );
  server.registerTool(
    'mark_source_unavailable',
    {
      description:
        "Record a transient provider miss, or a deletion supported by a verified provider event/definitive lookup. A transient 404 never deletes evidence. Applies the installation's reviewed keep/retract policy.",
      inputSchema: z.strictObject({
        installationId: z.uuid(),
        sourceItemId: z.uuid(),
        status: z.enum(['unavailable', 'deleted']),
        evidence: z.enum(['provider_event', 'definitive_lookup']).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ installationId, sourceItemId, ...input }) =>
      run(caller, 'write', () => sources.unavailable(caller, installationId, sourceItemId, input)),
  );
  server.registerTool(
    'verify_source_connection',
    {
      description:
        'Attest an explicitly shared provider connection. Only the release-pinned isolated setup verifier may call this; ordinary agents and user keys cannot select a source namespace.',
      inputSchema: sourceBindingSchema.extend({ installationId: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ installationId, ...input }) =>
      run(caller, 'write', () => sources.verify(caller, installationId, input)),
  );
  server.registerTool(
    'reserve_source_item',
    {
      description:
        "Reserve the stable local identity of a provider item before enqueueing its ingestion job or uploading files. Requires this installation's verified source account. Erased identities remain suppressed after reinstall.",
      inputSchema: reserveSourceSchema.extend({ installationId: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ installationId, ...input }) =>
      run(caller, 'write', () => sources.reserve(caller, installationId, input)),
  );
  server.registerTool(
    'get_source_item',
    {
      description:
        "Read the current revision and provider ID for this installation's source item. Fetch current provider state before retrying a revision conflict.",
      inputSchema: z.strictObject({ installationId: z.uuid(), sourceItemId: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ installationId, sourceItemId }) =>
      run(caller, 'read', () => sources.get(caller, installationId, sourceItemId)),
  );
  server.registerTool(
    'sync_source_event',
    {
      description:
        'Import immutable managed evidence using a stable event type UUID and permanent field keys. Requires the pinned ingestion job for this source item. Edits supersede prior evidence and retract its derived claims atomically; ordinary log_event remains create-only.',
      inputSchema: sourceEventSchema.extend({ installationId: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ installationId, ...input }) =>
      run(caller, 'write', () => sources.sync(caller, installationId, input)),
  );
}
