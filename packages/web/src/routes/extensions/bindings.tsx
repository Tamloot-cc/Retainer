import type { ExtensionBinding, ExtensionBindingChoices } from '@retainer/extension';
import type { FieldView, ObjectView } from '@retainer/shared';
import { Ban, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Destination,
  FieldDisclosure,
  FieldMap,
  FieldMapRow,
  IconLabel,
  Input,
  Label,
  MappingCard,
  MappingList,
  MappingNote,
  Notice,
  ObjectIcon,
  objectIcon,
  type PickerOption,
  Row,
  SelectMenu,
  SuggestionNote,
  TextButton,
} from '../../ui/index.js';

/**
 * Where an extension's data goes, in plain words: each kind of record it
 * imports (a binding) points at a list in the workspace, and each of its
 * fields at a field there. The form and the summaries share one shape.
 */

type Choice = ExtensionBindingChoices[string];
type FieldChoice = NonNullable<Exclude<Choice, { action: 'skip' }>['fields']>[string];
type Rule = ExtensionBinding['fields'][number];
export type BindingReviewIssue = { binding: string; field?: string; message: string };

/** Menu values that aren't API names. */
const CREATE = '__create',
  SKIP = '__skip';

const candidatesFor = (binding: ExtensionBinding, objects: readonly ObjectView[]) =>
  objects.filter((object) => (object.class ?? 'entity') === binding.class);

function defaultChoice(binding: ExtensionBinding, objects: readonly ObjectView[]): Choice {
  const existing =
    !binding.owned &&
    objects.find(
      (object) =>
        object.nameSingular === (binding.create?.nameSingular ?? binding.key) ||
        object.labelPlural === binding.label ||
        object.labelSingular === binding.create?.labelSingular,
    );
  return existing
    ? { action: 'existing', objects: [existing.nameSingular] }
    : binding.required && binding.create
      ? { action: 'create' }
      : { action: 'skip' };
}

const fieldCandidates = (object: ObjectView | undefined, rule: Rule) =>
  object?.fields.filter(
    (entry) => !entry.readOnly && !entry.coreRole && rule.types.includes(entry.type),
  ) ?? [];
const canCreateField = (binding: ExtensionBinding, rule: Rule) =>
  !!(rule.create || binding.create?.fields.some((entry) => entry.name === rule.key));

function defaultField(binding: ExtensionBinding, rule: Rule, object?: ObjectView): FieldChoice {
  const suggested = fieldCandidates(object, rule).find(
    (entry) => entry.name === (rule.create?.name ?? rule.key) || entry.label === rule.label,
  );
  if (suggested && !rule.owned) return { action: 'existing', field: suggested.name };
  return canCreateField(binding, rule) ? { action: 'create' } : { action: 'skip' };
}

/** The extension's own name for one of its values, such as "Open" for `open`. */
const valueLabel = (rule: Rule, value: string) =>
  rule.create?.settings?.options?.find((option) => option.value === value)?.label ??
  value.charAt(0).toUpperCase() + value.slice(1);

/** The workspace option a value goes to, or undefined when none is set. */
function valueTarget(
  choice: FieldChoice,
  value: string,
  options: FieldView['settings']['options'],
) {
  if (choice.action === 'skip') return undefined;
  const picked = choice.values?.[value];
  if (typeof picked === 'object') return { label: `New option “${picked.label}”`, value: CREATE };
  const name = picked ?? (options?.some((option) => option.value === value) ? value : undefined);
  const option = options?.find((entry) => entry.value === name);
  return name ? { label: option?.label ?? name, value: name } : undefined;
}

const objectLabel = (objects: readonly ObjectView[], name: string) =>
  objects.find((object) => object.nameSingular === name)?.labelPlural ?? name;
const newListLabel = (binding: ExtensionBinding, choice: Choice) =>
  choice.action === 'create'
    ? (choice.labelPlural ?? binding.create?.labelPlural ?? binding.label)
    : binding.label;

function fieldTargetLabel(rule: Rule, choice: FieldChoice, object?: ObjectView) {
  if (choice.action === 'skip') return 'Not imported';
  if (choice.action === 'create') return `New field “${rule.create?.label ?? rule.label}”`;
  return object?.fields.find((field) => field.name === choice.field)?.label ?? choice.field;
}

/** "Title → Title · Status → Status (Open → To do, Done → Done)", for a folded field list. */
function fieldsSummary(
  binding: ExtensionBinding,
  fields: Record<string, FieldChoice>,
  object?: ObjectView,
) {
  return binding.fields
    .flatMap((rule) => {
      const choice = fields[rule.key];
      if (!choice) return [];
      const target = fieldTargetLabel(rule, choice, object);
      const options =
        choice.action === 'existing'
          ? object?.fields.find((field) => field.name === choice.field)?.settings.options
          : undefined;
      const values =
        choice.action === 'existing' && rule.values?.length
          ? ` (${rule.values
              .map(
                (value) =>
                  `${valueLabel(rule, value)} → ${valueTarget(choice, value, options)?.label ?? 'not set'}`,
              )
              .join(', ')})`
          : '';
      return [`${rule.label} → ${target}${values}`];
    })
    .join(' · ');
}

/** Whether a choice still is what was suggested, so the suggestion's reason applies to it. */
function sameDestination(a: Choice | undefined, b: Choice | undefined) {
  if (!a || !b || a.action !== b.action) return false;
  return a.action !== 'existing' || b.action !== 'existing'
    ? true
    : a.objects.join() === b.objects.join();
}
function sameField(a: FieldChoice | undefined, b: FieldChoice | undefined) {
  if (!a || !b || a.action !== b.action) return false;
  if (a.action === 'existing' && b.action === 'existing' && a.field !== b.field) return false;
  const values = (c: FieldChoice) => JSON.stringify(c.action === 'skip' ? {} : (c.values ?? {}));
  return b.action === 'skip' || !b.values || values(a) === values(b);
}

/** The icon of the kind of record a binding imports. */
const BindingIcon = ({ binding }: { binding: ExtensionBinding }) => (
  <ObjectIcon name={binding.create?.nameSingular ?? binding.key} objectClass={binding.class} />
);

/**
 * The approved or proposed plan as text: each kind of record and the list it
 * goes to, with its fields. `plain` drops the cards' frames inside another card.
 */
export function BindingSummary({
  extension,
  declarations,
  choices,
  objects,
  plain = true,
}: {
  /** The extension's display name, heading the column of its fields. */
  extension: string;
  declarations: ExtensionBinding[];
  choices: ExtensionBindingChoices;
  objects: readonly ObjectView[];
  plain?: boolean;
}) {
  return (
    <MappingList label="Where data goes" plain={plain}>
      {declarations.map((binding) => {
        const choice = choices[binding.key];
        return choice ? (
          <SummaryCard
            key={binding.key}
            extension={extension}
            binding={binding}
            choice={choice}
            objects={objects}
          />
        ) : null;
      })}
    </MappingList>
  );
}

/** Where one kind of record goes, as text. */
function SummaryDestination({
  binding,
  choice,
  objects,
}: {
  binding: ExtensionBinding;
  choice: Choice;
  objects: readonly ObjectView[];
}) {
  if (choice.action === 'skip') return <Destination>Not imported</Destination>;
  if (choice.action === 'create')
    return (
      <Destination
        icon={<BindingIcon binding={binding} />}
        badge={<Badge tone="success">New</Badge>}
      >
        {newListLabel(binding, choice)}
      </Destination>
    );
  return (
    <Destination
      icon={
        choice.objects.length === 1 ? (
          <ObjectIcon name={choice.objects[0] ?? ''} objectClass={binding.class} />
        ) : undefined
      }
    >
      {choice.objects.map((name) => objectLabel(objects, name)).join(', ')}
    </Destination>
  );
}

function SummaryCard({
  extension,
  binding,
  choice,
  objects,
}: {
  extension: string;
  binding: ExtensionBinding;
  choice: Choice;
  objects: readonly ObjectView[];
}) {
  const object =
    choice.action === 'existing' && choice.objects.length === 1
      ? objects.find((entry) => entry.nameSingular === choice.objects[0])
      : undefined;
  const fields = choice.action === 'skip' ? {} : (choice.fields ?? {});
  const rows = binding.fields.filter((rule) => fields[rule.key]);
  return (
    <MappingCard
      icon={<BindingIcon binding={binding} />}
      title={binding.label}
      destination={<SummaryDestination binding={binding} choice={choice} objects={objects} />}
    >
      {rows.length ? (
        <FieldMap from={extension} to={object?.labelPlural ?? newListLabel(binding, choice)}>
          {rows.map((rule) => (
            <SummaryField
              key={rule.key}
              rule={rule}
              choice={fields[rule.key] as FieldChoice}
              object={object}
            />
          ))}
        </FieldMap>
      ) : null}
    </MappingCard>
  );
}

/** One field as text, then its values when it maps them onto an existing field. */
function SummaryField({
  rule,
  choice,
  object,
}: {
  rule: Rule;
  choice: FieldChoice;
  object?: ObjectView;
}) {
  const options =
    choice.action === 'existing'
      ? object?.fields.find((field) => field.name === choice.field)?.settings.options
      : undefined;
  return (
    <>
      <FieldMapRow label={rule.label}>{fieldTargetLabel(rule, choice, object)}</FieldMapRow>
      {choice.action === 'existing'
        ? (rule.values ?? []).map((value) => (
            <FieldMapRow key={value} label={valueLabel(rule, value)} nested>
              {valueTarget(choice, value, options)?.label ?? 'Not set'}
            </FieldMapRow>
          ))
        : null}
    </>
  );
}

/** The form: one card per kind of record, each with where it goes and, folded, its fields. */
export function BindingFields({
  extension,
  declarations,
  choices,
  objects,
  issues,
  suggested,
  reasons,
  onChange,
}: {
  /** The extension's display name, for the plain-words copy. */
  extension: string;
  declarations: ExtensionBinding[];
  choices: ExtensionBindingChoices;
  objects: readonly ObjectView[];
  issues: BindingReviewIssue[];
  /** What the extension suggested; its reasons show only while a choice still matches. */
  suggested?: ExtensionBindingChoices;
  reasons?: Record<string, string>;
  onChange: (key: string, choice: Choice) => void;
}) {
  return (
    <MappingList label={`Where ${extension} saves data`}>
      {declarations.map((binding) => (
        <BindingCard
          key={binding.key}
          extension={extension}
          binding={binding}
          choice={choices[binding.key] ?? defaultChoice(binding, candidatesFor(binding, objects))}
          objects={objects}
          issues={issues.filter((issue) => issue.binding === binding.key)}
          suggested={suggested?.[binding.key]}
          reasons={reasons ?? {}}
          onChange={(choice) => onChange(binding.key, choice)}
        />
      ))}
    </MappingList>
  );
}

function BindingCard({
  extension,
  binding,
  choice,
  objects,
  issues,
  suggested,
  reasons,
  onChange,
}: {
  extension: string;
  binding: ExtensionBinding;
  choice: Choice;
  objects: readonly ObjectView[];
  issues: BindingReviewIssue[];
  suggested?: Choice;
  reasons: Record<string, string>;
  onChange: (choice: Choice) => void;
}) {
  const candidates = candidatesFor(binding, objects);
  const object =
    choice.action === 'existing' && choice.objects.length === 1
      ? candidates.find((entry) => entry.nameSingular === choice.objects[0])
      : undefined;
  const many = binding.class === 'event' && binding.access === 'read';
  const fields = Object.fromEntries(
    binding.fields.map((rule) => [
      rule.key,
      (choice.action === 'existing' ? choice.fields?.[rule.key] : undefined) ??
        defaultField(binding, rule, object),
    ]),
  ) as Record<string, FieldChoice>;
  // A field that needs a choice, or that the server flagged, opens the list.
  const attention =
    issues.some((issue) => issue.field) ||
    binding.fields.some((rule) => rule.required && fields[rule.key]?.action === 'skip');
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const label = binding.label.toLowerCase();
  const reason = sameDestination(choice, suggested) ? reasons[binding.key] : undefined;
  const suggestedFields = suggested && suggested.action !== 'skip' ? suggested.fields : undefined;

  const options: PickerOption[] = [
    ...candidates
      .filter(
        (entry) =>
          !binding.owned ||
          (choice.action === 'existing' && entry.nameSingular === choice.objects[0]),
      )
      .map((entry) => ({
        value: entry.nameSingular,
        label: entry.labelPlural,
        content: (
          <IconLabel icon={objectIcon(entry.nameSingular, binding.class)}>
            {entry.labelPlural}
          </IconLabel>
        ),
      })),
    ...(binding.create
      ? [
          {
            value: CREATE,
            label: `New list: ${binding.create.labelPlural}`,
            content: <IconLabel icon={Plus}>New list: {binding.create.labelPlural}</IconLabel>,
          },
        ]
      : []),
    ...(!binding.required
      ? [
          {
            value: SKIP,
            label: 'Don’t import',
            content: <IconLabel icon={Ban}>Don’t import</IconLabel>,
          },
        ]
      : []),
  ];
  const destination = many ? (
    <SelectMenu
      multiple
      fill
      label={`Event types ${extension} reads`}
      placeholder="Choose event types"
      options={options.filter((option) => option.value !== CREATE && option.value !== SKIP)}
      value={choice.action === 'existing' ? choice.objects : []}
      onChange={(names) =>
        onChange(names.length ? { action: 'existing', objects: names } : { action: 'skip' })
      }
    />
  ) : (
    <SelectMenu
      fill
      label={`Where ${label} go`}
      placeholder="Choose a list"
      options={options}
      value={
        choice.action === 'existing'
          ? (choice.objects[0] ?? null)
          : choice.action === 'create'
            ? CREATE
            : binding.required
              ? null
              : SKIP
      }
      onChange={(value) =>
        onChange(
          value === CREATE
            ? { action: 'create' }
            : value === SKIP
              ? { action: 'skip' }
              : { action: 'existing', objects: [value] },
        )
      }
    />
  );

  const create = choice.action === 'create' ? choice : undefined;
  const note = (
    <>
      {reason ? <SuggestionNote>{reason}</SuggestionNote> : null}
      {create && binding.create ? (
        <MappingNote>
          Adds a new list, {create.labelPlural ?? binding.create.labelPlural}, to your workspace.{' '}
          <TextButton onClick={() => setRenaming(!renaming)}>
            {renaming ? 'Keep the name' : 'Change its API name'}
          </TextButton>
        </MappingNote>
      ) : null}
      {create && binding.create && renaming ? (
        <Row>
          <Label quiet>
            API name
            <Input
              placeholder={binding.create.nameSingular}
              value={create.nameSingular ?? ''}
              onChange={(event) =>
                onChange({ ...create, nameSingular: event.target.value || undefined })
              }
            />
          </Label>
          <Label quiet>
            Plural API name
            <Input
              placeholder={binding.create.namePlural}
              value={create.namePlural ?? ''}
              onChange={(event) =>
                onChange({ ...create, namePlural: event.target.value || undefined })
              }
            />
          </Label>
        </Row>
      ) : null}
      {choice.action === 'skip' && !binding.required ? (
        <MappingNote>
          {extension} won’t import {label}.
        </MappingNote>
      ) : null}
      {issues
        .filter((issue) => !issue.field)
        .map((issue) => (
          <Notice key={issue.message} error>
            {issue.message}
          </Notice>
        ))}
    </>
  );
  const hasNote =
    !!reason ||
    !!create ||
    (choice.action === 'skip' && !binding.required) ||
    issues.some((issue) => !issue.field);

  return (
    <MappingCard
      icon={<BindingIcon binding={binding} />}
      title={binding.label}
      description={binding.description}
      destination={destination}
      note={hasNote ? note : undefined}
    >
      {choice.action === 'existing' && object && binding.fields.length ? (
        <FieldDisclosure
          label="Fields"
          summary={fieldsSummary(binding, fields, object)}
          open={open || attention}
          onToggle={() => setOpen(!(open || attention))}
        >
          <FieldMap from={extension} to={object.labelPlural}>
            {binding.fields.flatMap((rule) =>
              fieldRows({
                binding,
                rule,
                object,
                selected: fields[rule.key] as FieldChoice,
                reason: sameField(fields[rule.key], suggestedFields?.[rule.key])
                  ? reasons[`${binding.key}.${rule.key}`]
                  : undefined,
                issues: issues.filter((issue) => issue.field === rule.key),
                update: (next) =>
                  onChange({ ...choice, fields: { ...choice.fields, [rule.key]: next } }),
              }),
            )}
          </FieldMap>
        </FieldDisclosure>
      ) : null}
    </MappingCard>
  );
}

/** One field's row, then a nested row per value it maps, such as each status. */
function fieldRows({
  binding,
  rule,
  object,
  selected,
  reason,
  issues,
  update,
}: {
  binding: ExtensionBinding;
  rule: Rule;
  object: ObjectView;
  selected: FieldChoice;
  reason?: string;
  issues: BindingReviewIssue[];
  update: (next: FieldChoice) => void;
}) {
  const candidates = fieldCandidates(object, rule);
  const target =
    selected.action === 'existing'
      ? candidates.find((entry) => entry.name === selected.field)
      : undefined;
  const canCreate = canCreateField(binding, rule);
  const options: PickerOption[] = [
    ...candidates
      .filter((entry) => !rule.owned || entry === target)
      .map((entry) => ({ value: entry.name, label: entry.label })),
    ...(canCreate
      ? [
          {
            value: CREATE,
            label: `New field: ${rule.create?.label ?? rule.label}`,
            content: (
              <IconLabel icon={Plus}>New field: {rule.create?.label ?? rule.label}</IconLabel>
            ),
          },
        ]
      : []),
    ...(!rule.required
      ? [
          {
            value: SKIP,
            label: 'Don’t import',
            content: <IconLabel icon={Ban}>Don’t import</IconLabel>,
          },
        ]
      : []),
  ];
  const note =
    reason || rule.description ? (
      <>
        {reason ? <SuggestionNote>{reason}</SuggestionNote> : null}
        {!reason && rule.description ? <MappingNote>{rule.description}</MappingNote> : null}
      </>
    ) : undefined;
  const rows = [
    <FieldMapRow
      key={rule.key}
      label={rule.label}
      note={note}
      error={
        issues.length
          ? issues.map((issue) => (
              <Notice key={issue.message} error>
                {issue.message}
              </Notice>
            ))
          : undefined
      }
    >
      <SelectMenu
        fill
        size="small"
        label={rule.label}
        placeholder="Choose a field"
        options={options}
        value={
          selected.action === 'existing'
            ? selected.field
            : selected.action === 'create'
              ? CREATE
              : rule.required
                ? null
                : SKIP
        }
        onChange={(value) =>
          update(
            value === CREATE
              ? { action: 'create' }
              : value === SKIP
                ? { action: 'skip' }
                : { action: 'existing', field: value },
          )
        }
      />
    </FieldMapRow>,
  ];
  // A new field gets the extension's own options; only an existing one needs its values matched.
  if (selected.action !== 'existing') return rows;
  const fieldOptions = target?.settings.options ?? [];
  for (const value of rule.values ?? []) {
    const name = valueLabel(rule, value);
    const current = valueTarget(selected, value, fieldOptions);
    rows.push(
      <FieldMapRow key={`${rule.key}.${value}`} label={name} nested>
        <SelectMenu
          fill
          size="small"
          label={`${rule.label}: ${name}`}
          placeholder="Choose an option"
          options={[
            ...fieldOptions.map((option) => ({ value: option.value, label: option.label })),
            {
              value: CREATE,
              label: `Add “${name}” as an option`,
              content: <IconLabel icon={Plus}>Add “{name}” as an option</IconLabel>,
            },
          ]}
          value={current?.value ?? null}
          onChange={(picked) =>
            update({
              ...selected,
              values: {
                ...selected.values,
                [value]: picked === CREATE ? { value, label: name } : picked,
              },
            })
          }
        />
      </FieldMapRow>,
    );
  }
  return rows;
}
