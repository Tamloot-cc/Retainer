import { RetainerApiError } from '@retainer/sdk';
import type { ObjectView } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { type Ref, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import type { InputProps } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import { cn, focusFirst } from '../../ui/core.js';
import {
  ApiName,
  Button,
  DescriptionLine,
  Dialog,
  Form,
  FormField,
  Notice,
  ObjectIcon,
  RecordLink,
  Row,
} from '../../ui/index.js';
import { useAgentDescription, useApiName } from '../developer.js';
import { CreateProperty, hasPropertyPicker } from './create-property.js';
import {
  creatableFields,
  initialDraft,
  prepareCreateValues,
  serverFieldErrors,
} from './write-model.js';

/**
 * A form built from the object's fields. The idempotency key lives as long
 * as the dialog, so a retry after a lost response cannot create a second
 * record; a new dialog is a new key.
 */
export function CreateRecordDialog({
  object,
  returnFocus,
  onClose,
  onCreated,
}: {
  object: ObjectView;
  returnFocus?: HTMLElement;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient(),
    apiName = useApiName(),
    agentDescription = useAgentDescription();
  const list = useMemo(() => creatableFields(object), [object]);
  const [draft, setDraft] = useState(() => initialDraft(list)),
    [openProperty, setOpenProperty] = useState<string | null>(null),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(''),
    [saving, setBusy] = useState(false),
    [uploads, setUploads] = useState<Record<string, boolean>>({}),
    [key] = useState(() => crypto.randomUUID());
  const busy = saving || Object.values(uploads).some(Boolean);
  const noun = object.labelSingular.toLowerCase();
  const formId = useId();
  const label = list.find((field) => field.name === object.labelField);
  const description = list.find(
    (field) => field !== label && field.name === 'description' && field.type === 'text',
  );
  const remaining = list.filter((field) => field !== label && field !== description);
  const required = remaining.filter((field) => !field.isNullable);
  const properties = remaining.filter((field) => field.isNullable);
  const firstInvalidField = useRef<HTMLDivElement>(null);
  const focusError = useRef(false);
  const dismissed = useRef(false);
  const firstInvalidName = list.find((field) => errors[field.name])?.name;
  const openEditor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openProperty) focusFirst(openEditor.current);
  }, [openProperty]);
  useEffect(() => {
    if (focusError.current && Object.keys(errors).length > 0) focusFirst(firstInvalidField.current);
    focusError.current = false;
  }, [errors]);

  function reportFieldErrors(next: Record<string, string>) {
    focusError.current = true;
    setErrors(next);
    const first = list.find((field) => next[field.name]);
    if (first && !hasPropertyPicker(first) && properties.includes(first)) {
      setOpenProperty(first.name);
    }
  }

  function dismiss() {
    if (busy) return;
    dismissed.current = true;
    onClose();
  }

  async function create() {
    if (busy) return;
    const { values, errors } = prepareCreateValues(list, draft);
    reportFieldErrors(errors);
    setError('');
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const result = await api.createRecord(object.nameSingular, { values }, key);
      onCreated(result.id);
      void client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      const failure = e instanceof RetainerApiError ? e : null;
      const fieldErrors = serverFieldErrors(failure?.details);
      const holder = (failure?.details as { recordId?: unknown } | undefined)?.recordId;
      reportFieldErrors(fieldErrors);
      setConflict(failure?.code === 'unique_conflict' && typeof holder === 'string' ? holder : '');
      // A failed request rolls its key back, so the same key is safe to retry.
      // It is only taken when an earlier attempt succeeded unseen and the
      // form changed since.
      setError(
        failure?.code === 'idempotency_key_reused'
          ? 'A record may already have been created from this form. Check the list before creating another.'
          : Object.keys(fieldErrors).length
            ? 'Some values need a change.'
            : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  function inputProps(field: InputProps['field']) {
    return {
      field,
      value: draft[field.name] ?? null,
      apiName: apiName(field.name),
      descriptionLine: agentDescription(field.description),
      error: errors[field.name] ? `${field.label} ${errors[field.name]}` : undefined,
      onChange: (value: unknown) => {
        setDraft((previous) => ({ ...previous, [field.name]: value }));
        setErrors((previous) => {
          if (!previous[field.name]) return previous;
          const next = { ...previous };
          delete next[field.name];
          return next;
        });
      },
      onBusyChange: (busy: boolean) =>
        setUploads((previous) => ({ ...previous, [field.name]: busy })),
    };
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      onCloseAutoFocus={(event) => {
        if (!dismissed.current || !returnFocus?.isConnected) return;
        event.preventDefault();
        returnFocus.focus({ preventScroll: true });
      }}
      title={`New ${noun}`}
      layout="composer"
      icon={<ObjectIcon name={object.nameSingular} objectClass={object.class} size={18} />}
      closeDisabled={busy}
    >
      <Form className="min-h-0 gap-0" autoFocus={list.length > 0} onSubmit={() => void create()}>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 scroll-py-3 sm:px-7">
          {label || description ? (
            <div className="space-y-2 pt-4 pb-6 sm:pt-6 sm:pb-8">
              {label ? (
                <DraftField
                  {...inputProps(label)}
                  writing={label.type === 'text' ? 'title' : undefined}
                  ref={label.name === firstInvalidName ? firstInvalidField : undefined}
                />
              ) : null}
              {description ? (
                <DraftField
                  {...inputProps(description)}
                  writing="description"
                  ref={description.name === firstInvalidName ? firstInvalidField : undefined}
                />
              ) : null}
            </div>
          ) : null}
          {required.length > 0 ? (
            <div className="space-y-3 pb-5">
              {required.map((field) => (
                <DraftField
                  key={field.name}
                  {...inputProps(field)}
                  ref={field.name === firstInvalidName ? firstInvalidField : undefined}
                />
              ))}
            </div>
          ) : null}
          {properties.length > 0 ? (
            <div className="pb-4 sm:pb-5">
              <div className="flex flex-wrap gap-2">
                {properties.map((field) => (
                  <CreateProperty
                    key={field.name}
                    {...inputProps(field)}
                    editorId={`${formId}-${field.name}`}
                    expanded={openProperty === field.name}
                    onToggle={() =>
                      setOpenProperty((open) => (open === field.name ? null : field.name))
                    }
                    ref={
                      hasPropertyPicker(field) && field.name === firstInvalidName
                        ? firstInvalidField
                        : undefined
                    }
                  />
                ))}
              </div>
              {properties
                .filter((field) => !hasPropertyPicker(field))
                .map((field) => {
                  const expanded = openProperty === field.name;
                  return (
                    <div
                      key={field.name}
                      id={`${formId}-${field.name}`}
                      hidden={!expanded}
                      ref={expanded ? openEditor : undefined}
                      className="mt-3 rounded-xl border border-border bg-muted/25 p-3"
                    >
                      <DraftField
                        {...inputProps(field)}
                        ref={field.name === firstInvalidName ? firstInvalidField : undefined}
                      />
                    </div>
                  );
                })}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 space-y-3 border-t border-border/75 px-5 py-3 sm:px-7 sm:py-4">
          {error ? (
            <Notice error>
              <Row>
                {error}
                {conflict ? <RecordLink id={conflict}>View that record</RecordLink> : null}
              </Row>
            </Notice>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            {list.length > 0 ? (
              <p className="mr-auto text-xs text-muted-foreground">Values are recorded as yours.</p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                className="h-9 pointer-coarse:min-h-11"
                disabled={busy}
                onClick={dismiss}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="h-auto min-h-9 rounded-lg whitespace-normal px-3.5 py-1.5 pointer-coarse:min-h-11"
                disabled={busy}
              >
                {busy ? 'Creating…' : `Create ${noun}`}
                {busy ? null : <ArrowRight size={14} aria-hidden />}
              </Button>
            </div>
          </div>
        </div>
      </Form>
    </Dialog>
  );
}

function DraftField({
  writing,
  apiName,
  descriptionLine,
  error,
  ref,
  ...input
}: InputProps & {
  writing?: 'title' | 'description';
  apiName?: string;
  descriptionLine?: string | undefined;
  error?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const { field, value, onChange } = input;
  const id = useId();
  const errorId = `${id}-error`;
  const controlState = {
    'aria-invalid': !!error,
    'aria-describedby': error ? errorId : undefined,
  };
  const { Input } = fields[field.type];
  if (writing) {
    const Control = writing === 'title' ? 'input' : 'textarea';
    return (
      <div ref={ref} className="min-w-0">
        <label htmlFor={id} className="sr-only">
          {field.label}
        </label>
        <Control
          id={id}
          aria-required={!field.isNullable}
          {...controlState}
          dir="auto"
          value={String(value ?? '')}
          placeholder={writing === 'title' ? field.label : `Add ${field.label.toLowerCase()}…`}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={cn(
            'w-full border-b border-transparent bg-transparent text-foreground caret-primary outline-none placeholder:text-muted-foreground focus-visible:border-input/80',
            writing === 'title'
              ? 'py-1.5 text-2xl font-semibold tracking-tight sm:text-3xl pointer-coarse:min-h-11'
              : 'field-sizing-content min-h-20 max-h-56 resize-y overflow-y-auto py-2 text-base supports-[field-sizing:content]:resize-none',
          )}
        />
        {apiName ? <ApiName>{apiName}</ApiName> : null}
        <DescriptionLine className="mt-1">{descriptionLine}</DescriptionLine>
        {error ? (
          <p id={errorId} className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <FormField
      ref={ref}
      label={field.label}
      apiName={apiName}
      descriptionLine={descriptionLine}
      hint={field.isNullable ? undefined : 'Required'}
      error={error}
      errorId={errorId}
      className="pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_input:not([type=checkbox],[type=radio])]:min-h-11 pointer-coarse:[&_input:not([type=checkbox],[type=radio])]:text-base"
    >
      <Input {...input} controlState={controlState} />
    </FormField>
  );
}
