import {
  type ExtensionBinding,
  type ExtensionBindingChoices,
  type ExtensionManifest,
  mergeBindingChoices,
} from '@retainer/extension';
import { AppError } from '../errors.js';
import {
  type BindingIssue,
  createsRecords,
  eligibleField,
  type StoredBindingPlan,
  validateBindingPlan,
  visibleObject,
} from '../extension-runtime/bindings.js';
import { type ObjectState, type SchemaState, SchemaValidationError } from '../schema/types.js';
import { deriveUuid } from '../schema-engine/apply.js';
import { planSchemaChange } from '../schema-engine/engine.js';
import type { FieldDefinitionInput, SchemaOperation } from '../schema-engine/operations.js';

type Choice = ExtensionBindingChoices[string];
type Field = ExtensionBinding['fields'][number];
type FieldChoice = NonNullable<Exclude<Choice, { action: 'skip' }>['fields']>[string];

function existingObject(state: SchemaState, declaration: ExtensionBinding, name: string) {
  return state.objects.find(
    (object) =>
      visibleObject(object, declaration) &&
      (object.nameSingular === name || object.namePlural === name),
  );
}

function defaultField(declaration: ExtensionBinding, field: Field, object?: ObjectState) {
  const name = field.create?.name ?? field.key;
  const found = object?.fields.find(
    (entry) => eligibleField(entry, field) && (entry.name === name || entry.label === field.label),
  );
  if (found && !field.owned) return { action: 'existing' as const, field: found.name };
  if (field.create || declaration.create?.fields.some((entry) => entry.name === name))
    return { action: 'create' as const };
  return { action: 'skip' as const };
}

function defaultChoice(state: SchemaState, declaration: ExtensionBinding): Choice {
  const object =
    !declaration.owned &&
    state.objects.find(
      (object) =>
        visibleObject(object, declaration) &&
        (object.nameSingular === (declaration.create?.nameSingular ?? declaration.key) ||
          object.labelPlural === declaration.label ||
          object.labelSingular === declaration.create?.labelSingular) &&
        declaration.fields.every(
          (field) => !field.required || defaultField(declaration, field, object).action !== 'skip',
        ),
    );
  if (object) return { action: 'existing', objects: [object.nameSingular] };
  return declaration.required && declaration.create ? { action: 'create' } : { action: 'skip' };
}

function fromPrior(state: SchemaState, declaration: ExtensionBinding, prior: StoredBindingPlan) {
  const destination = prior.destinations[declaration.key];
  if (destination === null && !declaration.required) return { action: 'skip' } as const;
  const objects = destination?.objects.flatMap((id) => {
    const object = state.objects.find(
      (entry) => entry.universalId === id && visibleObject(entry, declaration),
    );
    return object ? [object] : [];
  });
  if (!destination || !objects?.length || objects.length !== destination.objects.length) return;
  const priorDeclaration = prior.declarations.find((entry) => entry.key === declaration.key);
  const fields = Object.fromEntries(
    declaration.fields.flatMap<[string, FieldChoice]>((rule) => {
      const choice = destination.fields[rule.key];
      if (!choice)
        return priorDeclaration?.fields.some((field) => field.key === rule.key) && !rule.required
          ? [[rule.key, { action: 'skip' as const }]]
          : [];
      const field = objects[0]?.fields.find(
        (entry) => entry.universalId === choice.id && eligibleField(entry, rule),
      );
      if (
        !field ||
        (rule.values ?? []).some(
          (value) =>
            !field.settings.options?.some((option) => option.value === choice.values[value]),
        )
      )
        return [];
      return [
        [rule.key, { action: 'existing' as const, field: field.name, values: choice.values }],
      ];
    }),
  );

  return {
    action: 'existing' as const,
    objects: objects.map((object) => object.nameSingular),
    fields,
  };
}

export function bindingChoicesFromPlan(
  state: SchemaState,
  plan: StoredBindingPlan,
): ExtensionBindingChoices {
  return Object.fromEntries(
    plan.declarations.flatMap((declaration) => {
      const choice = fromPrior(state, declaration, plan);
      return choice ? [[declaration.key, choice]] : [];
    }),
  );
}

const titleCase = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1);
const bindingError = (issues: BindingIssue[]) =>
  new AppError(422, 'bindings_invalid', issues.map((issue) => issue.message).join(' '), {
    bindings: issues,
  });

function publisherPresentation<T extends string>(
  keys: readonly T[],
  before: Partial<Record<T, string>>,
  next: Partial<Record<T, string>>,
  live: Partial<Record<T, string | null>>,
  element: string,
  notices: string[],
): Partial<Record<T, string>> {
  const changes: Partial<Record<T, string>> = {};
  for (const key of keys) {
    if (before[key] === next[key] || live[key] === next[key] || next[key] === undefined) continue;
    if ((live[key] ?? '') === (before[key] ?? '')) changes[key] = next[key];
    else {
      const attribute = key === 'description' ? 'description' : 'label';
      notices.push(`${element} keeps the ${attribute} set in this workspace.`);
    }
  }
  return changes;
}

export function resolveBindingPlan(
  state: SchemaState,
  manifest: ExtensionManifest,
  choices: ExtensionBindingChoices | undefined,
  prior: StoredBindingPlan | null | undefined,
  createPeople: StoredBindingPlan['createPeople'],
) {
  const declarations = manifest.bindings ?? [];
  const plan: StoredBindingPlan = {
    extension: titleCase(manifest.name.replaceAll('-', ' ')),
    declarations,
    createPeople,
    destinations: {},
  };
  const review: ExtensionBindingChoices = {};
  const inserts: SchemaOperation[] = [];
  const edits: SchemaOperation[] = [];
  const relations: SchemaOperation[] = [];
  const contributions: { kind: 'object' | 'field'; id: string; definition: unknown }[] = [];
  const issues: BindingIssue[] = [];
  const notices: string[] = [];
  const usedIds = new Set(
    state.objects.flatMap((object) => [
      object.universalId,
      ...object.fields.map((field) => field.universalId),
    ]),
  );
  const usedNames = new Set(
    state.objects
      .filter((object) => object.status === 'active')
      .flatMap((object) => [object.nameSingular.toLowerCase(), object.namePlural.toLowerCase()]),
  );
  const nextId = (suggested: string) => {
    let id = suggested;
    for (let n = 2; usedIds.has(id); n++) id = deriveUuid(`${suggested}:${n}`);
    usedIds.add(id);
    return id;
  };
  const created = new Map<
    string,
    { id: string; operation: Extract<SchemaOperation, { op: 'create_object' }> }
  >();

  for (const key of Object.keys(choices ?? {})) {
    if (!declarations.some((binding) => binding.key === key))
      issues.push({
        binding: key,
        message: `This release does not declare a binding named ${key}.`,
      });
  }

  for (const declaration of declarations) {
    const key = declaration.key;
    const previous = prior && fromPrior(state, declaration, prior);
    const choice = structuredClone(
      mergeBindingChoices(
        previous && { [key]: previous },
        choices?.[key] && { [key]: choices[key] },
      )[key] ?? defaultChoice(state, declaration),
    );
    review[key] = choice;
    if (choice.action === 'skip') {
      plan.destinations[key] = null;
      continue;
    }
    if (choice.action === 'existing') {
      const ids = choice.objects.flatMap((name) => {
        const target = existingObject(state, declaration, name);
        if (
          !target ||
          (declaration.owned && !prior?.destinations[key]?.objects.includes(target.universalId))
        ) {
          issues.push({
            binding: key,
            message: `Choose an eligible destination for ${declaration.label}.`,
          });
          return [];
        }
        return [target.universalId];
      });
      plan.destinations[key] = { objects: ids, fields: {} };
      continue;
    }
    const suggestion = declaration.create;
    if (!suggestion) {
      issues.push({ binding: key, message: `${declaration.label} needs an existing destination.` });
      continue;
    }
    const prefix = manifest.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    let singular = choice.nameSingular ?? suggestion.nameSingular;
    let plural = choice.namePlural ?? suggestion.namePlural;
    let labelSingular = choice.labelSingular ?? suggestion.labelSingular;
    let labelPlural = choice.labelPlural ?? suggestion.labelPlural;
    const taken = (name: string) => usedNames.has(name.toLowerCase());
    if ((taken(singular) || taken(plural)) && !choice.nameSingular && !choice.namePlural) {
      singular = prefix + titleCase(singular);
      plural = prefix + titleCase(plural);
      labelSingular += ` (${plan.extension})`;
      labelPlural += ` (${plan.extension})`;
      const base = { singular, plural };
      for (let n = 2; taken(singular) || taken(plural); n++) {
        singular = base.singular + n;
        plural = base.plural + n;
      }
    }
    if (taken(singular) || taken(plural))
      issues.push({ binding: key, message: `Choose an unused API name for ${declaration.label}.` });
    usedNames.add(singular.toLowerCase());
    usedNames.add(plural.toLowerCase());
    const id = nextId(suggestion.universalId);
    const operation = {
      op: 'create_object' as const,
      object: {
        ...suggestion,
        class: declaration.class,
        universalId: id,
        nameSingular: singular,
        namePlural: plural,
        labelSingular,
        labelPlural,
        fields: [] as FieldDefinitionInput[],
      },
    };
    created.set(key, { id, operation });
    inserts.push(operation);
    review[key] = {
      ...choice,
      nameSingular: singular,
      namePlural: plural,
      labelSingular,
      labelPlural,
    };
    plan.destinations[key] = { objects: [id], fields: {} };
    if (declaration.owned) contributions.push({ kind: 'object', id, definition: operation.object });
  }

  for (const declaration of declarations) {
    const key = declaration.key;
    const destination = plan.destinations[key];
    const choice = review[key];
    if (!destination || destination.objects.length !== 1 || !choice || choice.action === 'skip')
      continue;
    const [objectId] = destination.objects;
    if (!objectId) continue;
    const object = state.objects.find((entry) => entry.universalId === objectId);
    const priorDeclaration = prior?.declarations.find((entry) => entry.key === key);
    if (
      object &&
      declaration.owned &&
      priorDeclaration?.create &&
      declaration.create &&
      prior?.destinations[key]?.objects.includes(objectId)
    ) {
      const next = declaration.create;
      const changes = publisherPresentation(
        ['labelSingular', 'labelPlural', 'description'],
        priorDeclaration.create,
        next,
        object,
        `Object ${object.nameSingular}`,
        notices,
      );
      if (Object.keys(changes).length)
        edits.push({ op: 'update_object', object: objectId, ...changes });
      contributions.push({ kind: 'object', id: objectId, definition: next });
    }
    const creation = created.get(key);
    const creating = createsRecords(declaration, createPeople);
    const supplied = new Set<string>();
    const resolvedChoices: NonNullable<typeof choice.fields> = {};
    for (const fieldKey of Object.keys(choice.fields ?? {})) {
      if (!declaration.fields.some((field) => field.key === fieldKey))
        issues.push({
          binding: key,
          field: fieldKey,
          message: `This release does not declare ${key}.${fieldKey}.`,
        });
    }
    for (const rule of declaration.fields) {
      const fieldChoice =
        choice.fields?.[rule.key] ??
        (rule.target && !plan.destinations[rule.target] && !rule.required
          ? { action: 'skip' }
          : defaultField(declaration, rule, object));
      resolvedChoices[rule.key] = fieldChoice;
      if (fieldChoice.action === 'skip') continue;
      const suggestion =
        rule.create ?? declaration.create?.fields.find((field) => field.name === rule.key);
      const target =
        fieldChoice.action === 'existing'
          ? object?.fields.find(
              (field) => field.name === fieldChoice.field && eligibleField(field, rule),
            )
          : undefined;
      if (
        fieldChoice.action === 'existing' &&
        (!target ||
          (rule.owned && prior?.destinations[key]?.fields[rule.key]?.id !== target.universalId))
      ) {
        issues.push({
          binding: key,
          field: rule.key,
          message: `Choose an eligible field for ${rule.label}.`,
        });
        continue;
      }
      const unique = rule.key === declaration.match && createPeople !== 'never';
      const fieldId =
        target?.universalId ??
        (suggestion && nextId(deriveUuid(`${objectId}:${suggestion.universalId}`)));
      if (!fieldId || (!target && !suggestion)) {
        issues.push({
          binding: key,
          field: rule.key,
          message: `Choose an existing field for ${rule.label}.`,
        });
        continue;
      }

      const values: Record<string, string> = {};
      const options = [...(target?.settings.options ?? suggestion?.settings?.options ?? [])];
      for (const value of rule.values ?? []) {
        const selected =
          ('values' in fieldChoice ? fieldChoice.values?.[value] : undefined) ??
          (options.some((option) => option.value === value)
            ? value
            : suggestion?.settings?.options?.find((option) => option.value === value));
        if (
          selected &&
          typeof selected !== 'string' &&
          !options.some((option) => option.value === selected.value)
        ) {
          options.push(selected);
          if (target)
            edits.push({ op: 'add_option', object: objectId, field: fieldId, option: selected });
        }
        values[value] = typeof selected === 'string' ? selected : (selected?.value ?? value);
      }
      destination.fields[rule.key] = { id: fieldId, values };
      if (rule.required && !rule.lookup) supplied.add(fieldId);
      if (target) {
        const previous = priorDeclaration?.fields.find((field) => field.key === rule.key)?.create;
        if (
          previous &&
          suggestion &&
          (rule.owned || declaration.owned) &&
          prior?.destinations[key]?.fields[rule.key]?.id === target.universalId
        ) {
          const changes = publisherPresentation(
            ['label', 'description'],
            previous,
            suggestion,
            target,
            `Field ${target.name}`,
            notices,
          );
          if (Object.keys(changes).length)
            edits.push({ op: 'update_field', object: objectId, field: fieldId, ...changes });
          contributions.push({ kind: 'field', id: fieldId, definition: suggestion });
        }
        if (unique && !target.isUnique)
          edits.push({ op: 'update_field', object: objectId, field: fieldId, isUnique: true });
      } else if (suggestion) {
        const relationTarget = rule.target ? plan.destinations[rule.target]?.objects[0] : undefined;
        const definition = {
          ...suggestion,
          universalId: fieldId,
          name: 'name' in fieldChoice ? (fieldChoice.name ?? suggestion.name) : suggestion.name,
          isNullable: creating && !rule.required ? true : suggestion.isNullable,
          ...(unique ? { isUnique: true } : {}),
          settings: {
            ...suggestion.settings,
            ...(rule.values ? { options } : {}),
            ...(rule.target ? { targetObject: relationTarget } : {}),
          },
        };
        if (definition.type === 'relation')
          relations.push({ op: 'create_field', object: objectId, field: definition });
        else if (creation) {
          creation.operation.object.fields.push(definition);
          if (creation.operation.object.labelField === suggestion.name)
            creation.operation.object.labelField = definition.name;
        } else edits.push({ op: 'create_field', object: objectId, field: definition });
        if (rule.owned || declaration.owned)
          contributions.push({ kind: 'field', id: fieldId, definition });
      }
    }
    if (object && creating) {
      for (const field of object.fields) {
        if (
          field.status === 'active' &&
          !field.isNullable &&
          !field.coreRole &&
          !field.settings.isInverse &&
          !supplied.has(field.universalId)
        )
          edits.push({
            op: 'update_field',
            object: objectId,
            field: field.universalId,
            isNullable: true,
          });
      }
    }
    choice.fields = resolvedChoices;
  }

  if (issues.length) throw bindingError(issues);
  const operations = [...inserts, ...edits, ...relations];
  let desired: SchemaState;
  try {
    desired = planSchemaChange(state, operations, 'workspace').desired;
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) throw error;
    const findings = error.issues.map((issue) => {
      const key =
        Object.keys(plan.destinations).find((key) => {
          const choice = review[key];
          const names =
            choice?.action === 'existing'
              ? choice.objects
              : choice?.action === 'create'
                ? [choice.nameSingular]
                : [];
          return names.some(
            (name) => name && (issue.path === name || issue.path.startsWith(`${name}.`)),
          );
        }) ?? '*';
      return { binding: key, message: `${issue.path}: ${issue.message}` };
    });
    throw bindingError(findings);
  }
  const unmet = validateBindingPlan(desired, plan);
  if (unmet.length) throw bindingError(unmet);
  return { plan, operations, review, contributions, notices };
}
