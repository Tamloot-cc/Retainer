import type { ExtensionBinding, ExtensionBindingChoices } from '@retainer/extension';
import type { ObjectView } from '@retainer/shared';
import { Input, Label, Muted, Notice, Stack } from '../../ui/index.js';

type Choice = ExtensionBindingChoices[string];
type FieldChoice = NonNullable<Exclude<Choice, { action: 'skip' }>['fields']>[string];

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

function bindingName(choice: Choice, objects: readonly ObjectView[], binding: ExtensionBinding) {
  if (choice.action === 'skip') return 'Skip';
  if (choice.action === 'create')
    return `Create ${choice.labelSingular ?? binding.create?.labelSingular ?? binding.label}`;
  return choice.objects
    .map((name) => objects.find((object) => object.nameSingular === name)?.labelPlural ?? name)
    .join(', ');
}

export function BindingSummary({
  declarations,
  choices,
  objects,
}: {
  declarations: ExtensionBinding[];
  choices: ExtensionBindingChoices;
  objects: readonly ObjectView[];
}) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-sm">
      {declarations.flatMap((binding) => {
        const choice = choices[binding.key];
        if (!choice) return [];
        return [
          <dt className="text-muted-foreground" key={`${binding.key}-label`}>
            {binding.label}
          </dt>,
          <dd key={binding.key}>
            {bindingName(choice, objects, binding)}
            {choice.action !== 'skip' && Object.keys(choice.fields ?? {}).length ? (
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {binding.fields.map((field) => {
                  const target = choice.fields?.[field.key];
                  return target ? (
                    <li key={field.key}>
                      {field.label} →{' '}
                      {target.action === 'existing'
                        ? target.field
                        : target.action === 'create'
                          ? `Create ${target.name ?? field.create?.label ?? field.label}`
                          : 'Skip'}
                    </li>
                  ) : null;
                })}
              </ul>
            ) : null}
          </dd>,
        ];
      })}
    </dl>
  );
}

export type BindingReviewIssue = { binding: string; field?: string; message: string };

export function BindingFields({
  declarations,
  choices,
  objects,
  issues,
  onChange,
}: {
  declarations: ExtensionBinding[];
  choices: ExtensionBindingChoices;
  objects: readonly ObjectView[];
  issues: BindingReviewIssue[];
  onChange: (key: string, choice: Choice) => void;
}) {
  return declarations.map((binding) => {
    const candidates = objects.filter((object) => (object.class ?? 'entity') === binding.class);
    const choice = choices[binding.key] ?? defaultChoice(binding, candidates);
    const object =
      choice.action === 'existing' && choice.objects.length === 1
        ? candidates.find((object) => object.nameSingular === choice.objects[0])
        : undefined;
    const destination = choice.action === 'existing' ? choice.objects[0] : choice.action;
    const many = binding.class === 'event' && binding.access === 'read';
    return (
      <fieldset key={binding.key} className="space-y-3 rounded-md border p-4">
        <legend className="px-1 font-medium">{binding.label}</legend>
        <Muted>{binding.description}</Muted>
        {many ? (
          <Label>
            Event types
            <select
              multiple
              className="w-full rounded-md border bg-background p-2"
              value={choice.action === 'existing' ? choice.objects : []}
              onChange={(event) => {
                const objects = Array.from(event.target.selectedOptions, (option) => option.value);
                onChange(
                  binding.key,
                  objects.length ? { action: 'existing', objects } : { action: 'skip' },
                );
              }}
            >
              {candidates.map((object) => (
                <option key={object.nameSingular} value={object.nameSingular}>
                  {object.labelPlural}
                </option>
              ))}
            </select>
          </Label>
        ) : (
          <Label>
            Destination
            <select
              className="h-9 rounded-md border bg-background px-2"
              value={destination ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'create' || value === 'skip')
                  onChange(binding.key, { action: value });
                else if (value) onChange(binding.key, { action: 'existing', objects: [value] });
              }}
            >
              {binding.required && choice.action === 'skip' ? (
                <option value="skip">Choose a destination</option>
              ) : null}
              {!binding.required ? <option value="skip">Skip</option> : null}
              {binding.create ? (
                <option value="create">Create {binding.create.labelSingular}</option>
              ) : null}
              {candidates
                .filter((object) => !binding.owned || object.nameSingular === destination)
                .map((object) => (
                  <option key={object.nameSingular} value={object.nameSingular}>
                    {object.labelPlural}
                  </option>
                ))}
            </select>
          </Label>
        )}
        {choice.action === 'create' && binding.create ? (
          <div className="grid grid-cols-2 gap-3">
            <Label>
              Singular API name
              <Input
                placeholder={binding.create.nameSingular}
                value={choice.nameSingular ?? ''}
                onChange={(event) =>
                  onChange(binding.key, {
                    ...choice,
                    nameSingular: event.target.value || undefined,
                  })
                }
              />
            </Label>
            <Label>
              Plural API name
              <Input
                placeholder={binding.create.namePlural}
                value={choice.namePlural ?? ''}
                onChange={(event) =>
                  onChange(binding.key, { ...choice, namePlural: event.target.value || undefined })
                }
              />
            </Label>
          </div>
        ) : null}
        {choice.action !== 'skip'
          ? binding.fields.map((field) => {
              const candidates =
                object?.fields.filter(
                  (entry) => !entry.readOnly && !entry.coreRole && field.types.includes(entry.type),
                ) ?? [];
              const suggested = candidates.find(
                (entry) =>
                  entry.name === (field.create?.name ?? field.key) || entry.label === field.label,
              );
              const canCreate = !!(
                field.create || binding.create?.fields.some((entry) => entry.name === field.key)
              );
              const selected: FieldChoice =
                choice.fields?.[field.key] ??
                (suggested && !field.owned
                  ? { action: 'existing', field: suggested.name }
                  : canCreate
                    ? { action: 'create' }
                    : { action: 'skip' });
              const target =
                selected.action === 'existing'
                  ? candidates.find((entry) => entry.name === selected.field)
                  : undefined;
              const update = (next: FieldChoice) =>
                onChange(binding.key, {
                  ...choice,
                  fields: { ...choice.fields, [field.key]: next },
                });
              return (
                <Stack key={field.key}>
                  <Label>
                    {field.label}
                    <select
                      className="h-9 rounded-md border bg-background px-2"
                      value={selected.action === 'existing' ? selected.field : selected.action}
                      onChange={(event) => {
                        const name = event.target.value;
                        update(
                          name === 'create' || name === 'skip'
                            ? { action: name }
                            : { action: 'existing', field: name },
                        );
                      }}
                    >
                      {!field.required || selected.action === 'skip' ? (
                        <option value="skip">{field.required ? 'Choose a field' : 'Skip'}</option>
                      ) : null}
                      {canCreate ? (
                        <option value="create">Create {field.create?.label ?? field.label}</option>
                      ) : null}
                      {candidates
                        .filter((entry) => !field.owned || entry === target)
                        .map((entry) => (
                          <option key={entry.name} value={entry.name}>
                            {entry.label}
                          </option>
                        ))}
                    </select>
                  </Label>
                  {selected.action !== 'skip' &&
                    field.values?.map((value) => {
                      const options =
                        target?.settings.options ?? field.create?.settings?.options ?? [];
                      const selectedValue = selected.values?.[value];
                      return (
                        <Label key={value}>
                          {field.label} value for {value}
                          <select
                            className="h-9 rounded-md border bg-background px-2"
                            value={
                              typeof selectedValue === 'string'
                                ? selectedValue
                                : selectedValue
                                  ? '__create'
                                  : options.some((option) => option.value === value)
                                    ? value
                                    : ''
                            }
                            onChange={(event) =>
                              update({
                                ...selected,
                                values: {
                                  ...selected.values,
                                  [value]:
                                    event.target.value === '__create'
                                      ? { value, label: value }
                                      : event.target.value,
                                },
                              })
                            }
                          >
                            <option value="">Use default</option>
                            {options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            <option value="__create">Add an option</option>
                          </select>
                          {typeof selectedValue === 'object' ? (
                            <Input
                              aria-label={`New option for ${value}`}
                              value={selectedValue.value}
                              onChange={(event) =>
                                update({
                                  ...selected,
                                  values: {
                                    ...selected.values,
                                    [value]: {
                                      value: event.target.value,
                                      label: event.target.value,
                                    },
                                  },
                                })
                              }
                            />
                          ) : null}
                        </Label>
                      );
                    })}
                  {issues
                    .filter((issue) => issue.binding === binding.key && issue.field === field.key)
                    .map((issue) => (
                      <Notice key={issue.message} error>
                        {issue.message}
                      </Notice>
                    ))}
                </Stack>
              );
            })
          : null}
        {issues
          .filter((issue) => issue.binding === binding.key && !issue.field)
          .map((issue) => (
            <Notice key={issue.message} error>
              {issue.message}
            </Notice>
          ))}
      </fieldset>
    );
  });
}
