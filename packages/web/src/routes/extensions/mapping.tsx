import {
  type ExtensionManifest,
  type ExtensionMappingBinding,
  type ExtensionMappingChoice,
  type ExtensionMappingChoices,
  type ExtensionMappingView,
  mappingChoicesSchema,
} from '@retainer/extension';
import { BASE_FIELD_IDS, BASE_OBJECT_IDS, type FieldView, type ObjectView } from '@retainer/shared';
import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  Label,
  Muted,
  Notice,
  Row,
  SelectMenu,
  Stack,
  Textarea,
} from '../../ui/index.js';

type Mapping = NonNullable<ExtensionManifest['mapping']>;
type Output = Mapping['outputs'][number];
/** Per output, a problem to show next to its row: from an imported draft or the server. */
export type MappingIssues = Record<string, string>;

const BASE_NAMES = new Map<string, ObjectView['baseObject']>(
  Object.entries(BASE_OBJECT_IDS).map(([name, id]) => [id, name as ObjectView['baseObject']]),
);

/**
 * The object a mapping targets. The schema API names objects, not universal
 * IDs, so only base objects (found by `baseObject` after a rename) can be
 * mapped from the web app; v1 enrichment targets Company.
 */
export function mappingObject(objects: ObjectView[], mapping: Mapping) {
  const base = BASE_NAMES.get(mapping.objectId);
  return base ? objects.find((o) => o.baseObject === base) : undefined;
}

/**
 * Fields an output can be written to: active, writable, of a compatible type
 * and not the field the extension looks records up by (found by `baseField`).
 */
export function compatibleFields(
  object: ObjectView,
  output: Output,
  lookup?: Mapping['lookup'],
): FieldView[] {
  return object.fields.filter(
    (f) =>
      !f.readOnly &&
      (output.types as readonly string[]).includes(f.type) &&
      !(
        f.baseField &&
        lookup &&
        BASE_FIELD_IDS[f.baseField as keyof typeof BASE_FIELD_IDS] === lookup.fieldId
      ),
  );
}

/** The starting choice: the suggested field when there is one, otherwise skip. */
export function defaultChoices(mapping: Mapping): ExtensionMappingChoices {
  return Object.fromEntries(
    mapping.outputs.map((o) => [o.key, o.field ? { action: 'create' } : { action: 'skip' }]),
  );
}

/** The choices an approved mapping stands for, to edit it. */
export function choicesFromView(mapping: Mapping, view: ExtensionMappingView) {
  return Object.fromEntries(
    mapping.outputs.map((output): [string, ExtensionMappingChoice] => {
      const binding = view.outputs.find((b) => b.output === output.key);
      return [
        output.key,
        binding?.field && binding.action !== 'skip'
          ? { action: 'existing', field: binding.field.name }
          : { action: 'skip' },
      ];
    }),
  );
}

const REASONS: Record<string, string> = {
  unknown_output: 'This extension has no such output.',
  missing_output: 'Choose a field or skip this output.',
  field_not_found: 'That field does not exist here.',
  wrong_object: 'That field is on another object.',
  incompatible_type: 'That field cannot hold this value.',
  lookup_field: 'The extension reads this field to look companies up; choose another.',
  duplicate_destination: 'Another output already writes to that field.',
  no_suggested_field: 'This output has no suggested field to create.',
  suggested_field_deleted: 'The suggested field was deleted here; choose another field.',
  name_taken: 'A field with the suggested name already exists; choose it or another field.',
  nothing_mapped: 'Choose a field for at least one output.',
  missing_mapping: 'Choose a field or skip for every output.',
};

/** Per-output issues from a `mapping_invalid` error's details. */
export function serverIssues(details: unknown): MappingIssues {
  const outputs = (details as { outputs?: { output: string; reason: string }[] } | undefined)
    ?.outputs;
  return Object.fromEntries(
    (outputs ?? []).map((i) => [i.output, REASONS[i.reason] ?? i.reason.replaceAll('_', ' ')]),
  );
}

/**
 * Reads an agent's draft: one choice per output key. Choices for declared
 * outputs replace the form's; anything the form cannot show becomes an issue
 * instead of disappearing.
 */
export function importDraft(
  text: string,
  mapping: Mapping,
  object: ObjectView,
  current: ExtensionMappingChoices,
): { choices: ExtensionMappingChoices; issues: MappingIssues } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'The draft is not valid JSON.' };
  }
  const parsed = mappingChoicesSchema.safeParse(json);
  if (!parsed.success)
    return {
      error:
        'The draft must map each output key to {"action":"existing","field":"<name>"}, {"action":"create"} or {"action":"skip"}.',
    };
  const choices = { ...current };
  const issues: MappingIssues = {};
  for (const [key, choice] of Object.entries(parsed.data)) {
    const output = mapping.outputs.find((o) => o.key === key);
    if (!output) {
      issues[key] = REASONS.unknown_output as string;
      continue;
    }
    choices[key] = choice;
    if (choice.action === 'existing') {
      const field = object.fields.find((f) => f.name === choice.field);
      if (!field) issues[key] = `The draft names “${choice.field}”, which does not exist here.`;
      else if (!compatibleFields(object, output, mapping.lookup).includes(field))
        issues[key] = `The draft names “${field.label}”, which cannot hold this value.`;
    }
    if (choice.action === 'create' && !output.field)
      issues[key] = REASONS.no_suggested_field as string;
  }
  for (const output of mapping.outputs)
    if (!Object.hasOwn(parsed.data, output.key))
      issues[output.key] = 'The draft does not mention this output; the form kept its choice.';
  return { choices, issues };
}

const encode = (choice: ExtensionMappingChoice | undefined) =>
  !choice ? null : choice.action === 'existing' ? `existing:${choice.field}` : choice.action;
const decode = (value: string): ExtensionMappingChoice =>
  value.startsWith('existing:')
    ? { action: 'existing', field: value.slice('existing:'.length) }
    : { action: value as 'create' | 'skip' };

/** One row per declared output: what it means, and where its value goes. */
export function MappingFields({
  mapping,
  object,
  choices,
  issues,
  onChange,
  onImport,
  suggestions,
}: {
  mapping: Mapping;
  object: ObjectView;
  choices: ExtensionMappingChoices;
  issues: MappingIssues;
  suggestions?: Record<string, ExtensionMappingChoice & { reason?: string }>;
  onChange: (key: string, choice: ExtensionMappingChoice) => void;
  onImport: (choices: ExtensionMappingChoices, issues: MappingIssues) => void;
}) {
  const [importing, setImporting] = useState(false);
  const unknown = Object.keys(issues).filter(
    (key) => !mapping.outputs.some((o) => o.key === key) && key !== '*',
  );
  return (
    <section aria-label="Field mapping" className="flex flex-col gap-3">
      <Row>
        <span className="font-medium">Where each value goes</span>
        <Button onClick={() => setImporting(true)}>Import draft</Button>
      </Row>
      <Muted small>
        Values fill only {object.labelPlural.toLowerCase()} fields that are empty. A field someone
        filled or cleared is never changed.
      </Muted>
      {issues['*'] ? <Notice>{issues['*']}</Notice> : null}
      {unknown.length ? (
        <Notice>
          The draft names outputs this extension does not have: {unknown.join(', ')}. They were not
          imported.
        </Notice>
      ) : null}
      {mapping.outputs.map((output) => {
        const choice = choices[output.key];
        const options = [
          ...compatibleFields(object, output, mapping.lookup).map((f) => ({
            value: `existing:${f.name}`,
            label: f.label,
          })),
          ...(output.field ? [{ value: 'create', label: `Create “${output.field.label}”` }] : []),
          { value: 'skip', label: 'Skip' },
        ];
        return (
          <Label key={output.key}>
            {output.label}
            {suggestions?.[output.key] ? <Badge>Suggested</Badge> : null}
            {suggestions?.[output.key]?.reason ? (
              <Muted small>{suggestions[output.key]?.reason}</Muted>
            ) : null}
            <Muted small>{output.description}</Muted>
            <SelectMenu
              label={`${output.label} destination`}
              value={encode(choice)}
              options={options}
              fallback={
                choice?.action === 'existing' ? (
                  <span>{choice.field} (not available)</span>
                ) : undefined
              }
              onChange={(value) => onChange(output.key, decode(value))}
              fill
            />
            {issues[output.key] ? (
              <span role="alert" className="text-sm text-destructive">
                {issues[output.key]}
              </span>
            ) : null}
          </Label>
        );
      })}
      {importing ? (
        <ImportDraft
          onClose={() => setImporting(false)}
          onImport={(text) => {
            const result = importDraft(text, mapping, object, choices);
            if ('error' in result) return result.error;
            onImport(result.choices, result.issues);
            setImporting(false);
            return null;
          }}
        />
      ) : null}
    </section>
  );
}

function ImportDraft({
  onClose,
  onImport,
}: {
  onClose: () => void;
  /** Returns an error to show, or null when the draft was imported. */
  onImport: (text: string) => string | null;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Import a mapping draft"
    >
      <Stack>
        <Muted>
          Paste the JSON an agent proposed. You can change every choice before you review and
          approve it.
        </Muted>
        {error ? <Notice>{error}</Notice> : null}
        <Label>
          Draft
          <Textarea value={text} onChange={(e) => setText(e.target.value)} />
        </Label>
        <Row>
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={() => setError(onImport(text))}
          >
            Import
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

const outputLabel = (mapping: Mapping, key: string) =>
  mapping.outputs.find((o) => o.key === key)?.label ?? key;

/** One line per output in a review or an installation summary. */
export function MappingBindings({
  mapping,
  bindings,
}: {
  mapping: Mapping;
  bindings: ExtensionMappingBinding[];
}) {
  return (
    <ul aria-label="Field mapping" className="flex flex-col gap-1">
      {bindings.map((binding) => (
        <li key={binding.output}>
          <Row>
            <span>
              {outputLabel(mapping, binding.output)} →{' '}
              {binding.action === 'skip'
                ? 'skipped'
                : (binding.field?.label ?? 'a field that no longer exists')}
            </span>
            {binding.action === 'create' && binding.contribution ? (
              <Badge tone="pending">New field</Badge>
            ) : null}
            {binding.status === 'missing' ? (
              <Badge tone="error">Field deleted</Badge>
            ) : binding.status === 'incompatible' ? (
              <Badge tone="error">Field type changed</Badge>
            ) : null}
          </Row>
        </li>
      ))}
    </ul>
  );
}
