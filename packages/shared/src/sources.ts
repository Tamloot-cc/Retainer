/** Managed imports use stable event type UUIDs and permanent field keys. */
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
  sourceItemId: string;
  sourceAccountId: string;
  externalId: string;
  state: string;
  providerRevision: string | null;
  revisionId: string | null;
  eventId: string | null;
  contentDigest: string | null;
};
