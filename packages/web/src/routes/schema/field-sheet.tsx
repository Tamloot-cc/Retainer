import { type FieldView, isInverseRelation, type ObjectView } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Check,
  CheckLabel,
  Code,
  Input,
  Muted,
  Notice,
  Property,
  PropertyList,
  Row,
  Section,
  Sheet,
  Stack,
  TextButton,
} from '../../ui/index.js';
import { CORE_ROLE_TEXT, FieldTypeLabel, OWNERS, OwnerBadge } from './schema-labels.js';
import { canRollUpEvents, cardinality, isManyRelation, relationEnds } from './schema-model.js';

/** The flags shown as table columns and, in words, in the field sheet. */
export const FLAGS: { label: string; on: (f: FieldView) => boolean; yes: string; no: string }[] = [
  {
    label: 'Required',
    on: (f) => !f.isNullable,
    yes: 'Every record must have a value',
    no: 'Can be empty',
  },
  {
    label: 'Unique',
    on: (f) => f.isUnique,
    yes: 'No two records can share a value',
    no: 'Values can repeat',
  },
  {
    label: 'Filterable',
    on: (f) => f.isFilterable,
    yes: 'Lists can be filtered by it',
    no: 'Not offered as a filter',
  },
  {
    label: 'Searchable',
    on: (f) => f.isSearchable,
    yes: 'Included in keyword search',
    no: 'Not searched',
  },
];

export function FieldSheet({
  object,
  field,
  onClose,
  onNavigate,
}: {
  object: ObjectView;
  field: FieldView;
  onClose: () => void;
  onNavigate: (object: string, field?: string) => void;
}) {
  const { schema } = useWorkspace();
  const s = field.settings;
  const { target, targets, inverse } = relationEnds(field, schema.objects);
  const flags = [
    ...FLAGS.map((f) => ({ ...f, on: f.on(field) })),
    {
      label: 'Read only',
      on: field.readOnly,
      yes:
        isInverseRelation(field) && target && inverse
          ? `The inverse side; write ${target.labelSingular} → ${inverse.label} instead`
          : 'Written by the server, not directly',
      no: 'Agents and people can write it',
    },
  ];
  return (
    <Sheet
      eyebrow={`${object.labelSingular} · field`}
      title={field.label}
      description={`Definition of the ${field.label} field`}
      onClose={onClose}
      getReturnFocus={() =>
        document.querySelector<HTMLButtonElement>(
          `[data-schema-field="${CSS.escape(field.name)}"] button`,
        )
      }
    >
      {field.description ? <Muted>{field.description}</Muted> : null}
      <Section title="Definition">
        <PropertyList>
          <Property label="API name">
            <Code>{field.name}</Code>
          </Property>
          <Property label="Type">
            <FieldTypeLabel field={field} />
          </Property>
          <Property label="Owner">
            <Row>
              <OwnerBadge owner={field.owner} />
              <Muted>{OWNERS[field.owner].hint}</Muted>
            </Row>
          </Property>
          {field.name === object.labelField ? (
            <Property label="Label field">
              Names {object.labelPlural.toLowerCase()} wherever they are referenced
            </Property>
          ) : null}
          {field.coreRole ? (
            <Property label="Core field">{CORE_ROLE_TEXT[field.coreRole]}</Property>
          ) : field.isProtected ? (
            <Property label="Protected">
              Retainer depends on it. It can be renamed but not deleted.
            </Property>
          ) : null}
          {s.maxValues ? <Property label="Most values">{s.maxValues}</Property> : null}
          {field.universalId ? (
            <Property label="Universal ID">
              <Code>{field.universalId}</Code>
            </Property>
          ) : null}
        </PropertyList>
      </Section>
      {field.type === 'relation' ? (
        <Section title="Relation">
          <PropertyList>
            <Property label="Links to">
              {targets.length ? (
                <Row>
                  {/* "Companies, People or Deals" */}
                  {targets.map(({ name, object: t }, i) => (
                    <Fragment key={name}>
                      {i && i === targets.length - 1 ? <Muted>or</Muted> : null}
                      <span className="inline-flex items-center">
                        {t ? (
                          <TextButton onClick={() => onNavigate(t.nameSingular)}>
                            {t.labelPlural}
                          </TextButton>
                        ) : (
                          <Code>{name}</Code>
                        )}
                        {i < targets.length - 2 ? <Muted>,</Muted> : null}
                      </span>
                    </Fragment>
                  ))}
                </Row>
              ) : (
                <Code>unknown</Code>
              )}
            </Property>
            <Property label="Cardinality">
              {cardinality(
                object,
                targets.flatMap((t) => (t.object ? [t.object] : [])),
                isManyRelation(field),
              )}
            </Property>
            {targets.length > 1 ? (
              <Property label="Polymorphic">
                Links records of any of these objects. There is no field on the other side: filter
                on this field to find what links to a record.
              </Property>
            ) : null}
            <Property label="Side">
              {isInverseRelation(field)
                ? 'Inverse: derived from the other side, read only'
                : 'Owning: written here'}
            </Property>
            {s.inverseField ? (
              <Property label="Other side">
                {target && inverse ? (
                  <TextButton onClick={() => onNavigate(target.nameSingular, inverse.name)}>
                    {target.labelSingular} → {inverse.label}
                  </TextButton>
                ) : (
                  <Code>{s.inverseField}</Code>
                )}
              </Property>
            ) : null}
            {canRollUpEvents(object, field) ? (
              <Property label="Roll up events">
                <RollUpEventsSwitch object={object} field={field} />
              </Property>
            ) : null}
            {s.onDelete ? (
              <Property label="If target is deleted">
                {s.onDelete === 'cascade'
                  ? `Delete the ${object.labelSingular.toLowerCase()} too`
                  : 'Clear this link'}
              </Property>
            ) : null}
          </PropertyList>
        </Section>
      ) : null}
      {s.options ? (
        <Section title={`Options (${s.options.length})`}>
          {s.options.length ? (
            <PropertyList>
              {s.options.map((o) => (
                <Property key={o.value} label={o.label}>
                  <Code>{o.value}</Code>
                </Property>
              ))}
            </PropertyList>
          ) : (
            <Muted>No options yet.</Muted>
          )}
        </Section>
      ) : null}
      <Section title="Behaviour">
        <PropertyList>
          {flags.map((f) => (
            <Property key={f.label} label={f.label}>
              <Row>
                <Check value={f.on} />
                <Muted>{f.on ? f.yes : f.no}</Muted>
              </Row>
            </Property>
          ))}
        </PropertyList>
      </Section>
    </Sheet>
  );
}

/**
 * Turns event rollup on or off for an owning relation field, as an
 * `update_field` change: additive, so it applies without review. Read only
 * without `schema:write`.
 */
export function RollUpEventsSwitch({ object, field }: { object: ObjectView; field: FieldView }) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const on = field.settings.rollUpEvents === true;
  const allowed = canMutate(session, 'schema:write');
  async function change(next: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await api.proposeSchemaChange([
        { op: 'update_field', object: object.nameSingular, field: field.name, rollUpEvents: next },
      ]);
      if (result.status === 'failed') setError(result.change?.error ?? 'The change failed');
      else if (result.status === 'proposed') setError('Proposed: it applies once approved');
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack gap="small">
      {allowed ? (
        <CheckLabel>
          <Input
            type="checkbox"
            role="switch"
            aria-label="Roll up events"
            checked={on}
            disabled={busy}
            onChange={(e) => void change(e.target.checked)}
          />
          <span>{on ? 'On' : 'Off'}</span>
        </CheckLabel>
      ) : (
        <Check value={on} />
      )}
      <Muted small>
        Events attached to a {object.labelSingular.toLowerCase()} also appear on the record it
        points to. Turn it on only when regrouping old events after a reassignment is right.
      </Muted>
      {error ? <Notice error>{error}</Notice> : null}
    </Stack>
  );
}
