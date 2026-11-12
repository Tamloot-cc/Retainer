import type {
  ExtensionManifest,
  ExtensionMappingBinding,
  ExtensionMappingChoices,
} from '@retainer/extension';
import { AppError } from '../errors.js';
import type { ContributionRow } from '../extension-runtime/retired.js';
import type { FieldState, ObjectState, SchemaState } from '../schema/types.js';
import type { SchemaOperation } from '../schema-engine/operations.js';

/**
 * An installation's approved mapping as stored: each bound output names its
 * target only by universal ID, so renames never break it. Skipped outputs are
 * absent.
 */
export type StoredMapping = {
  outputs: Record<string, { fieldUniversalId: string; contribution: boolean }>;
};
export const EMPTY_MAPPING: StoredMapping = { outputs: {} };

type Output = NonNullable<ExtensionManifest['mapping']>['outputs'][number];
type Issue = { output: string; reason: string };

export type ResolvedMapping = {
  stored: StoredMapping;
  /** `create_field` operations for suggested fields this review adds. */
  operations: SchemaOperation[];
  /** Suggested fields this review creates; the installation owns them as contributions. */
  contributions: { universalId: string; definition: NonNullable<Output['field']> }[];
  bindings: ExtensionMappingBinding[];
  warnings: string[];
};

function mappingInvalid(issues: Issue[]): never {
  throw new AppError(422, 'mapping_invalid', 'the output mapping is not valid', {
    outputs: issues,
  });
}

/** Whether a stored binding's target can be written: active, on the object, a compatible type. */
export function bindingStatus(
  object: ObjectState | undefined,
  output: Pick<Output, 'types'>,
  fieldUniversalId: string,
): { status: ExtensionMappingBinding['status']; field?: FieldState } {
  const field = object?.fields.find((f) => f.universalId === fieldUniversalId);
  if (!field || field.status !== 'active')
    return { status: 'missing', ...(field ? { field } : {}) };
  if (!(output.types as readonly string[]).includes(field.type))
    return { status: 'incompatible', field };
  return { status: 'ok', field };
}

const view = (field: FieldState) => ({ name: field.name, label: field.label, type: field.type });

/**
 * Resolves a reviewed mapping against the current schema (spec 3.3). With
 * `choices`, every output is validated and all problems are reported together
 * as `mapping_invalid`. Without them, the stored mapping carries over to this
 * release: new outputs start skipped, dropped outputs lose their binding, and
 * a target the release no longer accepts is an `upgrade_conflict`.
 */
export function resolveMapping(
  current: SchemaState,
  manifest: ExtensionManifest,
  choices: ExtensionMappingChoices | undefined,
  stored: StoredMapping | undefined,
  owned: ContributionRow[],
): ResolvedMapping {
  const mapping = manifest.mapping;
  const empty = { stored: EMPTY_MAPPING, operations: [], contributions: [], bindings: [] };
  if (!mapping) {
    if (choices) mappingInvalid([{ output: '*', reason: 'no_mapping' }]);
    return { ...empty, warnings: [] };
  }
  const object = current.objects.find((o) => o.universalId === mapping.objectId);
  if (!object || object.status !== 'active')
    throw new AppError(409, 'schema_binding_conflict', 'the mapping object is unavailable');
  if (mapping.lookup) {
    const lookup = object.fields.find((f) => f.universalId === mapping.lookup?.fieldId);
    if (!lookup || lookup.status !== 'active' || lookup.type !== mapping.lookup.type)
      throw new AppError(
        409,
        'schema_binding_conflict',
        `the lookup field is missing or is not a ${mapping.lookup.type} field`,
      );
  }
  const owns = (universalId: string) =>
    owned.some((c) => c.kind === 'field' && c.universal_id === universalId);
  return choices
    ? review(current, object, mapping, choices, owns)
    : carry(object, mapping, stored ?? EMPTY_MAPPING, owns);
}

function review(
  current: SchemaState,
  object: ObjectState,
  mapping: NonNullable<ExtensionManifest['mapping']>,
  choices: ExtensionMappingChoices,
  owns: (universalId: string) => boolean,
): ResolvedMapping {
  const issues: Issue[] = [];
  const result: ResolvedMapping = {
    stored: { outputs: {} },
    operations: [],
    contributions: [],
    bindings: [],
    warnings: [],
  };
  const declared = new Set(mapping.outputs.map((o) => o.key));
  for (const key of Object.keys(choices))
    if (!declared.has(key)) issues.push({ output: key, reason: 'unknown_output' });
  const destinations = new Map<string, string>();
  for (const output of mapping.outputs) {
    const choice = choices[output.key];
    if (!choice) {
      issues.push({ output: output.key, reason: 'missing_output' });
      continue;
    }
    if (choice.action === 'skip') {
      result.bindings.push({
        output: output.key,
        action: 'skip',
        contribution: false,
        status: 'ok',
      });
      continue;
    }
    let target: FieldState | undefined;
    let contribution = false;
    if (choice.action === 'existing') {
      target = object.fields.find((f) => f.name === choice.field && f.status === 'active');
      if (!target) {
        issues.push({ output: output.key, reason: 'field_not_found' });
        continue;
      }
      contribution = owns(target.universalId);
    } else {
      const suggested = output.field;
      if (!suggested) {
        issues.push({ output: output.key, reason: 'no_suggested_field' });
        continue;
      }
      const same = object.fields.find((f) => f.universalId === suggested.universalId);
      if (same && same.status !== 'active') {
        // Deleted here before: the engine cannot recreate an identity, so the
        // admin binds another field instead.
        issues.push({ output: output.key, reason: 'suggested_field_deleted' });
        continue;
      }
      if (same) {
        target = same;
        contribution = owns(same.universalId);
        if (!contribution)
          result.warnings.push(
            `Output ${output.label} uses the existing field ${same.label} instead of creating one.`,
          );
      } else if (
        object.fields.some((f) => f.name === suggested.name && f.status === 'active') ||
        current.objects.some((o) => o.fields.some((f) => f.universalId === suggested.universalId))
      ) {
        issues.push({ output: output.key, reason: 'name_taken' });
        continue;
      } else {
        result.operations.push({
          op: 'create_field',
          object: object.universalId,
          field: suggested,
        });
        contribution = true;
        destinations.set(suggested.universalId, output.key);
        result.contributions.push({ universalId: suggested.universalId, definition: suggested });
        result.stored.outputs[output.key] = {
          fieldUniversalId: suggested.universalId,
          contribution: true,
        };
        result.bindings.push({
          output: output.key,
          action: 'create',
          field: { name: suggested.name, label: suggested.label, type: suggested.type },
          contribution: true,
          status: 'ok',
        });
        continue;
      }
    }
    if (target.universalId === mapping.lookup?.fieldId) {
      issues.push({ output: output.key, reason: 'lookup_field' });
      continue;
    }
    if (!(output.types as readonly string[]).includes(target.type)) {
      issues.push({ output: output.key, reason: 'incompatible_type' });
      continue;
    }
    if (destinations.has(target.universalId)) {
      issues.push({ output: output.key, reason: 'duplicate_destination' });
      continue;
    }
    destinations.set(target.universalId, output.key);
    result.stored.outputs[output.key] = { fieldUniversalId: target.universalId, contribution };
    result.bindings.push({
      output: output.key,
      action: choice.action,
      field: view(target),
      contribution,
      status: 'ok',
    });
  }
  if (!issues.length && !Object.keys(result.stored.outputs).length)
    issues.push({ output: '*', reason: 'nothing_mapped' });
  if (issues.length) mappingInvalid(issues);
  return result;
}

function carry(
  object: ObjectState,
  mapping: NonNullable<ExtensionManifest['mapping']>,
  stored: StoredMapping,
  owns: (universalId: string) => boolean,
): ResolvedMapping {
  const result: ResolvedMapping = {
    stored: { outputs: {} },
    operations: [],
    contributions: [],
    bindings: [],
    warnings: [],
  };
  const declared = new Map(mapping.outputs.map((o) => [o.key, o]));
  for (const key of Object.keys(stored.outputs))
    if (!declared.has(key))
      result.warnings.push(`Output ${key} is no longer provided; its field mapping is removed.`);
  for (const output of mapping.outputs) {
    const binding = stored.outputs[output.key];
    if (!binding) {
      result.bindings.push({
        output: output.key,
        action: 'skip',
        contribution: false,
        status: 'ok',
      });
      continue;
    }
    if (binding.fieldUniversalId === mapping.lookup?.fieldId)
      throw new AppError(
        409,
        'upgrade_conflict',
        `output ${output.key} is mapped to the lookup field; remap it first`,
        { output: output.key },
      );
    const { status, field } = bindingStatus(object, output, binding.fieldUniversalId);
    if (status === 'incompatible')
      throw new AppError(
        409,
        'upgrade_conflict',
        `output ${output.key} no longer accepts its mapped field; remap it first`,
        { output: output.key, field: field?.name },
      );
    if (status === 'missing')
      result.warnings.push(
        `Output ${output.label} is mapped to a field that was deleted; remap or skip it.`,
      );
    result.stored.outputs[output.key] = binding;
    result.bindings.push({
      output: output.key,
      action: 'existing',
      ...(field && status === 'ok' ? { field: view(field) } : {}),
      contribution: owns(binding.fieldUniversalId),
      status,
    });
  }
  return result;
}
