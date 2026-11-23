import {
  type BindingWriteStamp,
  bindableField,
  type ExtensionBinding,
  type ExtensionBindingPlan,
  type ExtensionManifest,
} from '@retainer/extension';
import { HIDDEN_TYPE_IDS } from '@retainer/shared';
import { AppError } from '../errors.js';
import type { FieldState, ObjectState, SchemaState } from '../schema/types.js';

export type StoredBinding = {
  objects: string[];
  fields: Record<string, { id: string; values: Record<string, string> }>;
};

export type StoredBindingPlan = {
  /** The release's reviewed contract, also available when the bundle is absent. */
  extension: string;
  declarations: ExtensionBinding[];
  createPeople: ExtensionManifest['createPeople'];
  destinations: Record<string, StoredBinding | null>;
};

export type BindingIssue = {
  binding: string;
  field?: string;
  message: string;
};

export function visibleObject(object: ObjectState, declaration: ExtensionBinding): boolean {
  return (
    object.status === 'active' &&
    object.class === declaration.class &&
    !HIDDEN_TYPE_IDS.has(object.universalId)
  );
}

export function eligibleField(field: FieldState, rule: ExtensionBinding['fields'][number]) {
  return field.status === 'active' && bindableField(field, rule);
}

export function createsRecords(
  declaration: ExtensionBinding,
  createPeople: StoredBindingPlan['createPeople'],
): boolean {
  return declaration.creates === true || (!!declaration.match && createPeople !== 'never');
}

/** A managed path may insert only through its own reviewed destination. */
export function requireBindingCreation(plan: StoredBindingPlan | null, key: string) {
  const declaration = plan?.declarations.find((entry) => entry.key === key);
  if (
    !plan?.destinations[key] ||
    !declaration ||
    declaration.access !== 'write' ||
    !createsRecords(declaration, plan.createPeople)
  ) {
    throw new AppError(
      409,
      'binding_unavailable',
      'The approved binding does not allow records to be created.',
    );
  }
}

export function validateBindingPlan(state: SchemaState, plan: StoredBindingPlan): BindingIssue[] {
  const issues: BindingIssue[] = [];
  const objects = new Map(state.objects.map((object) => [object.universalId, object]));
  for (const declaration of plan.declarations) {
    const binding = plan.destinations[declaration.key];
    const issue = (message: string, field?: string) =>
      issues.push({ binding: declaration.key, ...(field ? { field } : {}), message });
    if (!binding) {
      if (declaration.required) issue(`Choose a destination for ${declaration.label}.`);
      continue;
    }

    const many = declaration.class === 'event' && declaration.access === 'read';
    if (
      !binding.objects.length ||
      (!many && binding.objects.length !== 1) ||
      new Set(binding.objects).size !== binding.objects.length
    ) {
      issue(
        `Choose ${many ? 'one or more distinct event types' : 'one object'} for ${declaration.label}.`,
      );
      continue;
    }
    const targets = binding.objects.map((id) => objects.get(id));
    if (targets.some((object) => !object || !visibleObject(object, declaration))) {
      issue(
        `Choose an active ${declaration.class === 'event' ? 'event type' : 'object'} for ${declaration.label}.`,
      );
      continue;
    }

    const [object] = targets;
    if (!object) continue;
    const fields = new Map(object.fields.map((field) => [field.universalId, field]));
    const seen = new Map<string, boolean>();
    const supplied = new Set<string>();
    const creating = createsRecords(declaration, plan.createPeople);
    for (const rule of declaration.fields) {
      const choice = binding.fields[rule.key];
      if (!choice) {
        if (rule.required) issue(`Choose a field for ${rule.label}.`, rule.key);
        continue;
      }
      const field = fields.get(choice.id);
      if (!field || !eligibleField(field, rule) || targets.length !== 1) {
        issue(`Choose an active ${rule.types.join(' or ')} field for ${rule.label}.`, rule.key);
        continue;
      }
      const write =
        declaration.access === 'write' &&
        !rule.lookup &&
        (rule.key !== declaration.match || creating);
      if ((seen.has(choice.id) && write) || seen.get(choice.id)) {
        issue(
          `Choose a different field for ${rule.label}. ${field.label} is already used by this binding.`,
          rule.key,
        );
      }
      seen.set(choice.id, write);
      if (rule.required && write) supplied.add(choice.id);

      if (rule.key === declaration.match && plan.createPeople !== 'never' && !field.isUnique)
        issue(
          `Make ${field.label} unique before creating contacts through ${declaration.label}.`,
          rule.key,
        );

      if (rule.target) {
        const target = plan.destinations[rule.target]?.objects;
        if (
          target?.length !== 1 ||
          field.settings.targetObjectId !== target[0] ||
          field.settings.relationCardinality !== 'many_to_one'
        )
          issue(`${field.label} must link to the selected ${rule.target} object.`, rule.key);
      }

      for (const value of rule.values ?? []) {
        if (!field.settings.options?.some((option) => option.value === choice.values[value]))
          issue(`Choose an option in ${field.label} for “${value}”.`, rule.key);
      }
    }
    if (creating) {
      for (const field of object.fields) {
        if (
          field.status === 'active' &&
          !field.isNullable &&
          !field.coreRole &&
          !field.settings.isInverse &&
          !supplied.has(field.universalId)
        )
          issue(
            `${plan.extension} creates records without ${field.label}. Make ${field.label} optional?`,
          );
      }
    }
  }
  return issues;
}

export function presentBindingPlan(
  state: SchemaState,
  plan: StoredBindingPlan,
  revision: number,
): ExtensionBindingPlan {
  const issues = validateBindingPlan(state, plan);
  return {
    bindings_revision: revision,
    createPeople: plan.createPeople,
    bindings: Object.fromEntries(
      plan.declarations.map((declaration) => {
        const target = plan.destinations[declaration.key];
        if (!target) return [declaration.key, null];
        const objects = target.objects.flatMap((id) => {
          const object = state.objects.find(
            (entry) => entry.universalId === id && visibleObject(entry, declaration),
          );
          return object?.id ? [{ ...object, id: object.id }] : [];
        });
        const fields = Object.fromEntries(
          Object.entries(target.fields).flatMap(([key, choice]) => {
            const field = objects[0]?.fields.find(
              (entry) => entry.universalId === choice.id && entry.status === 'active',
            );
            return field?.id
              ? [
                  [
                    key,
                    {
                      id: field.id,
                      name: field.name,
                      label: field.label,
                      values: choice.values,
                    },
                  ],
                ]
              : [];
          }),
        );
        return [
          declaration.key,
          {
            status:
              objects.length < target.objects.length
                ? 'missing'
                : issues.some((issue) => issue.binding === declaration.key)
                  ? 'incompatible'
                  : 'ok',
            objects: objects.map((object) => ({
              id: object.id,
              name: object.nameSingular,
              label: object.labelSingular,
            })),
            fields,
          },
        ];
      }),
    ),
  };
}

/** Validated after credential admission, while the workspace's schema is stable. */
export function checkStandaloneBindingWrite(
  plan: StoredBindingPlan,
  revision: number,
  object: ObjectState,
  fields: readonly string[],
  stamp?: BindingWriteStamp,
  requirements: { lookups?: readonly string[]; create?: boolean } = {},
): boolean {
  if (!stamp || stamp.bindings_revision !== revision || stamp.objectId !== object.id) return false;
  return checkBindingWrite(plan, object, fields, { ...requirements, fieldIds: stamp.fieldIds });
}

export function checkBindingWrite(
  plan: StoredBindingPlan,
  object: ObjectState,
  fields: readonly string[],
  {
    lookups = [],
    create = false,
    fieldIds,
  }: {
    lookups?: readonly string[];
    create?: boolean;
    fieldIds?: BindingWriteStamp['fieldIds'];
  } = {},
): boolean {
  const selected = plan.declarations.filter(
    (declaration) =>
      declaration.access === 'write' &&
      (!create || createsRecords(declaration, plan.createPeople)) &&
      plan.destinations[declaration.key]?.objects.includes(object.universalId),
  );
  if (!selected.length) return false;
  const allowed = (name: string, write: boolean) => {
    const field = object.fields.find((field) => field.status === 'active' && field.name === name);
    return (
      !!field?.id &&
      (!fieldIds || fieldIds[name] === field.id) &&
      selected.some((declaration) =>
        declaration.fields.some(
          (rule) =>
            (!write ||
              (!rule.lookup &&
                (rule.key !== declaration.match ||
                  createsRecords(declaration, plan.createPeople)))) &&
            plan.destinations[declaration.key]?.fields[rule.key]?.id === field.universalId,
        ),
      )
    );
  };
  return (
    fields.every((name) => allowed(name, true)) && lookups.every((name) => allowed(name, false))
  );
}
