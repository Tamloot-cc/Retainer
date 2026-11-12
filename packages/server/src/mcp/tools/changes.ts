import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import { Changes } from '../../changes/service.js';
import type { Sql } from '../../db/client.js';
import { run } from '../shared.js';
export function registerChangeTools(server: McpServer, sql: Sql, caller: Caller) {
  const changes = new Changes(sql);
  server.registerTool(
    'get_change',
    {
      description:
        'Read one currently authorized minimal record change by its local position, normally from a change-trigger job. Deleted/expired change metadata cannot be used to recover erased content.',
      inputSchema: z.strictObject({ changePosition: z.string().regex(/^[1-9][0-9]{0,18}$/) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ changePosition }) => run(caller, 'read', () => changes.at(caller, changePosition)),
  );
  server.registerTool(
    'list_changes',
    {
      description:
        'Read commit-ordered workspace record changes as minimal IDs and permanent field keys. Persist nextCursor even on an empty page. A schema change (operation schema, recordId null) names an object type and the field keys a field or type deletion hid; rescan that type. Personal memory is excluded. For a current-record rescan, capture headCursor before scanning, then replay after that cursor. Expired cursors return 410. This is not delivery acknowledgement or exactly-once extraction.',
      inputSchema: z.strictObject({
        after: z.string().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'read', () => changes.list(caller, input)),
  );
}
