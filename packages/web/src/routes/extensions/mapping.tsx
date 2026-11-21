import {
  type ExtensionManifest,
  type ExtensionMappingBinding,
  type ExtensionMappingChoice,
  type ExtensionMappingChoices,
  type ExtensionMappingView,
  mappingChoicesSchema,
} from '@retainer/extension';
import {
  BASE_OBJECT_IDS,
  compatibleFields,
  mappingFieldIssue,
  type ObjectView,
} from '@retainer/shared';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useWorkspace } from '../../api/client.js';
import { cn } from '../../ui/core.js';
import {
  Badge,
  Button,
  Dialog,
  Label,
  Muted,
  Notice,
  ObjectIcon,
  Row,
  SelectMenu,
  Stack,
  Textarea,
} from '../../ui/index.js';
import { ChangeGroup, ChangeList } from '../../ui/review.js';

type Mapping = NonNullable<ExtensionManifest['mapping']>;
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
  read_only: 'That field is read-only.',
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
      else if (mappingFieldIssue(field, output, mapping.lookup?.fieldId))
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
        <Button size="small" onClick={() => setImporting(true)}>
          Import draft
        </Button>
      </Row>
      <Muted small>
        This extension fills empty fields on {object.labelPlural.toLowerCase()}. Fields someone
        already filled or cleared stay as they are.
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
          ...compatibleFields(object.fields, output, mapping.lookup?.fieldId).map((f) => ({
            value: `existing:${f.name}`,
            label: f.label,
          })),
          ...(output.field ? [{ value: 'create', label: `Create “${output.field.label}”` }] : []),
          { value: 'skip', label: 'Skip' },
        ];
        return (
          <div key={output.key} className="min-w-0 rounded-md bg-muted/50 p-3">
            <Label>
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
          </div>
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

const MAPPING_COLUMNS = '@min-[24rem]:grid-cols-[minmax(0,1fr)_0.875rem_minmax(0,1.4fr)]';

/** The resolved output destinations, grouped under their workspace record type. */
export function MappingGroup(props: Parameters<typeof MappingBindings>[0]) {
  const { schema } = useWorkspace();
  const object = mappingObject(schema.objects, props.mapping);
  return (
    <ChangeList label="Field mapping">
      <ChangeGroup
        icon={
          object ? (
            <ObjectIcon name={object.nameSingular} objectClass={object.class} size={15} />
          ) : null
        }
        title={object?.labelSingular ?? 'Field mapping'}
        lines={[]}
      >
        <MappingBindings {...props} />
      </ChangeGroup>
    </ChangeList>
  );
}

/** One row per output in a review or an installation summary. */
function MappingBindings({
  mapping,
  bindings,
  newFields,
}: {
  mapping: Mapping;
  bindings: ExtensionMappingBinding[];
  /** In a preview, the fields the schema plan actually creates. */
  newFields?: ReadonlySet<string>;
}) {
  return (
    <div className="@container">
      <div
        aria-hidden
        className={cn(
          'mb-1 hidden gap-x-3 px-3 text-xs text-muted-foreground @min-[24rem]:grid',
          MAPPING_COLUMNS,
        )}
      >
        <span>Extension output</span>
        <span className="col-start-3">Workspace field</span>
      </div>
      <ul aria-label="Extension outputs and workspace fields" className="space-y-1.5">
        {bindings.map(({ output, action, field, status }) => (
          <li
            key={output}
            className={cn(
              'grid min-w-0 items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-sm [overflow-wrap:anywhere]',
              MAPPING_COLUMNS,
            )}
          >
            <span className="min-w-0 text-muted-foreground">
              <span className="sr-only">Extension output: </span>
              {outputLabel(mapping, output)}
            </span>
            <ArrowRight
              size={14}
              aria-hidden
              className="hidden text-muted-foreground @min-[24rem]:block"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium">
              {action === 'skip' ? (
                <span>Skipped</span>
              ) : field ? (
                <span className="min-w-0">
                  <span className="sr-only">Workspace field: </span>
                  {field.label}
                </span>
              ) : status === 'ok' ? (
                <span>Field unavailable</span>
              ) : null}
              {field && newFields?.has(field.name) ? <Badge tone="success">New field</Badge> : null}
              {status === 'missing' ? (
                <Badge tone="error">Field deleted</Badge>
              ) : status === 'incompatible' ? (
                <Badge tone="error">Field type changed</Badge>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
