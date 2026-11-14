import type { ExtensionMappingChoices, ExtensionMappingView } from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Button,
  Empty,
  Input,
  Label,
  Loading,
  Muted,
  Notice,
  Page,
  Panel,
  Row,
  Stack,
  StepActions,
  StepFlow,
  StepHeader,
} from '../../ui/index.js';
import { describeDiffOp } from '../schema/schema-model.js';
import { QueryError } from '../state.js';
import {
  choicesFromView,
  defaultChoices,
  MappingBindings,
  MappingFields,
  type MappingIssues,
  mappingObject,
  serverIssues,
} from './mapping.js';
import {
  accessText,
  type Installation,
  installedRelease,
  type Release,
  upgradeFor,
  useExtensions,
  useRefreshExtensions,
} from './model.js';
import { SettingFields } from './setting-fields.js';

type Settings = Installation['settings'];
type Preview = Awaited<ReturnType<typeof api.previewExtension>>;
type Plan = { preview: Preview; input: Parameters<typeof api.previewExtension>[0]; key: string };
type DiffOp = { kind: string; [key: string]: unknown };
/** What the flow does: a first install (or a reinstall), or a change to an installed extension. */
export type SetupMode = 'install' | 'upgrade' | 'reconnect' | 'mapping';
type Step = 'settings' | 'mapping' | 'review';

/**
 * The preview's schema changes to list. Fields the mapping creates are left
 * out: the mapping lines already show them as "New field".
 */
function previewSchemaOps(preview: Preview, mappingObjectId?: string) {
  const created = new Set(
    (preview.mapping ?? []).flatMap((b) =>
      b.action === 'create' && b.contribution && b.field ? [b.field.name] : [],
    ),
  );
  return (preview.operations as DiffOp[]).filter(
    (op) =>
      !(
        op.kind === 'create_field' &&
        op.objectId === mappingObjectId &&
        created.has(String((op.field as { name?: unknown } | undefined)?.name))
      ),
  );
}
const VIEW_ACTIONS = {
  create: 'Create',
  retain: 'Keep',
  update: 'Update',
  keep_workspace: 'Keep your edited',
  deleted_workspace: 'Do not recreate deleted',
} as const;
const TITLES: Record<SetupMode, (name: string) => string> = {
  install: (name) => `Set up ${name}`,
  upgrade: (name) => `Upgrade ${name}`,
  reconnect: (name) => `Reconnect ${name}`,
  mapping: (name) => `Edit ${name} mapping`,
};
const STEP_LABELS: Record<Step, string> = {
  settings: 'Connect',
  mapping: 'Map fields',
  review: 'Review and approve',
};

/**
 * Setting up an extension, or changing how an installed one connects, maps
 * or runs, as steps on a page: its settings, where its values go, then what
 * it will be allowed to do and change, which a person approves.
 */
export function ExtensionSetup({
  release,
  installation,
  mode,
  mappingView,
  onCancel,
  onDone,
}: {
  release: Release;
  /** The installation to change, or for `install` an uninstalled one to set up again. */
  installation?: Installation;
  mode: SetupMode;
  /** The approved mapping, for `mapping`. */
  mappingView?: ExtensionMappingView;
  onCancel: () => void;
  onDone: (installationId: string) => void;
}) {
  const { schema } = useWorkspace();
  const retained = installation?.state !== 'uninstalled' ? installation : undefined;
  const reconnect = mode === 'reconnect',
    editMapping = mode === 'mapping' && !!retained,
    upgrade = mode === 'upgrade' && !!retained;
  const mapping = release.manifest.mapping;
  const mapped = mapping ? mappingObject(schema.objects, mapping) : undefined;
  // A first install reviews the mapping; an upgrade carries the approved one over.
  const showMapping = !!mapping && (editMapping || (mode === 'install' && !retained));
  const hasSettings =
    !editMapping &&
    (Object.values(release.manifest.settings).some(
      (d) => !d.generated && (d.level ?? 'installation') === 'installation',
    ) ||
      (reconnect && !!release.manifest.source));
  const steps: Step[] = [
    ...(hasSettings ? (['settings'] as const) : []),
    ...(showMapping ? (['mapping'] as const) : []),
    'review',
  ];
  const [step, setStep] = useState(0);
  const current = steps[step] ?? 'review';
  const [choices, setChoices] = useState<ExtensionMappingChoices>(() =>
    mapping ? (mappingView ? choicesFromView(mapping, mappingView) : defaultChoices(mapping)) : {},
  );
  const [issues, setIssues] = useState<MappingIssues>({});
  const [values, setValues] = useState<Settings>(() => ({
    ...Object.fromEntries(
      Object.entries(release.manifest.settings)
        .filter(
          ([, def]) =>
            def.level !== 'connection' &&
            !def.secret &&
            (def.default !== undefined || def.type === 'boolean'),
        )
        .map(([key, def]) => [key, def.default ?? false]),
    ),
    ...installation?.settings,
  }));
  const [replaceSourceAccount, setReplaceSourceAccount] = useState(false);
  const grantIncrease =
    !!retained &&
    ((release.manifest.requestedActor === 'integration' && retained.grantedActor === 'agent') ||
      release.manifest.scopes.some((scope) => !retained.grantedScopes.includes(scope)));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [draftInstallationId, setDraftInstallationId] = useState(installation?.id);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const review = useMutation({
    mutationFn: async () => {
      const refs = { ...references };
      let draftId = draftInstallationId;
      for (const [name, value] of Object.entries(secrets)) {
        if (!value) continue;
        const staged = await api.stageExtensionSecret({
          registrationId: release.manifest.universalId,
          version: release.manifest.version,
          ...(draftId ? { installationId: draftId } : {}),
          name,
          value,
        });
        draftId = staged.installationId;
        setDraftInstallationId(staged.installationId);
        refs[name] = staged.pendingSecretId;
        setReferences((previous) => ({ ...previous, [name]: staged.pendingSecretId }));
        setSecrets((previous) => ({ ...previous, [name]: '' }));
      }
      const input = {
        ...(retained ? { installationId: retained.id } : {}),
        registrationId: release.manifest.universalId,
        version: release.manifest.version,
        ...(reconnect ? { reconnect: true, replaceSourceAccount } : {}),
        ...(grantIncrease ? { grantChange: true } : {}),
        settings: values,
        ...(Object.keys(refs).length ? { secretRefs: refs } : {}),
        ...(showMapping ? { mapping: choices } : {}),
        ...(editMapping ? { mappingChange: true } : {}),
      };
      try {
        const preview = await api.previewExtension(input);
        setPlan({ input, preview, key: crypto.randomUUID() });
        setStep(steps.length - 1);
      } catch (error) {
        if (error instanceof RetainerApiError && error.code === 'mapping_invalid') {
          setIssues(serverIssues(error.details));
          const at = steps.indexOf('mapping');
          if (at >= 0) setStep(at);
        }
        throw error;
      }
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error('Review the changes before approval.');
      const input = { ...plan.input, planDigest: plan.preview.planDigest };
      if (editMapping && retained) return api.changeExtensionMapping(retained.id, input, plan.key);
      if (reconnect && retained) return api.reconnectExtension(retained.id, input, plan.key);
      if (upgrade && retained) return api.upgradeExtension(retained.id, input, plan.key);
      return api.installExtension(input, plan.key);
    },
    onSuccess: (result) => onDone(result.id),
  });
  // With nothing to fill in, the flow opens on the review: prepare it once.
  const started = useRef(false);
  useEffect(() => {
    if (steps.length === 1 && !started.current) {
      started.current = true;
      review.mutate();
    }
  }, [steps.length, review]);
  const busy = review.isPending || save.isPending;
  const error = save.error ?? review.error;
  const last = step === steps.length - 2;
  const reviewLabel = reconnect
    ? 'Review reconnect'
    : editMapping
      ? 'Review mapping'
      : upgrade
        ? 'Review upgrade'
        : 'Review installation';
  const back = (to: number) => {
    if (busy) return;
    setPlan(null);
    save.reset();
    setStep(to);
  };
  const next = () => {
    if (last) review.mutate();
    else setStep(step + 1);
  };
  const actions = (
    <StepActions>
      {step > 0 ? (
        <Button disabled={busy} onClick={() => back(step - 1)}>
          Back
        </Button>
      ) : (
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {review.isPending ? 'Preparing review…' : last ? reviewLabel : 'Continue'}
      </Button>
    </StepActions>
  );
  const name = release.manifest.name;
  let body: ReactNode;
  if (current === 'settings')
    body = (
      <Form onSubmit={next}>
        <StepHeader
          title={reconnect ? 'New credentials' : upgrade ? 'Check settings' : `Connect ${name}`}
        >
          {reconnect
            ? 'Enter new credentials or account settings. Nothing changes until you approve.'
            : upgrade
              ? `Version ${release.manifest.version} keeps your settings. Change any before you review the upgrade.`
              : release.manifest.description}
        </StepHeader>
        <fieldset disabled={busy} className="flex flex-col gap-4">
          <SettingFields
            release={release}
            values={values}
            secrets={secrets}
            {...(retained ? { existing: retained } : {})}
            references={references}
            allowConnectionEdit={reconnect}
            onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
            onSecret={(key, value) => {
              setSecrets((v) => ({ ...v, [key]: value }));
              setReferences((v) => {
                const next = { ...v };
                delete next[key];
                return next;
              });
            }}
          />
          {reconnect && release.manifest.source ? (
            <Label>
              <Input
                type="checkbox"
                checked={replaceSourceAccount}
                onChange={(event) => setReplaceSourceAccount(event.target.checked)}
              />
              Use a different provider account
              <Muted small>
                Retire the previous account binding and callback addresses. Imported evidence stays
                in its existing namespace.
              </Muted>
            </Label>
          ) : null}
        </fieldset>
        {actions}
      </Form>
    );
  else if (current === 'mapping')
    body = (
      <Form onSubmit={next}>
        <fieldset disabled={busy} className="flex flex-col gap-3">
          {mapping && mapped ? (
            <MappingFields
              mapping={mapping}
              object={mapped}
              choices={choices}
              issues={issues}
              onChange={(key, choice) => {
                setChoices((c) => ({ ...c, [key]: choice }));
                setIssues(({ [key]: _, ...rest }) => rest);
              }}
              onImport={(next, found) => {
                setChoices(next);
                setIssues(found);
              }}
            />
          ) : (
            <Notice>
              This extension maps values to an object the web app cannot map yet. Use the API to
              review its mapping.
            </Notice>
          )}
          {editMapping && mapped ? (
            <Muted>
              Changing the mapping does not fill in existing {mapped.labelPlural.toLowerCase()}.
            </Muted>
          ) : null}
        </fieldset>
        {actions}
      </Form>
    );
  else
    body = (
      <Stack>
        <StepHeader title="Review and approve">
          Nothing changes until you approve. Check what {name} will be allowed to do and what it
          adds to this workspace.
        </StepHeader>
        {plan ? (
          <Review plan={plan} release={release} />
        ) : review.isPending ? (
          <Loading>Preparing the review…</Loading>
        ) : null}
        <StepActions>
          {steps.length > 1 ? (
            <Button disabled={busy} onClick={() => back(step - 1)}>
              Back
            </Button>
          ) : (
            <Button disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
          {plan ? (
            <Button variant="primary" disabled={busy} onClick={() => save.mutate()}>
              {save.isPending
                ? 'Approving…'
                : reconnect
                  ? 'Approve reconnect'
                  : editMapping
                    ? 'Approve mapping'
                    : grantIncrease
                      ? 'Approve access and upgrade'
                      : upgrade
                        ? 'Approve upgrade'
                        : 'Approve installation'}
            </Button>
          ) : !review.isPending ? (
            <Button variant="primary" onClick={() => review.mutate()}>
              Try again
            </Button>
          ) : null}
        </StepActions>
      </Stack>
    );
  return (
    <StepFlow
      label={`${TITLES[mode](name)} steps`}
      steps={steps.map((s) => (s === 'settings' && upgrade ? 'Settings' : STEP_LABELS[s]))}
      current={step}
      onBack={back}
    >
      {error ? <Notice error>{error.message}</Notice> : null}
      {body}
    </StepFlow>
  );
}

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** What approving will do: access, schema changes, field mapping, saved views and warnings. */
function Review({ plan, release }: { plan: Plan; release: Release }) {
  const { schema } = useWorkspace();
  const mapping = release.manifest.mapping;
  const schemaOps = previewSchemaOps(plan.preview, mapping?.objectId);
  const { preview } = plan;
  return (
    <Stack>
      <Panel title="Access">
        <Stack>
          <p className="text-sm">{accessText(preview.grants.scopes, preview.grants.actor)}</p>
          {preview.previousGrants ? (
            <Notice>
              This approval changes access from {preview.previousGrants.scopes.join(' and ')} as an{' '}
              {preview.previousGrants.actor} to {preview.grants.scopes.join(' and ')} as an{' '}
              {preview.grants.actor}.
            </Notice>
          ) : null}
          <Muted>
            Creates people:{' '}
            {String(plan.input.settings.createPeople ?? release.manifest.createPeople).replaceAll(
              '_',
              ' ',
            )}
            . When something is deleted at the source:{' '}
            {release.manifest.onSourceDelete === 'keep'
              ? 'keep what was imported'
              : 'remove what was imported from it'}
            .
          </Muted>
        </Stack>
      </Panel>
      <Panel title="Changes to this workspace">
        <Stack>
          {schemaOps.length ? (
            <ul className="list-disc pl-5 text-sm">
              {schemaOps.map((operation) => (
                <li key={JSON.stringify(operation)}>{describeDiffOp(operation, schema.objects)}</li>
              ))}
            </ul>
          ) : preview.mapping?.length ? null : (
            <Muted>No schema changes.</Muted>
          )}
          {preview.mapping && mapping ? (
            <MappingBindings mapping={mapping} bindings={preview.mapping} />
          ) : null}
          {preview.views.map((view) => (
            <p key={view.universalId} className="text-sm">
              {VIEW_ACTIONS[view.action]} saved view: {view.name}
            </p>
          ))}
        </Stack>
      </Panel>
      {preview.warnings.map((warning) => (
        <Notice key={warning}>{warning}</Notice>
      ))}
    </Stack>
  );
}

/** A setup page's frame: its title and a way back, around what is loaded. */
function SetupPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page
      eyebrow="Extensions"
      title={title}
      actions={
        <Button variant="ghost" size="small" asChild>
          <Link to="/extensions">All extensions</Link>
        </Button>
      }
    >
      {children}
    </Page>
  );
}

/** `/extensions/new/:registration`: set up the newest release of an extension. */
export function ExtensionInstallPage() {
  const { registration } = useParams({ strict: false }) as { registration: string };
  const navigate = useNavigate();
  const { session } = useWorkspace();
  const { data, error, retry } = useExtensions();
  const refresh = useRefreshExtensions();
  if (error)
    return (
      <SetupPage title="Set up an extension">
        <QueryError error={error} retry={retry} />
      </SetupPage>
    );
  if (!data)
    return (
      <SetupPage title="Set up an extension">
        <Loading>Loading extension…</Loading>
      </SetupPage>
    );
  const release = data.newest.get(registration);
  const existing = data.installed.find((i) => i.registrationId === registration);
  if (!release)
    return (
      <SetupPage title="Set up an extension">
        <Empty
          title="Extension not found"
          description="This server does not offer this extension."
        />
      </SetupPage>
    );
  if (!canMutate(session, 'admin'))
    return (
      <SetupPage title={TITLES.install(release.manifest.name)}>
        <Notice>A workspace admin can set up this extension.</Notice>
      </SetupPage>
    );
  if (existing && existing.state !== 'uninstalled')
    return (
      <SetupPage title={TITLES.install(release.manifest.name)}>
        <Notice>
          <Row>
            {release.manifest.name} is already installed.
            <Link to="/extensions/$id" params={{ id: existing.id }} className="underline">
              Open it
            </Link>
          </Row>
        </Notice>
      </SetupPage>
    );
  return (
    <SetupPage title={TITLES.install(release.manifest.name)}>
      <ExtensionSetup
        release={release}
        {...(existing ? { installation: existing } : {})}
        mode="install"
        onCancel={() => void navigate({ to: '/extensions' })}
        onDone={(id) => {
          void refresh();
          void navigate({ to: '/extensions/$id', params: { id } });
        }}
      />
    </SetupPage>
  );
}

function ChangePage({ mode }: { mode: Exclude<SetupMode, 'install'> }) {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { session } = useWorkspace();
  const { data, error, retry } = useExtensions();
  const refresh = useRefreshExtensions();
  const detail = useQuery({
    queryKey: ['extensions', 'detail', id],
    queryFn: ({ signal }) => api.extension(id, signal),
    enabled: mode === 'mapping',
  });
  const installation = data?.installed.find((i) => i.id === id);
  const name = installation
    ? (installedRelease(data?.releases ?? [], installation)?.manifest.name ?? 'extension')
    : 'extension';
  const title = TITLES[mode](name);
  const fail = error ?? detail.error;
  if (fail)
    return (
      <SetupPage title={title}>
        <QueryError
          error={fail}
          retry={() => {
            retry();
            void detail.refetch();
          }}
        />
      </SetupPage>
    );
  if (!data || (mode === 'mapping' && !detail.data))
    return (
      <SetupPage title={title}>
        <Loading>Loading extension…</Loading>
      </SetupPage>
    );
  const release = !installation
    ? undefined
    : mode === 'upgrade'
      ? upgradeFor(data.newest, installation)
      : installedRelease(data.releases, installation);
  const toDetail = () => void navigate({ to: '/extensions/$id', params: { id } });
  const problem = !installation
    ? 'This extension is not installed in this workspace.'
    : !canMutate(session, 'admin')
      ? 'A workspace admin can change this extension.'
      : !release
        ? mode === 'upgrade'
          ? 'This extension is already on the newest version.'
          : 'This server no longer offers the installed version.'
        : mode === 'mapping' && !detail.data?.mapping
          ? 'This extension has no field mapping.'
          : null;
  if (problem || !installation || !release)
    return (
      <SetupPage title={title}>
        <Notice>{problem}</Notice>
      </SetupPage>
    );
  return (
    <SetupPage title={title}>
      <ExtensionSetup
        release={release}
        installation={installation}
        mode={mode}
        {...(detail.data?.mapping ? { mappingView: detail.data.mapping } : {})}
        onCancel={toDetail}
        onDone={() => {
          void refresh();
          toDetail();
        }}
      />
    </SetupPage>
  );
}
export const ExtensionUpgradePage = () => <ChangePage mode="upgrade" />;
export const ExtensionReconnectPage = () => <ChangePage mode="reconnect" />;
export const ExtensionMappingPage = () => <ChangePage mode="mapping" />;
