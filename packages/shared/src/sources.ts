import { z } from 'zod';
import { isoDateTimeSchema } from './values.js';

/** Fixed enumeration bounds; provider cursors and contact data never belong here. */
export const sourceScanSchema = z
  .strictObject({
    scanId: z.uuid(),
    mode: z.enum(['created', 'updated']),
    from: isoDateTimeSchema,
    through: isoDateTimeSchema,
  })
  .refine((v) => Date.parse(v.from) <= Date.parse(v.through), { message: 'invalid scan bounds' });
export type SourceScan = z.infer<typeof sourceScanSchema>;
export type SourceSyncStatus = {
  lastSuccessfulScanAt: string | null;
  activeScan: (SourceScan & { generation: number; startedAt: string }) | null;
  pendingItems: number;
  failedItems: number;
};

/** Managed imports use stable event type/field UUIDs; permanent field keys remain accepted aliases. */
export type SourceEventImport = {
  sourceItemId: string;
  providerRevision?: string;
  expectedRevisionId: string | null;
  contentDigest?: string;
  event: {
    type: string;
    occurredAt: string;
    title: string;
    summary?: string;
    fields?: Record<string, unknown>;
    participants?: { email: string; name?: string; contacted?: boolean }[];
    about?: string[];
  };
};
export type SourceEventResult = {
  sourceItemId: string;
  revisionId: string;
  eventId: string;
  created: boolean;
  unchanged: boolean;
  stale?: boolean;
  previousEventId?: string;
  contentDigest: string;
  invalidated: {
    retractedAssertions: number;
    recomputedRecordIds: string[];
    hiddenFactIds: string[];
  };
};
export type SourceItemView = {
  taskWriteRevision: number;
  sourceItemId: string;
  sourceAccountId: string;
  externalId: string;
  state: string;
  providerRevision: string | null;
  revisionId: string | null;
  eventId: string | null;
  contentDigest: string | null;
};
