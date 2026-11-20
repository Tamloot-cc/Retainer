import {
  isReservedRoutineName,
  ROUTINE_LIMITS,
  type RoutineFilter,
  type RoutineManifest,
  type RoutineProblem,
  routineManifestSchema,
} from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { builtInNames, compileFilter } from '../records/query.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import type { Capabilities } from './capabilities.js';
import { cronProblem } from './cron.js';

/** An object by API name or universal ID; hidden and inactive ones are not found. */
export function objectFor(schema: CompiledSchema, ref: string): CompiledObject | undefined {
  const byId = schema.objectsByUniversalId.get(ref);
  if (byId && byId.state.status === 'active' && !byId.hidden) return byId;
  return schema.objectsByName.get(ref);
}

/** A field by key or API name. */
export function fieldFor(object: CompiledObject, ref: string): FieldState | undefined {
  return object.activeFields.find((field) => field.key === ref) ?? object.fieldsByName.get(ref);
}

/**
 * A filter's field references moved between keys and names: the manifest
 * stores keys, so a rename does not break it; the record query takes names.
 */
export function mapFilter(
  object: CompiledObject,
  filter: RoutineFilter,
  to: 'key' | 'name',
  depth = 0,
): RoutineFilter {
  if (depth > 8) throw new AppError(422, 'invalid_filter', 'filters nest at most 8 levels deep');
  if (!filter || typeof filter !== 'object' || Array.isArray(filter))
    throw new AppError(422, 'invalid_filter', 'a filter is an object of field conditions');
  const out: RoutineFilter = {};
  for (const [ref, condition] of Object.entries(filter)) {
    if (ref === 'and' || ref === 'or') {
      if (!Array.isArray(condition))
        throw new AppError(422, 'invalid_filter', `${ref} takes an array of filters`);
      out[ref] = condition.map((child) => mapFilter(object, child as RoutineFilter, to, depth + 1));
    } else if (ref === 'not')
      out.not = mapFilter(object, condition as RoutineFilter, to, depth + 1);
    else if (builtInNames(object).includes(ref)) out[ref] = condition;
    else {
      const field = fieldFor(object, ref);
      if (!field)
        throw new AppError(422, 'unknown_field', `${object.name} has no field "${ref}"`, {
          field: ref,
        });
      out[to === 'key' ? field.key : field.name] = condition;
    }
  }
  return out;
}

/**
 * Whether a stored filter still runs against the schema as it is now: it
 * maps and compiles exactly as the query will, so a field that is gone, no
 * longer filterable or of another type all count (§5.3).
 */
export function filterResolves(tx: Tx, object: CompiledObject, filter: RoutineFilter): boolean {
  try {
    compileFilter(tx, object, mapFilter(object, filter, 'name'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether every schema reference a stored manifest makes still resolves:
 * its object, watched fields, filters and expiry field (§5.3). A schema
 * change can break any of them after approval; the matcher, the schedule
 * tick and a run's start all ask this one check, and pause the routine as
 * `check_failed` when it fails, instead of failing or skipping in silence.
 */
export function manifestResolves(tx: Tx, schema: CompiledSchema, manifest: RoutineManifest) {
  const when = manifest.when;
  if (!('object' in when) || !when.object) return true;
  const object = objectFor(schema, when.object);
  if (!object) return false;
  const active = (key: string) => object.activeFields.some((field) => field.key === key);
  if (when.kind === 'record' && when.fields?.some((key) => !active(key))) return false;
  if (when.kind === 'schedule' && when.filter && !filterResolves(tx, object, when.filter))
    return false;
  if (manifest.if && !filterResolves(tx, object, manifest.if)) return false;
  if (manifest.expiry && !active(manifest.expiry.field)) return false;
  return true;
}

/** The type `main`'s argument must accept: its trigger object's context, or none. */
export function contextTypeFor(schema: CompiledSchema, manifest: RoutineManifest): string {
  const when = manifest.when;
  const object = 'object' in when && when.object ? objectFor(schema, when.object) : undefined;
  return object ? `RoutineContext<${JSON.stringify(object.name)}>` : 'RoutineContext';
}

export type CheckedManifest = { manifest: RoutineManifest; problems: RoutineProblem[] };

/**
 * Checks a manifest completely, as fixed logic (§5.2, item 2), and returns
 * it canonical: objects by universal ID, fields by key. Problems point at
 * the part that failed; a manifest with any cannot be saved.
 */
export function checkManifest(
  tx: Tx,
  schema: CompiledSchema,
  caps: Pick<Capabilities, 'installed' | 'model'>,
  raw: unknown,
): CheckedManifest {
  const problems: RoutineProblem[] = [];
  const problem = (at: string, code: string, message: string) =>
    problems.push({ part: 'manifest', at, code, message });
  const parsed = routineManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20))
      problem(issue.path.join('.') || '(root)', 'invalid_manifest', issue.message);
    return { manifest: raw as RoutineManifest, problems };
  }
  const manifest = structuredClone(parsed.data);
  const when = manifest.when;
  let object: CompiledObject | undefined;
  if ('object' in when && when.object !== undefined) {
    object = objectFor(schema, when.object);
    if (!object) problem('when.object', 'unknown_object', `there is no object "${when.object}"`);
    else if (isReservedRoutineName(object.name))
      problem(
        'when.object',
        'reserved_object',
        `routine code cannot reach "${object.name}": the SDK uses that name`,
      );
    else when.object = object.state.universalId;
  }
  if (when.kind === 'record' && object) {
    if (when.on.includes('links') && !object.isEvent)
      problem('when.on', 'invalid_trigger', 'only an event type has links to watch');
    if (when.fields) {
      const keys: string[] = [];
      for (const ref of when.fields) {
        const field = fieldFor(object, ref);
        if (!field) problem('when.fields', 'unknown_field', `${object.name} has no field "${ref}"`);
        else keys.push(field.key);
      }
      when.fields = [...new Set(keys)];
      if (!when.on.includes('updated'))
        problem('when.fields', 'invalid_trigger', 'watched fields need "updated" in on');
    }
  }
  if (when.kind === 'schedule') {
    const cron = cronProblem(when.cron);
    if (cron) problem('when.cron', 'over_limit', cron);
    if (when.filter && !when.object)
      problem('when.filter', 'invalid_trigger', 'a schedule filter needs an object');
    if (when.oncePerRecord && !when.object)
      problem('when.oncePerRecord', 'invalid_trigger', 'oncePerRecord needs an object');
    if (when.filter && object) when.filter = checkFilter(tx, object, when.filter, 'when.filter');
  }
  if (manifest.if) {
    if (!object) problem('if', 'invalid_trigger', 'a condition needs a trigger on an object');
    else manifest.if = checkFilter(tx, object, manifest.if, 'if');
  }
  if (manifest.expiry) {
    const field = object && fieldFor(object, manifest.expiry.field);
    if (!object)
      problem('expiry', 'invalid_trigger', 'an expiry field needs a trigger on an object');
    else if (!field || !['date', 'date_time'].includes(field.type))
      problem(
        'expiry.field',
        'unknown_field',
        `${object.name} has no date field "${manifest.expiry.field}"`,
      );
    else manifest.expiry.field = field.key;
  }
  for (const name of new Set(manifest.uses.tools)) {
    const tool = caps.installed.find((t) => t.name === name);
    if (!tool) problem('uses.tools', 'no_tool', `no installed extension offers the tool "${name}"`);
    else if (tool.status === 'conflict')
      problem('uses.tools', 'no_tool', `two installed extensions offer "${name}"`);
    else if (tool.connection === 'member' && when.kind !== 'manual')
      problem(
        'uses.tools',
        'member_account',
        `"${name}" acts from a member's own account, so only a button that member presses can call it`,
      );
  }
  manifest.uses.tools = [...new Set(manifest.uses.tools)].sort();
  if (manifest.uses.model && !caps.model.available)
    problem('uses.model', 'model_unavailable', 'this server has no model key');
  return { manifest, problems };

  function checkFilter(tx: Tx, target: CompiledObject, filter: RoutineFilter, at: string) {
    try {
      const keyed = mapFilter(target, filter, 'key');
      // Compiling checks filterability and operators, as a query would; nothing runs.
      compileFilter(tx, target, mapFilter(target, keyed, 'name'));
      return keyed;
    } catch (error) {
      const code =
        error instanceof AppError && /filterable/i.test(error.message)
          ? 'field_not_filterable'
          : error instanceof AppError
            ? error.code
            : 'invalid_filter';
      problem(at, code, error instanceof Error ? error.message : 'invalid filter');
      return filter;
    }
  }
}

/**
 * Checks done on the code without running it. Imports are refused by the
 * sandbox's type-check, which parses the code (no module resolves there),
 * and by its loader at run time; a text scan cannot tell syntax from a
 * string, a comment or a member named `import`.
 */
export function checkCode(code: string): RoutineProblem[] {
  const problems: RoutineProblem[] = [];
  if (Buffer.byteLength(code) > ROUTINE_LIMITS.sourceBytes)
    problems.push({
      part: 'code',
      code: 'over_limit',
      message: `the code is larger than ${ROUTINE_LIMITS.sourceBytes / 1024} KiB`,
    });
  if (!/export\s+(async\s+)?function\s+main\s*\(|export\s+const\s+main\s*=/.test(code))
    problems.push({ part: 'code', code: 'missing_main', message: 'export a function named main' });
  return problems;
}
