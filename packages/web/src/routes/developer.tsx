import type { ObjectView, PresentedRecord } from '@retainer/shared';
import { useCallback, useContext } from 'react';
import { ApiName, Code, CopyButton, Property, PropertyList, Row, Section } from '../ui/index.js';
import { asViewLevel, DeveloperContext, VIEW_LEVELS, type ViewLevel } from '../ui/view-level.js';

/**
 * The View control (D8, agent view spec §3): Standard, Developer or Agent.
 * Developer shows API names, classes, IDs and write paths beside what people
 * read; Agent adds what Retainer tells agents. Each level only adds to the one
 * before. Remembered per browser, for every actor. It changes what is
 * displayed, never what is sent.
 */
export const VIEW_LEVEL_KEY = 'retainer:view-level:v1';
export { DeveloperContext, VIEW_LEVELS, type ViewLevel };

/** The level left on in this browser; Standard when storage is refused or holds something else. */
export function readViewLevel(storage: () => Pick<Storage, 'getItem'>): ViewLevel {
  try {
    const stored = storage().getItem(VIEW_LEVEL_KEY);
    return asViewLevel(stored) ?? 'off';
  } catch {
    return 'off';
  }
}

/** Remembers the level; false when the browser refuses storage (it still works for the visit). */
export function writeViewLevel(storage: () => Pick<Storage, 'setItem'>, level: ViewLevel): boolean {
  try {
    storage().setItem(VIEW_LEVEL_KEY, level);
    return true;
  } catch {
    return false;
  }
}

/** Whether developer view is on: true at Developer and Agent. */
export const useDeveloper = () => useContext(DeveloperContext).level !== 'off';
/** Whether agent view is on: true at Agent only. */
export const useAgentView = () => useContext(DeveloperContext).level === 'agent';
/** `name` while developer view is on, for an `apiName` prop; otherwise nothing. */
export function useApiName() {
  const on = useDeveloper();
  // Stable while the switch holds, so memoized columns and options keep it as a dependency.
  return useCallback((name: string | undefined) => (on ? name : undefined), [on]);
}
/**
 * A field or object description in agent view, for a `descriptionLine` prop
 * (agent view spec §4); otherwise nothing. A blank description shows nothing.
 */
export function useAgentDescription() {
  const on = useAgentView();
  return useCallback(
    (description: string | null | undefined) =>
      on && description?.trim() ? description.trim() : undefined,
    [on],
  );
}

/** How a record of this class is written: the MCP tool and the REST routes. */
export function writePath(
  object: Pick<ObjectView, 'class' | 'nameSingular'>,
  id: string,
): { tool: string; routes: string[] } {
  return object.class === 'event'
    ? { tool: 'log_event', routes: ['POST /v1/events'] }
    : {
        tool: 'upsert_record',
        routes: [`POST /v1/objects/${object.nameSingular}/upsert`, `PATCH /v1/records/${id}`],
      };
}

/** An API name beside a label, only in developer view. */
export function ApiLabel({ name }: { name: string }) {
  return useDeveloper() ? <ApiName>{name}</ApiName> : null;
}

/**
 * What a developer needs to address a record: its object's API name and
 * class, its ID with a copy button, and how it is written. Developer view only.
 */
export function DeveloperFacts({
  record,
  object,
}: {
  record: Pick<PresentedRecord, 'id' | 'object'>;
  object: ObjectView | undefined;
}) {
  if (!useDeveloper()) return null;
  const path = object ? writePath(object, record.id) : undefined;
  return (
    <Section title="Developer">
      <PropertyList>
        <Property label="Object">
          <Row>
            <Code>{record.object}</Code>
            <Code>{object?.class ?? 'unknown'}</Code>
          </Row>
        </Property>
        <Property label="ID">
          <Row nowrap>
            <Code>{record.id}</Code>
            <CopyButton value={record.id} label="Copy ID" />
          </Row>
        </Property>
        {path ? (
          <Property label="Written with">
            <Row>
              <Code>{path.tool}</Code>
              {path.routes.map((r) => (
                <Code key={r}>{r}</Code>
              ))}
            </Row>
          </Property>
        ) : null}
      </PropertyList>
    </Section>
  );
}
