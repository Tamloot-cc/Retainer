import type {
  BindingWriteStamp,
  ExtensionBinding,
  ExtensionBindingPlan,
  ExtensionManifest,
} from '@retainer/extension';
import { HIDDEN_TYPE_IDS } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
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
  return (
    field.status === 'active' &&
    !field.coreRole &&
    !field.settings.isInverse &&
    rule.types.includes(field.type)
  );
}

export function createsRecords(
  declaration: ExtensionBinding,
  createPeople: StoredBindingPlan['createPeople'],
): boolean {
  return declaration.creates === true || (!!declaration.match && createPeople !== 'never');
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
): boolean {
  if (!stamp || stamp.bindings_revision !== revision || stamp.objectId !== object.id) return false;
  const selected = plan.declarations.filter(
    (declaration) =>
      declaration.access === 'write' &&
      plan.destinations[declaration.key]?.objects.includes(object.universalId),
  );
  if (!selected.length) return false;
  return fields.every((name) => {
    const field = object.fields.find((field) => field.status === 'active' && field.name === name);
    return (
      !!field?.id &&
      stamp.fieldIds[name] === field.id &&
      selected.some((declaration) =>
        declaration.fields.some(
          (rule) =>
            !rule.lookup &&
            plan.destinations[declaration.key]?.fields[rule.key]?.id === field.universalId,
        ),
      )
    );
  });
}

export async function installationOnlyFields(tx: Tx, workspaceId: string, objectId?: string) {
  const plans = await tx<{ id: string; bindings: StoredBindingPlan }[]>`
    select id, bindings from extension_installations
    where workspace_id = ${workspaceId} and state <> 'uninstalled' and bindings is not null
      ${
        objectId
          ? tx`and exists (
        select 1 from jsonb_each(bindings->'destinations') as entry
        where entry.value->'objects' ? ${objectId}
      )`
          : tx``
      }`;
  const owners = new Map<string, string>();
  for (const plan of plans) {
    for (const binding of plan.bindings.declarations) {
      const destination = plan.bindings.destinations[binding.key];
      if (!destination || (objectId && !destination.objects.includes(objectId))) continue;
      for (const field of binding.fields) {
        const id = destination.fields[field.key]?.id;
        if (field.installationOnly && id) owners.set(id, plan.id);
      }
    }
  }
  return owners;
}
