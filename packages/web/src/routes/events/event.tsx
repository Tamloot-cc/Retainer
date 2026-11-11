import { isInverseRelation } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { ActorBadge } from '../../provenance/index.js';
import {
  Button,
  Dialog,
  EntryText,
  Muted,
  Notice,
  Page,
  Panel,
  Property,
  PropertyList,
  Stack,
} from '../../ui/index.js';
import { DeveloperFacts, useApiName } from '../developer.js';
import { MemoryTabs, useMemoryNav } from '../records/record-memory.js';
import { useRecord } from '../records/record-view.js';
import { classLabel, eventTitle, objectByName, QueryError } from '../state.js';
import { EventDetailsView } from './event-details.js';
import { eventMedium, mediumField } from './event-list.js';

/**
 * One event (`GET /v1/events/:id`): its type, time, channel, participants and
 * `about` records, its other fields, then its comments, the claims citing it
 * and the history of its fields.
 */
export function EventPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    nav = useMemoryNav(),
    apiName = useApiName();
  // The record read: it carries the tab counts, and the sheet shares its cache.
  const query = useRecord(id);
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [deleted, setDeleted] = useState(false);
  const canWrite = canMutate(session);
  async function remove() {
    setBusy(true);
    try {
      const result = await api.deleteEvent(id);
      setMessage(
        `Event deleted: ${result.retractedAssertions} assertions retracted, ${result.recomputedRecordIds.length} records recomputed, ${result.hiddenFactIds.length} facts hidden.`,
      );
      setDeleted(true);
      setConfirm(false);
      client.removeQueries({ queryKey: [session.workspace.id, 'record', id] });
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <Page title="Event deleted">
        <Notice>{message}</Notice>
      </Page>
    );
  const r = query.data;
  if (!r?.event)
    return (
      <Page title="Event">
        {query.error ? (
          <QueryError error={query.error} retry={() => void query.refetch()} />
        ) : r ? (
          <Notice error>This record is not an event.</Notice>
        ) : (
          <Notice>Loading event…</Notice>
        )}
      </Page>
    );
  const e = r.event;
  const type = objectByName(schema, r.object);
  // Title and summary show above; the type's other fields are listed here.
  // The medium shows beside the type and source, so it isn't listed again below.
  const medium = eventMedium(type, r);
  const mediumName = medium ? mediumField(type)?.name : undefined;
  const others = (type?.fields ?? []).filter(
    (f) => !f.coreRole && !isInverseRelation(f) && f.name !== mediumName,
  );
  return (
    <Page
      eyebrow={classLabel(type) ?? r.object}
      title={eventTitle(e)}
      description={[
        type?.labelSingular ?? r.object,
        medium,
        e.channel ? `Source: ${e.channel}` : 'Source erased',
        new Date(e.occurredAt).toLocaleString(),
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        <>
          <Button asChild variant="ghost" size="small">
            <Link to="/r/$id" params={{ id: r.id }}>
              {canWrite && !e.source ? 'Edit fields' : 'Open as record'}
            </Link>
          </Button>
          {canWrite ? <Button onClick={() => setConfirm(true)}>Delete event</Button> : null}
        </>
      }
    >
      {message ? <Notice>{message}</Notice> : null}
      <DeveloperFacts record={r} object={type} />
      <Panel title="Summary">
        <Stack>
          {e.summary ? <EntryText>{e.summary}</EntryText> : <Muted>No summary</Muted>}
          <ActorBadge actor={r.createdBy} />
        </Stack>
      </Panel>
      <Panel title="Details">
        <EventDetailsView
          id={r.id}
          event={e}
          editable={canWrite}
          medium={medium}
          {...(mediumName ? { mediumName } : {})}
        />
      </Panel>
      {others.length ? (
        <Panel title="Fields">
          <PropertyList>
            {others.map((f) => {
              const Display = fields[f.type].Display;
              return (
                <Property key={f.name} label={f.label} apiName={apiName(f.name)}>
                  <Display field={f} value={r.fields[f.name]} references={r.relationReferences} />
                </Property>
              );
            })}
          </PropertyList>
        </Panel>
      ) : null}
      <MemoryTabs key={r.id} record={r} nav={nav} />
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
        title="Delete this event?"
        description="The values it recorded are retracted and affected records recomputed. Facts with no other live sources are hidden."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          Delete event
        </Button>
      </Dialog>
    </Page>
  );
}
