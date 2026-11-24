import type Anthropic from '@anthropic-ai/sdk';
import {
  bindableField,
  type ExtensionBinding,
  type ExtensionBindingChoices,
  type ExtensionBindingPlan,
  SUGGESTION_REASON_MAX,
} from '@retainer/extension';
import type { RetainerClient } from '@retainer/sdk';
import { type FieldView, type ObjectView, relationTargets } from '@retainer/shared';
import { z } from 'zod';
import { askModel } from './model-call.js';
import { eachLimited } from './outcome.js';

/**
 * Suggested destinations from a model (configure spec 2.2, model calls spec
 * 6.1), shared by the bundles whose `configure` asks a model where their
 * bindings go. One call sees every binding, its candidate objects with their
 * eligible fields and a sample of recent records, and the current plan on an
 * upgrade or a request. Each bundle owns its prompt. Choices the schema can't
 * take are dropped, so the server's default applies to them.
 */

/** Thinking counts against `max_tokens` (model calls spec 6.3). */
const MAX_TOKENS = 8000;
/** Candidate objects per binding, and record labels kept from each. */
const MAX_OBJECTS = 25;
const SAMPLE_LABELS = 3;
const SAMPLE_LABEL_CHARACTERS = 120;
/** With field samples: records read per object, values kept per field, longest value. */
const SAMPLE_RECORDS = 20;
const SAMPLES_PER_FIELD = 5;
const SAMPLE_MAX_CHARACTERS = 500;
/** Sampling queries in flight at once, so one run doesn't burst the API. */
const SAMPLE_CONCURRENCY = 6;

type Choice = ExtensionBindingChoices[string];
type FieldChoice = NonNullable<Exclude<Choice, { action: 'skip' }>['fields']>[string];
type Rule = ExtensionBinding['fields'][number];

/** The fields of `object` a binding field may write to, as the server checks them. */
const eligible = (object: ObjectView, rule: Rule) =>
  object.fields.filter((field) => !field.readOnly && bindableField(field, rule));
const candidates = (objects: ObjectView[], binding: ExtensionBinding) =>
  objects.filter((object) => object.class === binding.class).slice(0, MAX_OBJECTS);

/** One candidate field as the model sees it. */
function describeField(field: FieldView) {
  const targets = relationTargets(field);
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    description: field.description,
    ...(field.settings.options ? { options: field.settings.options } : {}),
    ...(targets.length ? { targets } : {}),
  };
}

type Sample = { labels: string[]; values: Map<string, unknown[]> };
/**
 * Labels of recently updated records and, when `fields` is given, up to five
 * non-empty values of each of those fields; nothing if the object can't be read.
 */
async function sample(
  sdk: RetainerClient,
  object: ObjectView,
  fields: Set<string> | null,
  signal: AbortSignal,
): Promise<Sample> {
  const values = new Map<string, unknown[]>();
  try {
    const page = await sdk.queryRecords(
      object.nameSingular,
      {
        limit: fields ? SAMPLE_RECORDS : SAMPLE_LABELS,
        sort: [{ field: 'updatedAt', direction: 'desc' }],
      },
      signal,
    );
    if (fields)
      for (const record of page.records)
        for (const name of fields) {
          const value = record.fields[name];
          const list = values.get(name) ?? [];
          if (
            list.length < SAMPLES_PER_FIELD &&
            value !== null &&
            value !== undefined &&
            value !== '' &&
            JSON.stringify(value).length <= SAMPLE_MAX_CHARACTERS
          )
            values.set(name, list.concat([value]));
        }
    return {
      labels: page.records
        .slice(0, SAMPLE_LABELS)
        .flatMap((record) =>
          record.label ? [record.label.slice(0, SAMPLE_LABEL_CHARACTERS)] : [],
        ),
      values,
    };
  } catch {
    if (signal.aborted) throw new Error('aborted');
    return { labels: [], values };
  }
}

/** The model's input: the bindings, their candidates and the current plan. */
async function configureInput(
  sdk: RetainerClient,
  bindings: ExtensionBinding[],
  objects: ObjectView[],
  current: ExtensionBindingPlan | undefined,
  fieldValues: boolean,
  signal: AbortSignal,
) {
  // Each candidate object, with the fields any binding could write there.
  const offered = new Map<ObjectView, Set<string>>();
  for (const binding of bindings)
    for (const object of candidates(objects, binding)) {
      const names = offered.get(object) ?? new Set();
      for (const rule of binding.fields)
        for (const field of eligible(object, rule)) names.add(field.name);
      offered.set(object, names);
    }
  const samples = new Map<ObjectView, Sample>();
  await eachLimited([...offered], SAMPLE_CONCURRENCY, async ([object, names]) => {
    samples.set(object, await sample(sdk, object, fieldValues ? names : null, signal));
  });
  return {
    bindings: bindings.map((binding) => ({
      key: binding.key,
      label: binding.label,
      description: binding.description,
      required: binding.required,
      fields: binding.fields.map((rule) => ({
        key: rule.key,
        label: rule.label,
        ...(rule.description ? { description: rule.description } : {}),
        types: rule.types,
        required: rule.required,
        ...(rule.values ? { values: rule.values } : {}),
        ...(rule.target ? { target: rule.target } : {}),
      })),
      candidates: candidates(objects, binding).map((object) => ({
        name: object.nameSingular,
        label: object.labelPlural,
        description: object.description,
        recentRecords: samples.get(object)?.labels ?? [],
        fields: [...new Set(binding.fields.flatMap((rule) => eligible(object, rule)))].map(
          (field) => ({
            ...describeField(field),
            ...(fieldValues ? { samples: samples.get(object)?.values.get(field.name) ?? [] } : {}),
          }),
        ),
      })),
    })),
    ...(current
      ? {
          currentBindings: Object.fromEntries(
            Object.entries(current.bindings).map(([key, destination]) => [
              key,
              destination
                ? {
                    objects: destination.objects.map((object) => object.name),
                    fields: Object.fromEntries(
                      Object.entries(destination.fields).map(([fieldKey, field]) => [
                        fieldKey,
                        { field: field.name, values: field.values },
                      ]),
                    ),
                  }
                : null,
            ]),
          ),
        }
      : {}),
  };
}

const nullable = (type: Record<string, unknown>) => ({ anyOf: [type, { type: 'null' }] });
/** A JSON schema object whose every property is required, as structured output needs. */
const strict = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
/** A required binding or field can't be skipped. */
const actions = (required: boolean) =>
  required ? ['existing', 'create'] : ['existing', 'create', 'skip'];

/** The answer's JSON schema, built from the bindings so it always matches them. */
export function answerSchema(bindings: ExtensionBinding[]) {
  const choice = (required: boolean, target: string, extra: Record<string, unknown>) =>
    strict({
      action: { type: 'string', enum: actions(required) },
      [target]: nullable({ type: 'string' }),
      reason: { type: 'string' },
      ...extra,
    });
  const fieldChoice = (rule: Rule) =>
    choice(
      rule.required,
      'field',
      rule.values
        ? {
            values: strict(
              Object.fromEntries(rule.values.map((value) => [value, nullable({ type: 'string' })])),
            ),
          }
        : {},
    );
  const bindingChoice = (binding: ExtensionBinding) =>
    choice(
      binding.required,
      'object',
      binding.fields.length
        ? {
            fields: strict(
              Object.fromEntries(binding.fields.map((rule) => [rule.key, fieldChoice(rule)])),
            ),
          }
        : {},
    );
  return strict(
    Object.fromEntries(bindings.map((binding) => [binding.key, bindingChoice(binding)])),
  );
}

const action = z.enum(['existing', 'create', 'skip']);
const fieldAnswer = z.strictObject({
  action,
  field: z.string().nullable(),
  reason: z.string(),
  values: z.record(z.string(), z.string().nullable()).optional(),
});
const bindingAnswer = z.strictObject({
  action,
  object: z.string().nullable(),
  reason: z.string(),
  fields: z.record(z.string(), fieldAnswer).optional(),
});
const answerParser = z.record(z.string(), bindingAnswer);
export type ConfigureAnswer = z.infer<typeof answerParser>;

/**
 * Where a relation's target binding goes, as kept: an existing object, a new
 * one, or nowhere (skipped, or a choice that was dropped).
 */
type Related = ObjectView | 'create' | undefined;

/**
 * The model's pick for one field, if the server can take it: a skip of an
 * optional field, a field the extension can create, or an existing eligible
 * field, with only the values that name one of its options. A relation needs
 * its target binding to go somewhere: a new relation field points at that
 * list, an existing one must already point at the chosen object.
 */
function fieldSuggestion(
  rule: Rule,
  pick: z.infer<typeof fieldAnswer>,
  object: ObjectView,
  related: Related,
): FieldChoice | undefined {
  if (pick.action === 'skip') return rule.required ? undefined : { action: 'skip' };
  if (pick.action === 'create')
    return rule.create && (!rule.target || related) ? { action: 'create' } : undefined;
  const target = eligible(object, rule).find((entry) => entry.name === pick.field);
  if (!target) return undefined;
  if (
    rule.target &&
    !(related && related !== 'create' && relationTargets(target).includes(related.nameSingular))
  )
    return undefined;
  const options = new Set(target.settings.options?.map((option) => option.value));
  const values = Object.fromEntries(
    (rule.values ?? []).flatMap((value) => {
      const mapped = pick.values?.[value];
      return mapped && options.has(mapped) ? [[value, mapped]] : [];
    }),
  );
  return {
    action: 'existing',
    field: target.name,
    ...(Object.keys(values).length ? { values } : {}),
  };
}

/**
 * Turns the model's answer into binding choices the server can take. A
 * binding or field whose choice can't fit is left out, so the server's fixed
 * default applies to it; a status value mapped to an option the field lacks
 * is dropped the same way.
 */
function toSuggestions(
  declared: ExtensionBinding[],
  objects: ObjectView[],
  answer: ConfigureAnswer,
): Suggestions {
  const bindings: ExtensionBindingChoices = {};
  const reasons: Record<string, string> = {};
  const reason = (key: string, text: string) => {
    const trimmed = text.trim().slice(0, SUGGESTION_REASON_MAX);
    if (trimmed) reasons[key] = trimmed;
  };
  // Relations are checked against where their target binding goes, as kept below.
  const chosen = (key: string) => {
    const choice = answer[key];
    const binding = declared.find((entry) => entry.key === key);
    if (choice?.action !== 'existing' || !binding) return undefined;
    return candidates(objects, binding).find((object) => object.nameSingular === choice.object);
  };
  const related = (key: string): Related => {
    const binding = declared.find((entry) => entry.key === key);
    if (answer[key]?.action === 'create') return binding?.create ? 'create' : undefined;
    return chosen(key);
  };
  for (const binding of declared) {
    const choice = answer[binding.key];
    if (!choice) continue;
    if (choice.action === 'skip') {
      if (binding.required) continue;
      bindings[binding.key] = { action: 'skip' };
    } else if (choice.action === 'create') {
      if (!binding.create) continue;
      bindings[binding.key] = { action: 'create' };
    } else {
      const object = chosen(binding.key);
      if (!object) continue;
      const fields: Record<string, FieldChoice> = {};
      for (const rule of binding.fields) {
        const pick = choice.fields?.[rule.key];
        const field =
          pick &&
          fieldSuggestion(rule, pick, object, rule.target ? related(rule.target) : undefined);
        if (!pick || !field) continue;
        fields[rule.key] = field;
        reason(`${binding.key}.${rule.key}`, pick.reason);
      }
      bindings[binding.key] = {
        action: 'existing',
        objects: [object.nameSingular],
        ...(Object.keys(fields).length ? { fields } : {}),
      };
    }
    reason(binding.key, choice.reason);
  }
  return { bindings, bindingReasons: reasons };
}

export type Suggestions = {
  bindings: ExtensionBindingChoices;
  bindingReasons: Record<string, string>;
};

/**
 * Asks the model where `bindings` go and returns the choices that fit, or
 * null when the model gave no usable answer. Any failure but an abort is no
 * answer: the bundle decides what to fall back to.
 */
export async function suggestBindings(
  sdk: RetainerClient,
  request: {
    /** The workspace's objects, from the schema. */
    objects: ObjectView[];
    bindings: ExtensionBinding[];
    model: Anthropic | null;
    modelName: string;
    system: string;
    current: ExtensionBindingPlan | undefined;
    /** Also sample each candidate field's values, for outputs judged by meaning. */
    fieldValues?: boolean;
  },
  signal: AbortSignal,
): Promise<Suggestions | null> {
  const { objects } = request;
  // Without a model there is nothing to ask, so nothing is sampled.
  if (!request.model) return null;
  try {
    const input = await configureInput(
      sdk,
      request.bindings,
      objects,
      request.current,
      request.fieldValues ?? false,
      signal,
    );
    const result = await askModel(
      request.model,
      {
        model: request.modelName,
        system: request.system,
        user: JSON.stringify(input),
        schema: answerSchema(request.bindings),
        maxTokens: MAX_TOKENS,
      },
      answerParser,
      signal,
    );
    return result.status === 'ok' ? toSuggestions(request.bindings, objects, result.value) : null;
  } catch {
    // Any failure falls back (model calls spec 6.1).
    if (signal.aborted) throw new Error('aborted');
    return null;
  }
}
