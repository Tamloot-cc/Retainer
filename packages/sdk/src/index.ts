import type {
  ExtensionAuthorization,
  ExtensionAuthorizationCompletion,
  ExtensionAuthorizeInput,
  ExtensionConnection,
  ExtensionConnectionInput,
  ExtensionInstallation,
  ExtensionInstallInput,
  ExtensionManifest,
  ExtensionOAuthClient,
  ExtensionPreview,
} from '@retainer/extension';
import { isMaintenance, maintenanceFetch } from './maintenance.js';

export { isMaintenance, retryAfterMs, waitForRetry } from './maintenance.js';

import type {
  AddedLinks,
  AggregateInput,
  AggregateResult,
  AssertionView,
  AttachedEventPage,
  BulkDeleteImpact,
  CommentPage,
  ContextInput,
  ContextPack,
  CreateViewInput,
  DecisionResult,
  DeleteImpact,
  DeleteRecordResult,
  EventAttachment,
  EventPage,
  EventQueryInput,
  FactPlace,
  ForgetResult,
  LogEventInput,
  LogEventResult,
  MergeInput,
  MergeResult,
  MergeSuggestionDecision,
  MoveEventsInput,
  MoveEventsResult,
  Page,
  PresentedComment,
  PresentedFact,
  PresentedRecord,
  ProfileAlias,
  ProfileContextPack,
  QueryInput,
  RecordPage,
  RetractEventResult,
  ReviewCollection,
  ReviewQueue,
  RoutineButton,
  RoutineCapabilities,
  RoutineCheckResult,
  RoutineDetail,
  RoutinePreview,
  RoutineProblem,
  RoutineReport,
  RoutineRunView,
  RoutineView,
  SavedView,
  SchemaChange,
  SchemaChangeResult,
  SchemaDescription,
  SchemaOperation,
  SearchInput,
  SearchResult,
  Session,
  TemplateView,
  TimelineItemKind,
  TimelinePage,
  UpdateViewInput,
  WorkspaceFeedInput,
  WorkspaceFeedPage,
  WriteResponse,
} from '@retainer/shared';
export type RetainerClientOptions = {
  baseUrl: string;
  /** Bearer credential: workspace/installation key or a REST installation OAuth access token. */
  apiKey?: string;
  credentials?: 'omit' | 'same-origin' | 'include';
  /**
   * The workspace ID a signed-in person's cookie requests go to. A person
   * can reach several workspaces with one session; an API key belongs to
   * one, so key requests ignore this.
   */
  workspace?: string;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
};
export type HealthResponse = {
  status: 'ok' | 'error';
  version: string;
  database: 'ok' | 'unreachable';
};
export class RetainerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RetainerApiError';
  }
}
export type PageOptions = { limit?: number; cursor?: string; signal?: AbortSignal };
export type PatchInput = {
  values: Record<string, unknown>;
  expectedUpdatedAt?: string;
  source?: string;
};
export type UpsertInput = PatchInput & {
  id?: string;
  match?: Record<string, unknown>;
  ifMissing?: 'fail' | 'create';
};
export type { LogEventInput, MoveEventsInput, MoveEventsResult };

type Participant = { handle?: string; recordId?: string; role?: string };
const isFailedChange = (body: unknown) =>
  typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'failed';
export class RetainerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: RetainerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (input, init) => maintenanceFetch(fetcher, input, init);
  }
  protected headers(): Record<string, string> {
    if (this.options.apiKey) return { authorization: `Bearer ${this.options.apiKey}` };
    return this.options.workspace
      ? { 'X-Retainer-Client': 'web', 'X-Retainer-Workspace': this.options.workspace }
      : { 'X-Retainer-Client': 'web' };
  }
  /** `isResult` lets an error status whose body is a result come back as one. */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    isResult?: (body: unknown) => boolean,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      credentials: this.options.credentials ?? 'same-origin',
      headers: {
        ...this.headers(),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (!response.ok && !isResult?.(body)) {
      if (response.status === 401 && path !== '/auth/session') this.options.onUnauthorized?.();
      throw new RetainerApiError(
        response.status,
        body.error?.code ?? 'request_failed',
        body.error?.message ?? response.statusText,
        body.error?.details,
      );
    }
    return body as T;
  }
  private query(path: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return { path: `${path}${qs.size ? `?${qs}` : ''}`, signal };
  }
  private get<T>(path: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    const q = this.query(path, params, signal);
    return this.request<T>(q.path, { signal });
  }
  private send<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ) {
    return this.request<T>(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    });
  }
  private post<T>(path: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string) {
    return this.send<T>('POST', path, body, signal, idempotencyKey);
  }
  /** Health reports database outages in its response body, including HTTP 503. */
  async health(): Promise<HealthResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    if (await isMaintenance(response)) {
      throw new RetainerApiError(503, 'maintenance', 'Retainer is updating. Please retry shortly.');
    }
    return (await response.json()) as HealthResponse;
  }
  signIn(key: string) {
    return this.post<Session>('/auth/session', { key });
  }
  signOut() {
    return this.request<{ signedOut: true }>('/auth/session', { method: 'DELETE' });
  }
  me(signal?: AbortSignal) {
    return this.get<Session>('/v1/me', {}, signal);
  }
  schema(signal?: AbortSignal) {
    return this.get<SchemaDescription>('/v1/schema', {}, signal);
  }
  templates(signal?: AbortSignal) {
    return this.get<{ templates: TemplateView[] }>('/v1/templates', {}, signal);
  }
  applyTemplate(name: string) {
    return this.post<SchemaChangeResult>(`/v1/templates/${encodeURIComponent(name)}/apply`);
  }
  queryRecords(object: string, input: QueryInput = {}, signal?: AbortSignal) {
    return this.post<RecordPage>(`/v1/objects/${encodeURIComponent(object)}/query`, input, signal);
  }
  record(
    id: string,
    include: string[] = ['provenance', 'relationReferences'],
    signal?: AbortSignal,
  ) {
    return this.get<PresentedRecord>(
      `/v1/records/${encodeURIComponent(id)}`,
      { include: include.join(',') },
      signal,
    );
  }
  createRecord(
    object: string,
    input: { values: Record<string, unknown>; source?: string },
    idempotencyKey?: string,
  ) {
    return this.post<WriteResponse>(
      `/v1/objects/${encodeURIComponent(object)}/records`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  upsertRecord(object: string, input: UpsertInput) {
    return this.post<WriteResponse>(`/v1/objects/${encodeURIComponent(object)}/upsert`, input);
  }
  patchRecord(id: string, input: PatchInput) {
    return this.request<WriteResponse>(`/v1/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }
  /** What deleting the record would delete with it; changes nothing. */
  deleteImpact(id: string, signal?: AbortSignal) {
    return this.get<DeleteImpact>(
      `/v1/records/${encodeURIComponent(id)}/delete-impact`,
      {},
      signal,
    );
  }
  /** What deleting several records together would delete with them. */
  bulkDeleteImpact(ids: string[], signal?: AbortSignal) {
    return this.post<BulkDeleteImpact>('/v1/records/delete-impact', { ids }, signal);
  }
  /** The total and requested aggregates over the records a filter matches. */
  aggregate(object: string, input: AggregateInput = {}, signal?: AbortSignal) {
    return this.post<AggregateResult>(
      `/v1/objects/${encodeURIComponent(object)}/aggregate`,
      input,
      signal,
    );
  }
  deleteRecord(id: string) {
    return this.request<DeleteRecordResult>(`/v1/records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  /** The object's saved views the caller can see, in their saved order. */
  views(object: string, signal?: AbortSignal) {
    return this.get<{ views: SavedView[] }>(
      `/v1/objects/${encodeURIComponent(object)}/views`,
      {},
      signal,
    );
  }
  view(id: string, signal?: AbortSignal) {
    return this.get<SavedView>(`/v1/views/${encodeURIComponent(id)}`, {}, signal);
  }
  createView(object: string, input: CreateViewInput) {
    return this.post<SavedView>(`/v1/objects/${encodeURIComponent(object)}/views`, input);
  }
  /** Changes only the keys given; `null` clears a setting. */
  updateView(id: string, input: UpdateViewInput) {
    return this.request<SavedView>(`/v1/views/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }
  deleteView(id: string) {
    return this.request<{ id: string; deleted: true }>(`/v1/views/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  /** Merges `input.recordId` into `id`, which survives. Retrying with the same key is safe. */
  mergeRecords(id: string, input: MergeInput, idempotencyKey?: string) {
    return this.post<MergeResult>(
      `/v1/records/${encodeURIComponent(id)}/merge`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  /**
   * Deletes the signed-in person's personal memory in this workspace (4.6):
   * web sessions only; agents cannot clear it.
   */
  clearMyMemory() {
    return this.post<{ cleared: true; counts: Record<string, number> }>('/v1/records/me/forget');
  }
  /** Erases a person and what was logged about them (needs the `admin` scope). Not reversible. */
  forget(id: string) {
    return this.post<ForgetResult>(`/v1/records/${encodeURIComponent(id)}/forget`);
  }
  search(input: SearchInput, signal?: AbortSignal) {
    return this.post<SearchResult>('/v1/search', input, signal);
  }
  context(
    id: ProfileAlias,
    input?: ContextInput,
    signal?: AbortSignal,
  ): Promise<ProfileContextPack>;
  context(id: string, input?: ContextInput, signal?: AbortSignal): Promise<ContextPack>;
  context(id: string, input: ContextInput = {}, signal?: AbortSignal) {
    return this.get<ContextPack | ProfileContextPack>(
      `/v1/records/${encodeURIComponent(id)}/context`,
      input,
      signal,
    );
  }
  dismissMergeSuggestion(id: string) {
    return this.post<MergeSuggestionDecision>(
      `/v1/review/merges/${encodeURIComponent(id)}/dismiss`,
    );
  }
  review(
    options: Omit<PageOptions, 'cursor'> &
      Partial<Record<`${ReviewCollection}Cursor`, string>> = {},
  ) {
    const { signal, ...params } = options;
    return this.get<ReviewQueue>('/v1/review', params, signal);
  }
  assertion(id: string, signal?: AbortSignal) {
    return this.get<AssertionView>(`/v1/assertions/${encodeURIComponent(id)}`, {}, signal);
  }
  decideAssertion(id: string, decision: 'accept' | 'reject') {
    return this.post<DecisionResult>(`/v1/assertions/${encodeURIComponent(id)}/${decision}`);
  }
  assertions(id: string, options: PageOptions & { field?: string } = {}) {
    const { signal, ...params } = options;
    return this.get<Page<AssertionView>>(
      `/v1/records/${encodeURIComponent(id)}/assertions`,
      params,
      signal,
    );
  }
  /**
   * Events attached directly to a record, newest first, each with how it is
   * attached (`via`). `link` narrows to participant, about or field.
   */
  recordEvents(id: string, options: PageOptions & { link?: EventAttachment } = {}) {
    const { signal, ...params } = options;
    return this.get<AttachedEventPage>(
      `/v1/records/${encodeURIComponent(id)}/events`,
      params,
      signal,
    );
  }
  /**
   * A record's timeline (8): events (direct and rolled up, with `via`),
   * values asserted for its fields and its facts, newest first. Filters for
   * one kind (`fields`, `eventTypes`) leave the others out unless `types`
   * names them.
   */
  timeline(
    id: string,
    options: PageOptions & {
      types?: TimelineItemKind[];
      fields?: string[];
      eventTypes?: string[];
      from?: string;
      to?: string;
    } = {},
  ) {
    const { signal, types, fields, eventTypes, ...params } = options;
    return this.get<TimelinePage>(
      `/v1/records/${encodeURIComponent(id)}/timeline`,
      {
        ...params,
        types: types?.join(','),
        fields: fields?.join(','),
        eventTypes: eventTypes?.join(','),
      },
      signal,
    );
  }
  /**
   * A record's current facts, or a profile's: `workspace` for workspace
   * memory, `me` for the caller's personal memory (personal memory spec 4.4).
   */
  facts(id: string, options: PageOptions = {}) {
    const { signal, ...params } = options;
    return this.get<FactPlace & { facts: PresentedFact[]; nextCursor: string | null }>(
      `/v1/records/${encodeURIComponent(id)}/facts`,
      params,
      signal,
    );
  }
  /**
   * Adds a fact to a record or a profile (`workspace`, `me`). `supersedes`
   * replaces a current fact: on the same record it corrects it, elsewhere it
   * moves it (4.9).
   */
  remember(
    id: string,
    input: { text: string; source?: string; quote?: string; supersedes?: string },
    idempotencyKey?: string,
  ) {
    return this.post<{ fact: PresentedFact }>(
      `/v1/records/${encodeURIComponent(id)}/facts`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  retractFact(id: string) {
    return this.request<{ id: string; deleted: true }>(`/v1/facts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  /** A record's comments, newest first, with their total. A merged ID follows the merge. */
  listComments(id: string, options: PageOptions = {}) {
    const { signal, ...params } = options;
    return this.get<CommentPage>(`/v1/records/${encodeURIComponent(id)}/comments`, params, signal);
  }
  /** Adds a comment (a `user` key only). Retrying with the same key adds it once. */
  addComment(id: string, input: { body: string }, idempotencyKey?: string) {
    return this.post<PresentedComment>(
      `/v1/records/${encodeURIComponent(id)}/comments`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  /** Edits a comment's body; its author only. */
  editComment(id: string, input: { body: string }, idempotencyKey?: string) {
    return this.send<PresentedComment>(
      'PATCH',
      `/v1/comments/${encodeURIComponent(id)}`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  /** Deletes a comment; its author, or a `user` key with `admin`. */
  deleteComment(id: string, idempotencyKey?: string) {
    return this.send<{ id: string; deleted: true }>(
      'DELETE',
      `/v1/comments/${encodeURIComponent(id)}`,
      undefined,
      undefined,
      idempotencyKey,
    );
  }
  /** One live event: the record with its built-in columns and links. */
  event(id: string, signal?: AbortSignal) {
    return this.get<PresentedRecord>(`/v1/events/${encodeURIComponent(id)}`, {}, signal);
  }
  /** Events, new records and grouped record writes, newest added first. */
  workspaceFeed(input: WorkspaceFeedInput = {}, signal?: AbortSignal): Promise<WorkspaceFeedPage> {
    return this.post<WorkspaceFeedPage>('/v1/feed/query', input, signal);
  }

  /**
   * Events of every event type in one page, newest first (`POST /v1/events/query`).
   * Filters take `type`, `occurredAt`, `channel` and `externalId`; `linked` finds
   * the events attached to one record.
   */
  queryEvents(input: EventQueryInput = {}, signal?: AbortSignal) {
    return this.post<EventPage>('/v1/events/query', input, signal);
  }
  /**
   * Logs an event; idempotent by channel and externalId. After creating an
   * unmatched person, re-log with the same handle/role and their recordId.
   * `added.participants.matched` includes participants resolved in place.
   */
  logEvent(input: LogEventInput) {
    return this.post<LogEventResult>('/v1/events', input);
  }
  /**
   * Moves events to another event type, keeping their IDs, identities, links
   * and the claims that cite them (`POST /v1/events/move`). Moving needs a
   * `user` key with the `admin` scope; `dryRun: true` reports the plan with
   * `schema:write` and changes nothing.
   */
  moveEvents(input: MoveEventsInput) {
    return this.post<MoveEventsResult>('/v1/events/move', input);
  }
  /**
   * Adds links and retries eligible unmatched participants in place; idempotent.
   * Successful resolutions are included in `added.participants.matched`.
   */
  addEventLinks(id: string, input: { participants?: Participant[]; about?: string[] }) {
    return this.post<PresentedRecord & { added: AddedLinks }>(
      `/v1/events/${encodeURIComponent(id)}/links`,
      input,
    );
  }
  /** Removes one participant (a person's key only). */
  removeParticipant(id: string, participantId: string) {
    return this.request<PresentedRecord>(
      `/v1/events/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}`,
      { method: 'DELETE' },
    );
  }
  /** Removes a record from an event's `about` list (a person's key only). */
  removeAbout(id: string, recordId: string) {
    return this.request<PresentedRecord>(
      `/v1/events/${encodeURIComponent(id)}/about/${encodeURIComponent(recordId)}`,
      { method: 'DELETE' },
    );
  }
  /** Deletes an event and retracts the claims that cite it. */
  deleteEvent(id: string) {
    return this.request<RetractEventResult>(`/v1/events/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  claims(
    id: string,
    options: Omit<PageOptions, 'cursor'> & {
      assertionsCursor?: string;
      factsCursor?: string;
      /** `false` leaves out the event's own logged values, which cite it too. */
      own?: boolean;
    } = {},
  ) {
    const { signal, ...params } = options;
    return this.get<{
      assertions: AssertionView[];
      facts: PresentedFact[];
      nextCursors: { assertions: string | null; facts: string | null };
    }>(`/v1/events/${encodeURIComponent(id)}/claims`, params, signal);
  }
  fileErasureStatus(ids: string[]) {
    return this.post<{
      pending: number;
      succeeded: number;
      jobs: { id: string; status: string; code: string | null }[];
    }>('/v1/files/erasure-status', { ids });
  }
  createFileIntent(input: import('@retainer/shared').FileUploadInput, idempotencyKey: string) {
    return this.post<{ id: string; upload: import('@retainer/shared').FileTransfer }>(
      '/v1/files/intents',
      input,
      undefined,
      idempotencyKey,
    );
  }
  finalizeFile(id: string) {
    return this.post<import('@retainer/shared').FileView & { state: 'ready' }>(
      `/v1/files/${encodeURIComponent(id)}/finalize`,
    );
  }
  file(id: string, signal?: AbortSignal) {
    return this.get<import('@retainer/shared').FileView>(
      `/v1/files/${encodeURIComponent(id)}`,
      {},
      signal,
    );
  }
  downloadFile(id: string) {
    return this.post<import('@retainer/shared').FileTransfer>(
      `/v1/files/${encodeURIComponent(id)}/download`,
    );
  }
  extensionCatalog(signal?: AbortSignal) {
    return this.get<{
      releases: { manifest: ExtensionManifest; digest: string; actorCeiling: string }[];
    }>('/v1/extensions/catalog', {}, signal);
  }
  verifySource(installationId: string, input: { sharing: 'workspace'; accountId?: string }) {
    return this.post<{
      sourceAccountId: string;
      provider: string;
      identity: string;
      sharing: 'workspace';
    }>(`/v1/extensions/${encodeURIComponent(installationId)}/source/verify`, input);
  }
  reserveSourceItem(
    installationId: string,
    input: { sourceAccountId: string; externalId: string },
  ) {
    return this.post<{ sourceItemId: string }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items`,
      input,
    );
  }
  sourceConnection(installationId: string) {
    return this.get<{
      sourceAccountId: string;
      provider: string;
      identity: 'account' | 'global-resource';
    }>(`/v1/extensions/${encodeURIComponent(installationId)}/source`);
  }
  sourceSyncStatus(installationId: string, signal?: AbortSignal) {
    return this.get<import('@retainer/shared').SourceSyncStatus>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-sync`,
      {},
      signal,
    );
  }
  beginSourceScan(installationId: string, input: import('@retainer/shared').SourceScan) {
    return this.post<{ scanId: string }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-sync`,
      input,
    );
  }
  reserveSourceItems(
    installationId: string,
    input: { sourceAccountId: string; externalIds: string[] },
  ) {
    return this.post<{
      items: (
        | {
            externalId: string;
            sourceItemId: string;
            state: string;
            providerRevision: string | null;
          }
        | { externalId: string; code: 'source_erased' | 'source_deleted' }
      )[];
    }>(`/v1/extensions/${encodeURIComponent(installationId)}/source-items/batch`, input);
  }
  sourceItem(installationId: string, itemId: string) {
    return this.get<import('@retainer/shared').SourceItemView>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items/${encodeURIComponent(itemId)}`,
    );
  }
  changes(input: { after?: string; limit?: number; signal?: AbortSignal } = {}) {
    const { signal, ...params } = input;
    return this.get<import('@retainer/shared').ChangePage>('/v1/changes', params, signal);
  }
  change(position: string, signal?: AbortSignal) {
    return this.get<import('@retainer/shared').RecordChange>(
      `/v1/changes/${encodeURIComponent(position)}`,
      {},
      signal,
    );
  }
  gmailImportWindow(installationId: string) {
    return this.get<{ from: number; through?: number }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/runtime/gmail/window`,
    );
  }
  gmailTarget(installationId: string, additionId: string | null, complete = false) {
    return this.post<{
      target: { id: string; email: string; from: number; through: number } | null;
    }>(`/v1/extensions/${encodeURIComponent(installationId)}/runtime/gmail/target`, {
      additionId,
      complete,
    });
  }
  releaseGmailConnection(installationId: string) {
    return this.post<{ released: true }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/runtime/gmail/release`,
      {},
    );
  }
  prepareGmailMessage(
    installationId: string,
    input: {
      from: string[];
      to: string[];
      occurredAt: string;
      messageId: string;
      sourceItemId: string;
    },
  ) {
    return this.post<{ prepared: boolean }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/runtime/gmail/prepare`,
      input,
    );
  }
  appendGmailMessage(
    installationId: string,
    input: {
      sourceItemId: string;
      from: string[];
      to: string[];
      messageId: string;
      threadId: string;
      rfcMessageId?: string;
      occurredAt: string;
      originalDate?: string;
      subject: string;
      body: string;
      targetEmail?: string;
      targetPersonId?: string;
    },
  ) {
    return this.post<
      | { kind: 'imported'; messageId: string; eventId: string; created: boolean }
      | { kind: 'no_match' | 'removed' }
    >(`/v1/extensions/${encodeURIComponent(installationId)}/runtime/gmail/messages`, input);
  }
  gmailMessages(eventId: string, after?: string, signal?: AbortSignal) {
    return this.get<{
      messages: { id: string; occurredAt: string; originalDate: string | null; body: string }[];
      nextAfter: string | null;
    }>(`/v1/events/${encodeURIComponent(eventId)}/gmail-messages`, { after }, signal);
  }
  prepareSourceItem(installationId: string, itemId: string, participants: string[]) {
    return this.post<{ prepared: true }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items/${encodeURIComponent(itemId)}/prepare`,
      { participants },
    );
  }
  markSourceUnavailable(
    installationId: string,
    itemId: string,
    input: { status: 'unavailable' | 'deleted'; evidence?: 'provider_event' | 'definitive_lookup' },
  ) {
    return this.post<{
      state: string;
      invalidated: import('@retainer/shared').SourceEventResult['invalidated'];
    }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items/${encodeURIComponent(itemId)}/unavailable`,
      input,
    );
  }
  sourceRecoveryItems(installationId: string, options: PageOptions = {}) {
    const { signal, ...params } = options;
    return this.get<{ items: { sourceItemId: string }[]; nextCursor: string | null }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items`,
      params,
      signal,
    );
  }
  syncSourceEvent(installationId: string, input: import('@retainer/shared').SourceEventImport) {
    return this.post<import('@retainer/shared').SourceEventResult>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-events`,
      input,
    );
  }
  sourceTaskSchema(installationId: string) {
    return this.get<import('@retainer/extension').SourceTaskSchema>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-tasks/schema`,
    );
  }
  syncSourceTasks(
    installationId: string,
    itemId: string,
    input: import('@retainer/extension').SourceTaskBatchInput,
  ) {
    return this.post<import('@retainer/extension').SourceTaskBatchResult>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source-items/${encodeURIComponent(itemId)}/tasks`,
      input,
    );
  }
  disconnectSource(installationId: string) {
    return this.post<{ disconnected: true }>(
      `/v1/extensions/${encodeURIComponent(installationId)}/source/disconnect`,
    );
  }
  extensions(signal?: AbortSignal) {
    return this.get<{ installations: ExtensionInstallation[] }>('/v1/extensions', {}, signal);
  }
  extension(id: string, signal?: AbortSignal) {
    return this.get<
      ExtensionInstallation & {
        contributions: { kind: string; universalId: string; elementId: string }[];
      }
    >(`/v1/extensions/${encodeURIComponent(id)}`, {}, signal);
  }
  previewExtension(input: ExtensionInstallInput) {
    return this.post<ExtensionPreview>('/v1/extensions/preview', input);
  }
  installExtension(input: ExtensionInstallInput & { planDigest: string }, idempotencyKey: string) {
    return this.post<ExtensionInstallation>('/v1/extensions', input, undefined, idempotencyKey);
  }
  extensionConnections(id: string, signal?: AbortSignal) {
    return this.get<{ connections: ExtensionConnection[] }>(
      `/v1/extensions/${encodeURIComponent(id)}/connections`,
      {},
      signal,
    );
  }
  authorizeGmail(id: string, historyDays: number) {
    return this.post<{
      attemptId: string;
      connectLink: string;
      sessionToken: string;
      integrationId: string;
      expiresAt: string;
    }>(`/v1/extensions/${encodeURIComponent(id)}/connections/gmail/authorize`, {
      shareGmail: true,
      historyDays,
    });
  }
  finishGmailAuthorization(id: string, attemptId: string) {
    return this.post<{ pending: true } | { id: string; state: 'connecting' }>(
      `/v1/extensions/${encodeURIComponent(id)}/connections/gmail/complete`,
      { attemptId },
    );
  }
  stageExtensionConnectionSecret(
    id: string,
    input: { connectionId?: string; name: string; value: string },
  ) {
    return this.post<{
      pendingSecretId: string;
      installationId: string;
      connectionId: string;
      expiresAt: string;
    }>(`/v1/extensions/${encodeURIComponent(id)}/connections/secrets`, input);
  }
  connectExtension(id: string, input: ExtensionConnectionInput) {
    return this.post<{ id: string; state: 'connecting' }>(
      `/v1/extensions/${encodeURIComponent(id)}/connections`,
      input,
    );
  }
  /** Start an OAuth connection; navigate the browser to `authorizationUrl`. */
  authorizeExtensionConnection(id: string, input: ExtensionAuthorizeInput) {
    return this.post<ExtensionAuthorization>(
      `/v1/extensions/${encodeURIComponent(id)}/connections/authorize`,
      input,
    );
  }
  /** Finish the OAuth round trip from the callback page, with the provider's code or error. */
  completeExtensionAuthorization(id: string, input: ExtensionAuthorizationCompletion) {
    return this.post<{ id: string; state: 'connecting' } | { cancelled: true }>(
      `/v1/extensions/${encodeURIComponent(id)}/connections/authorize/complete`,
      input,
    );
  }
  /** Hide the release notice the member saw; `at` is `releaseNotice.at`, unchanged. */
  dismissReleaseNotice(id: string, connection: string, at: string) {
    return this.post<{ dismissed: true }>(
      `/v1/extensions/${encodeURIComponent(id)}/connections/${encodeURIComponent(connection)}/release-notice/dismiss`,
      { at },
    );
  }
  /** The operator's OAuth client, for a live run whose function holds the token secret. */
  extensionOAuthClient(id: string) {
    return this.get<ExtensionOAuthClient>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/oauth-client`,
    );
  }
  disconnectExtension(id: string, connection: string) {
    return this.send<{ disconnected: true }>(
      'DELETE',
      `/v1/extensions/${encodeURIComponent(id)}/connections/${encodeURIComponent(connection)}`,
    );
  }
  extensionRuns(id: string, options: PageOptions & { connection?: string } = {}) {
    const { signal, ...params } = options;
    return this.get<{
      runs: {
        id: string;
        functionId: string;
        connectionId: string | null;
        status: string;
        attempt: number;
        generation: number;
        releaseDigest: string;
        code: string | null;
        createdAt: string;
        updatedAt: string;
      }[];
      nextCursor: string | null;
    }>(`/v1/extensions/${encodeURIComponent(id)}/runs`, params, signal);
  }
  retryExtensionRun(id: string, runId: string, idempotencyKey: string) {
    return this.post<{ id: string; status: string }>(
      `/v1/extensions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/retry`,
      undefined,
      undefined,
      idempotencyKey,
    );
  }
  upgradeExtension(
    id: string,
    input: ExtensionInstallInput & { planDigest: string },
    idempotencyKey: string,
  ) {
    return this.post<ExtensionInstallation>(
      `/v1/extensions/${encodeURIComponent(id)}/upgrade`,
      { ...input, installationId: id },
      undefined,
      idempotencyKey,
    );
  }
  /** Commits a reviewed mapping change: preview with `installationId` and `mappingChange: true` first. */
  changeExtensionMapping(
    id: string,
    input: ExtensionInstallInput & { planDigest: string },
    idempotencyKey: string,
  ) {
    return this.post<ExtensionInstallation>(
      `/v1/extensions/${encodeURIComponent(id)}/mapping`,
      { ...input, installationId: id, mappingChange: true },
      undefined,
      idempotencyKey,
    );
  }
  reconnectExtension(
    id: string,
    connection: string,
    input: ExtensionConnectionInput & { expectedGeneration: number },
  ): Promise<{ id: string; state: 'connecting' }>;
  reconnectExtension(
    id: string,
    input: ExtensionInstallInput & { planDigest: string },
    idempotencyKey: string,
  ): Promise<ExtensionInstallation>;
  reconnectExtension(
    id: string,
    connectionOrInput: string | (ExtensionInstallInput & { planDigest: string }),
    inputOrKey: (ExtensionConnectionInput & { expectedGeneration: number }) | string,
  ) {
    if (typeof connectionOrInput === 'string' && typeof inputOrKey !== 'string')
      return this.post<{ id: string; state: 'connecting' }>(
        `/v1/extensions/${encodeURIComponent(id)}/connections/${encodeURIComponent(connectionOrInput)}/reconnect`,
        inputOrKey,
      );
    if (typeof connectionOrInput !== 'string' && typeof inputOrKey === 'string')
      return this.post<ExtensionInstallation>(
        `/v1/extensions/${encodeURIComponent(id)}/reconnect`,
        connectionOrInput,
        undefined,
        inputOrKey,
      );
    throw new TypeError('invalid reconnect arguments');
  }
  updateExtensionSettings(
    id: string,
    input: { expectedRevision: number; settings: ExtensionInstallInput['settings'] },
  ) {
    return this.send<ExtensionInstallation>(
      'PATCH',
      `/v1/extensions/${encodeURIComponent(id)}/settings`,
      input,
    );
  }
  enableExtension(id: string) {
    return this.post<ExtensionInstallation>(`/v1/extensions/${encodeURIComponent(id)}/enable`);
  }
  stageExtensionSecret(input: {
    registrationId: string;
    version: string;
    installationId?: string;
    name: string;
    value: string;
  }) {
    return this.post<{ pendingSecretId: string; installationId: string; expiresAt: string }>(
      '/v1/extensions/secrets',
      input,
    );
  }
  /**
   * The fill-only mapped write of a run whose function declares `mappedWrite`:
   * fills only mapped fields that have no value and were not cleared. A
   * `confidence` below the workspace's threshold holds the values for review
   * (agent actors only).
   */
  extensionMappedWrite(
    installationId: string,
    input: {
      recordId: string;
      lookup?: string;
      values: Record<string, unknown>;
      observedAt?: string;
      confidence?: number;
    },
  ) {
    return this.post<{
      outcome: 'applied' | 'skipped';
      reason?: 'record_deleted' | 'record_merged' | 'lookup_changed' | 'nothing_to_fill';
      fields: Record<string, 'applied' | 'populated' | 'cleared' | 'pending_review'>;
    }>(`/v1/extensions/${encodeURIComponent(installationId)}/runtime/mapped-writes`, input);
  }
  /**
   * Queue child jobs and compare-and-set one KV value, all or nothing. A KV
   * value can't be JSON `null` (422 `invalid_input`): a missing key reads as
   * null, and KV has no delete.
   */
  extensionCheckpoint(
    id: string,
    input: {
      children: { functionId: string; input: unknown; dedupeKey: string }[];
      scanComplete?: { scanId: string; through: string };
      kv?: { key: string; expectedRevision: number | null; value: NonNullable<unknown> };
    },
  ) {
    return this.post<{ ids: string[]; revision?: number }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/checkpoint`,
      input,
    );
  }
  extensionKv(id: string, key: string) {
    return this.get<{ value: unknown; revision: number } | null>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/kv/${encodeURIComponent(key)}`,
    );
  }
  extensionSecret(id: string, name: string) {
    return this.get<{ value: string; revision: number }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/secrets/${encodeURIComponent(name)}`,
    );
  }
  /** Store provider-generated signing/refresh material with revision CAS; live runs only. */
  setExtensionSecret(
    id: string,
    name: string,
    input: { expectedRevision: number | null; value: string },
  ) {
    return this.request<{ revision: number }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/secrets/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  /** Recompute only the release-pinned last-contact fields. Values, provenance and actor are server-derived. */
  reconcileLastContact(
    id: string,
    input:
      | { kind: 'scan'; after?: string | null; through?: string }
      | { kind: 'records'; recordIds: string[] },
  ) {
    return this.post<{
      processed: number;
      changed: number;
      nextAfter: string | null;
      through: string | null;
    }>(`/v1/extensions/${encodeURIComponent(id)}/runtime/last-contact`, input);
  }

  /** Reserve a durable callback before provider registration returns its signing material. Setup only. */
  prepareExtensionWebhook(id: string, input: { route: string }) {
    return this.post<{ bindingId: string; url: string }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/webhooks/prepare`,
      input,
    );
  }
  retireExtensionWebhook(id: string, input: { route: string }) {
    return this.post<{ retired: number }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/webhooks/retire`,
      input,
    );
  }
  /** Registered setup verifier only, after attesting its provider source account. */
  bindExtensionWebhook(
    id: string,
    input: { route: string; accountHint?: string; subscriptionId?: string },
  ) {
    return this.post<{ bindingId: string; url: string }>(
      `/v1/extensions/${encodeURIComponent(id)}/runtime/webhooks`,
      input,
    );
  }
  extensionWebhooks(id: string) {
    return this.get<{
      bindings: {
        bindingId: string;
        route: string;
        subscriptionId: string | null;
        active: boolean;
        state: 'pending' | 'active' | 'retired';
        url: string;
      }[];
    }>(`/v1/extensions/${encodeURIComponent(id)}/runtime/webhooks`);
  }
  extensionCredentials(id: string, signal?: AbortSignal) {
    return this.get<{ credentials: import('@retainer/extension').ExtensionCredential[] }>(
      `/v1/extensions/${encodeURIComponent(id)}/credentials`,
      {},
      signal,
    );
  }
  createExtensionKey(
    id: string,
    input: { expectedGeneration: number; scopes: ('read' | 'write')[] },
  ) {
    return this.post<{
      id: string;
      key: string;
      prefix: string;
      scopes: ('read' | 'write')[];
      generation: number;
      createdAt: string;
    }>(`/v1/extensions/${encodeURIComponent(id)}/keys`, input);
  }
  revokeExtensionCredential(id: string, credentialId: string) {
    return this.request<{ revoked: boolean }>(
      `/v1/extensions/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}`,
      { method: 'DELETE' },
    );
  }
  disableExtension(id: string) {
    return this.post<ExtensionInstallation>(`/v1/extensions/${encodeURIComponent(id)}/disable`);
  }
  cancelExtensionSuggestions(id: string, version?: string) {
    const query = version ? `?version=${encodeURIComponent(version)}` : '';
    return this.send<{ cancelled: boolean }>(
      'DELETE',
      `/v1/extensions/${encodeURIComponent(id)}/suggestions${query}`,
    );
  }
  configureExtension(id: string, version?: string) {
    return this.post<{ id: string }>(`/v1/extensions/${encodeURIComponent(id)}/configure`, {
      version,
    });
  }
  /** An installation's model use this calendar month (UTC). */
  extensionUsage(id: string, signal?: AbortSignal) {
    return this.get<{
      model: {
        month: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    }>(`/v1/extensions/${encodeURIComponent(id)}/usage`, undefined, signal);
  }
  extensionSuggestions(id: string, version?: string, signal?: AbortSignal) {
    return this.get<import('@retainer/extension').ExtensionSuggestions>(
      `/v1/extensions/${encodeURIComponent(id)}/suggestions`,
      { version },
      signal,
    );
  }
  saveExtensionSuggestions(
    id: string,
    input: {
      mapping?: Record<
        string,
        import('@retainer/extension').ExtensionMappingChoice & { reason?: string }
      >;
      settings?: Record<string, string | number | boolean>;
    },
  ) {
    return this.send<{ saved: boolean }>(
      'PUT',
      `/v1/extensions/${encodeURIComponent(id)}/runtime/suggestions`,
      input,
    );
  }
  turnOnExtension(id: string, input: ExtensionInstallInput & { planDigest: string }, key: string) {
    return this.post<ExtensionInstallation>(
      `/v1/extensions/${encodeURIComponent(id)}/turn-on`,
      input,
      undefined,
      key,
    );
  }
  approveExtensionAccess(
    id: string,
    input: ExtensionInstallInput & { planDigest: string },
    key: string,
  ) {
    return this.post<ExtensionInstallation>(
      `/v1/extensions/${encodeURIComponent(id)}/access`,
      input,
      undefined,
      key,
    );
  }
  uninstallExtension(id: string) {
    return this.post<ExtensionInstallation>(`/v1/extensions/${encodeURIComponent(id)}/uninstall`);
  }
  schemaChanges(options: PageOptions & { status?: string } = {}) {
    const { signal, ...params } = options;
    return this.get<{ changes: SchemaChange[]; total: number; nextCursor: string | null }>(
      '/v1/schema/changes',
      params,
      signal,
    );
  }
  schemaChange(id: string, signal?: AbortSignal) {
    return this.get<SchemaChange>(`/v1/schema/changes/${encodeURIComponent(id)}`, {}, signal);
  }
  /**
   * A change that existing records block comes back as 409 with the change
   * itself (`status: "failed"`, its `error` and the blocking `recordIds`),
   * so it is returned like any other outcome rather than thrown.
   */
  proposeSchemaChange(operations: SchemaOperation[], reason?: string) {
    return this.request<SchemaChangeResult>(
      '/v1/schema/changes',
      { method: 'POST', body: JSON.stringify({ operations, reason }) },
      isFailedChange,
    );
  }
  decideSchemaChange(id: string, decision: 'approve' | 'reject') {
    return this.request<SchemaChangeResult>(
      `/v1/schema/changes/${encodeURIComponent(id)}/${decision}`,
      { method: 'POST' },
      isFailedChange,
    );
  }

  // Routines (routines spec §5, §6).
  routineCapabilities(signal?: AbortSignal) {
    return this.get<RoutineCapabilities>('/v1/routines/capabilities', {}, signal);
  }
  /** Checks a routine; `wait` seconds for the sandbox's type-check before answering with a job. */
  validateRoutine(input: { manifest: unknown; code: string }, wait = 15) {
    return this.post<RoutineCheckResult>(`/v1/routines/validate?wait=${wait}`, input);
  }
  previewRoutine(input: { manifest: unknown; code: string }) {
    return this.post<{
      valid: boolean;
      problems: RoutineProblem[];
      /** Null when nothing matched recently: there is nothing to dry-run or poll. */
      previewId?: string | null;
      matched?: number;
      done?: boolean;
    }>('/v1/routines/preview', input);
  }
  routinePreview(previewId: string, signal?: AbortSignal) {
    return this.get<RoutinePreview>(
      `/v1/routines/previews/${encodeURIComponent(previewId)}`,
      {},
      signal,
    );
  }
  routineJob(jobId: string, signal?: AbortSignal) {
    return this.get<RoutineRunView & Partial<RoutineCheckResult>>(
      `/v1/routines/jobs/${encodeURIComponent(jobId)}`,
      {},
      signal,
    );
  }
  /** Asks the built-in builder for a routine from a description; poll the job. */
  buildRoutine(description: string, routineId?: string) {
    return this.post<{ jobId: string }>('/v1/routines/build', {
      description,
      ...(routineId ? { routineId } : {}),
    });
  }
  proposeRoutine(input: {
    manifest: unknown;
    code: string;
    name: string;
    description: string;
    summary: string;
    report: RoutineReport;
    routineId?: string;
  }) {
    return this.post<{ routineId: string; versionId: string; number: number }>(
      '/v1/routines',
      input,
    );
  }
  routines(signal?: AbortSignal) {
    return this.get<{ timeZone: string; routines: RoutineView[] }>('/v1/routines', {}, signal);
  }
  routine(id: string, signal?: AbortSignal) {
    return this.get<RoutineDetail>(`/v1/routines/${encodeURIComponent(id)}`, {}, signal);
  }
  routineRun(id: string, runId: string, signal?: AbortSignal) {
    return this.get<RoutineRunView>(
      `/v1/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
      {},
      signal,
    );
  }
  decideRoutineVersion(id: string, versionId: string, decision: 'approve' | 'reject') {
    return this.post<{
      routineId: string;
      versionId: string;
      state?: string;
      status?: string;
      discardedRuns?: number;
    }>(
      `/v1/routines/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/${decision}`,
      {},
    );
  }
  /** Runs a version once for real, on one record, as the admin who asks. */
  testRoutine(id: string, versionId: string, recordId: string | null) {
    return this.post<{ runId: string }>(
      `/v1/routines/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/test`,
      { recordId },
    );
  }
  setRoutineState(id: string, action: 'pause' | 'resume' | 'archive') {
    return this.post<{ routineId: string; status: RoutineView['status'] }>(
      `/v1/routines/${encodeURIComponent(id)}/${action}`,
      {},
    );
  }
  releaseHeldRuns(id: string, action: 'run' | 'discard') {
    return this.post<{ routineId: string; queued?: number; discarded?: number }>(
      `/v1/routines/${encodeURIComponent(id)}/held`,
      {
        action,
      },
    );
  }
  /** Runs an active schedule routine's tick now; its regular schedule is unchanged. */
  runRoutineNow(id: string) {
    return this.post<{ routineId: string; queued: number; held?: number; matched?: number }>(
      `/v1/routines/${encodeURIComponent(id)}/run-now`,
      {},
    );
  }
  runRoutine(id: string, recordIds: string[]) {
    return this.post<{ runs: string[] }>(`/v1/routines/${encodeURIComponent(id)}/run`, {
      recordIds,
    });
  }
  routineButtons(object: string, signal?: AbortSignal) {
    return this.get<{ buttons: RoutineButton[] }>('/v1/routines/buttons', { object }, signal);
  }
  setTimeZone(timeZone: string) {
    return this.send<{ timeZone: string }>('PUT', '/v1/workspace/time-zone', { timeZone });
  }
}
