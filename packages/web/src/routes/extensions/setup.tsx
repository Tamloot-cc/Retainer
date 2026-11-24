import {
  type ExtensionBindingChoices,
  type ExtensionInstallInput,
  type ExtensionSuggestions,
  hasOptionalSetupModel,
  mergeBindingChoices,
  releaseUses,
  sourceDeletePolicy,
} from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Info, LayoutList, Settings2, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Checkbox,
  Empty,
  Loading,
  MappingDisclosure,
  Muted,
  Notice,
  Page,
  Row,
  Stack,
  StepActions,
  StepFlow,
  StepHeader,
} from '../../ui/index.js';
import {
  ReviewCard,
  ReviewCardBody,
  ReviewCardFooter,
  ReviewCardHeader,
  ReviewIcon,
  ReviewNote,
} from '../../ui/review.js';
import { describeDiffOp } from '../schema/schema-model.js';
import { QueryError } from '../state.js';
import { BindingFields, type BindingReviewIssue, BindingSummary } from './bindings.js';
import { extensionName } from './branding.js';
import {
  canSuggest,
  detailKey,
  hasInstallationSettings,
  type Installation,
  initialSettings,
  installedRelease,
  optionLabel,
  type Release,
  upgradeFor,
  useExtensions,
  useRefreshExtensions,
} from './model.js';
import { SettingFields } from './setting-fields.js';
import { ExtensionCard } from './surface.js';

type Settings = Installation['settings'];
type Preview = Awaited<ReturnType<typeof api.previewExtension>>;
type Plan = { preview: Preview; input: Parameters<typeof api.previewExtension>[0]; key: string };
type DiffOp = { kind: string; [key: string]: unknown };
/** What the flow does: a first install (or a reinstall), or a change to an installed extension. */
type SetupMode = 'install' | 'upgrade' | 'reconnect' | 'bindings';
type Step = 'settings' | 'bindings' | 'review';

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
  bindings: (name) => `Change ${name} setup`,
};
const STEP_LABELS: Record<Step, string> = {
  settings: 'Connect',
  bindings: 'Choose destinations',
  review: 'Review setup',
};

/**
 * Setting up an extension, or changing how an installed one connects, maps
 * or runs, as steps on a page: its settings, where its values go, then what
 * it will be allowed to do and change, which a person approves.
 */
export function ExtensionSetup(props: Parameters<typeof BasicExtensionSetup>[0]) {
  const configure = props.release.manifest.functions.some((fn) => fn.trigger.kind === 'configure');
  // Suggestions run only for an active installation. A disabled one, such as
  // after a failed upgrade, upgrades with its approved mapping carried over.
  const inactiveUpgrade =
    props.mode === 'upgrade' && !canSuggest(props.release, props.installation);
  if (!configure || props.mode === 'reconnect' || inactiveUpgrade)
    return <BasicExtensionSetup {...props} />;
  return <ConfigureSetup {...props} />;
}

function ConfigureSetup(props: Parameters<typeof BasicExtensionSetup>[0]) {
  const client = useQueryClient();
  const refresh = useRefreshExtensions();
  const [installation, setInstallation] = useState(props.installation);
  const optionalModel = hasOptionalSetupModel(props.release.manifest);
  const needsModelApproval =
    optionalModel &&
    installation?.releaseDigest === props.release.digest &&
    !installation.grantedUses.includes('model');
  const [phase, setPhase] = useState<
    'choice' | 'manual' | 'checking' | 'access' | 'waiting' | 'review'
  >(
    props.mode === 'upgrade' && props.installation
      ? 'checking'
      : props.mode === 'bindings'
        ? needsModelApproval
          ? 'review'
          : 'waiting'
        : props.installation?.state === 'configuring'
          ? 'waiting'
          : optionalModel
            ? 'choice'
            : 'access',
  );
  const [providedSecrets, setProvidedSecrets] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<ExtensionSuggestions>();
  const query = useQuery({
    queryKey: ['extension-suggestions', installation?.id, props.release.digest],
    queryFn: ({ signal }) => {
      if (!installation) throw new Error('Installation is required');
      return api.extensionSuggestions(installation.id, props.release.manifest.version, signal);
    },
    enabled: ['checking', 'waiting'].includes(phase) && !!installation,
    refetchInterval: phase === 'waiting' ? 1000 : false,
  });
  useEffect(() => {
    if (!query.data) return;
    if (phase === 'checking') {
      if (query.isFetching) return;
      if (!query.data.access) {
        setPhase(optionalModel ? 'choice' : 'access');
        return;
      }
      const approvedSettings = query.data.access.settings;
      setInstallation((current) =>
        current ? { ...current, settings: approvedSettings } : current,
      );
      setProvidedSecrets(query.data.access.secrets);
      if (['ready', 'failed'].includes(query.data.status)) {
        setSuggested(query.data);
        setPhase('review');
      } else setPhase('waiting');
    } else if (
      phase === 'waiting' &&
      !query.isFetching &&
      ['ready', 'failed'].includes(query.data.status)
    ) {
      if (query.data.access) setProvidedSecrets(query.data.access.secrets);
      setSuggested(query.data);
      setPhase('review');
    }
  }, [phase, query.data, query.isFetching, optionalModel]);
  const cancel = useMutation({
    mutationFn: async () => {
      if (installation?.state === 'active')
        await api.cancelExtensionSuggestions(installation.id, props.release.manifest.version);
      if (installation?.state === 'configuring') {
        await api.uninstallExtension(installation.id);
        await refresh();
      }
      props.onCancel();
    },
  });
  const again = useMutation({
    mutationFn: async () => {
      if (!installation) return;
      await api.configureExtension(installation.id, props.release.manifest.version);
      setSuggested(undefined);
      await query.refetch();
      setPhase('waiting');
    },
  });
  const approve = useMutation({
    mutationFn: async ({ id, input }: { id: string; input?: ExtensionInstallInput }) => {
      const current = await api.extension(id);
      setInstallation({ ...current, settings: input?.settings ?? current.settings });
      setProvidedSecrets(Object.keys(input?.secretRefs ?? {}));
      const review = await api.extensionSuggestions(id, props.release.manifest.version);
      client.setQueryData(['extension-suggestions', id, props.release.digest], review);
      await refresh();
      setPhase('waiting');
    },
  });
  if (phase === 'choice')
    return (
      <ExtensionCard title="Choose how to set up destinations" icon={LayoutList}>
        <p className="text-sm">
          Choose where to save meetings, tasks, and contacts, or ask AI to suggest a setup you can
          review.
        </p>
        <Row>
          <Button type="button" onClick={() => setPhase('manual')}>
            Set up manually
          </Button>
          <Button type="button" onClick={() => setPhase('access')}>
            Get AI suggestions
          </Button>
        </Row>
      </ExtensionCard>
    );
  if (phase === 'manual')
    return (
      <BasicExtensionSetup
        {...props}
        manualSetup={props.mode === 'install'}
        onCancel={() => setPhase('choice')}
      />
    );
  if (phase === 'access')
    return (
      <Stack>
        {approve.error ? <Notice error>{approve.error.message}</Notice> : null}
        <BasicExtensionSetup
          {...props}
          accessOnly
          onCancel={() =>
            optionalModel
              ? setPhase(props.mode === 'bindings' ? 'review' : 'choice')
              : cancel.mutate()
          }
          onDone={(id, input) => approve.mutate({ id, ...(input ? { input } : {}) })}
        />
      </Stack>
    );
  if (phase === 'waiting' || phase === 'checking')
    return (
      <ExtensionCard title="Configuration suggestions" icon={Settings2}>
        <Loading>Preparing suggestions…</Loading>
        {query.error ? <Notice error>{query.error.message}</Notice> : null}
        <Row>
          <Button onClick={() => setPhase('review')}>
            {optionalModel ? 'Continue without waiting' : 'Skip suggestions'}
          </Button>
          <Button onClick={props.onCancel}>Continue later</Button>
        </Row>
      </ExtensionCard>
    );
  return (
    <Stack>
      {suggested?.status === 'failed' ? (
        <Notice>
          Suggestions aren't available: {suggested.code ?? 'run_failed'}. You can fill in the form
          by hand.
        </Notice>
      ) : null}
      {again.error ? <Notice error>{again.error.message}</Notice> : null}
      {cancel.error ? <Notice error>{cancel.error.message}</Notice> : null}
      {props.mode === 'upgrade' ? (
        <Button onClick={() => setPhase('access')}>Review access again</Button>
      ) : null}
      <BasicExtensionSetup
        providedSecrets={providedSecrets}
        key={suggested ? JSON.stringify(suggested) : 'manual'}
        {...props}
        onCancel={() => cancel.mutate()}
        {...(installation ? { installation } : {})}
        {...(suggested ? { suggestions: suggested } : {})}
        suggestAction={
          installation ? (
            <Button
              variant="ghost"
              disabled={again.isPending}
              onClick={() => (needsModelApproval ? setPhase('access') : again.mutate())}
            >
              {again.isPending
                ? 'Requesting…'
                : suggested
                  ? 'Suggest again'
                  : optionalModel
                    ? 'Get AI suggestions'
                    : 'Get suggestions'}
            </Button>
          ) : undefined
        }
      />
    </Stack>
  );
}

function BasicExtensionSetup({
  release,
  installation,
  mode,
  bindingChoices,
  onCancel,
  onDone,
  accessOnly = false,
  manualSetup = false,
  suggestions,
  providedSecrets = [],
  suggestAction,
}: {
  release: Release;
  /** The installation to change, or for `install` an uninstalled one to set up again. */
  installation?: Installation;
  mode: SetupMode;
  accessOnly?: boolean;
  manualSetup?: boolean;
  providedSecrets?: string[];
  suggestions?: ExtensionSuggestions;
  bindingChoices?: ExtensionBindingChoices;
  /** Asks the extension for new suggestions; shown on the destinations step. */
  suggestAction?: ReactNode;
  onCancel: () => void;
  onDone: (installationId: string, input?: ExtensionInstallInput) => void;
}) {
  const { schema } = useWorkspace();
  const retained = installation?.state !== 'uninstalled' ? installation : undefined;
  const reconnect = mode === 'reconnect',
    editBindings = mode === 'bindings' && !!retained,
    upgrade = mode === 'upgrade' && !!retained;
  const declarations = release.manifest.bindings;
  const showBindings = !accessOnly && !!declarations?.length && !reconnect;
  const turnOn = retained?.state === 'configuring' && !accessOnly;
  const hasSettings =
    (!editBindings || !!declarations) &&
    (hasInstallationSettings(release) || (reconnect && !!release.manifest.source));
  const steps: Step[] = [
    ...(hasSettings ? (['settings'] as const) : []),
    ...(showBindings ? (['bindings'] as const) : []),
    'review',
  ];
  const reviewTitle = accessOnly ? 'Review access' : STEP_LABELS.review;
  const [step, setStep] = useState(0);
  const current = steps[step] ?? 'review';
  const [bound, setBound] = useState<ExtensionBindingChoices>(() =>
    mergeBindingChoices(bindingChoices, release.bindingProposal?.choices, suggestions?.bindings),
  );
  const [bindingIssues, setBindingIssues] = useState<BindingReviewIssue[]>(() =>
    Object.entries(suggestions?.issues ?? {}).map(([path, message]) => {
      const [binding, field] = path.split('.');
      return { binding: binding ?? '*', field, message };
    }),
  );
  const [values, setValues] = useState<Settings>(() => ({
    ...initialSettings(release, installation),
    ...suggestions?.settings,
  }));
  const [replaceSourceAccount, setReplaceSourceAccount] = useState(false);
  const grantIncrease =
    !!retained &&
    ((release.manifest.requestedActor === 'integration' && retained.grantedActor === 'agent') ||
      release.manifest.scopes.some((scope) => !retained.grantedScopes.includes(scope)) ||
      (!hasOptionalSetupModel(release.manifest) &&
        releaseUses(release.manifest).some((use) => !retained.grantedUses.includes(use))));
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
        ...(manualSetup ? { manualSetup: true } : {}),
        ...(accessOnly ? { accessOnly: true } : {}),
        ...(turnOn ? { turnOn: true } : {}),
        ...(retained ? { installationId: retained.id } : {}),
        registrationId: release.manifest.universalId,
        version: release.manifest.version,
        ...(reconnect ? { reconnect: true, replaceSourceAccount } : {}),
        ...(grantIncrease ? { grantChange: true } : {}),
        settings: values,
        ...(Object.keys(refs).length ? { secretRefs: refs } : {}),
        ...(showBindings && Object.keys(bound).length ? { bindings: bound } : {}),
      };
      try {
        const preview = await api.previewExtension(input);
        setPlan({ input, preview, key: crypto.randomUUID() });
        if (preview.bindings) setBound(preview.bindings);
        setStep(steps.length - 1);
      } catch (error) {
        if (
          error instanceof RetainerApiError &&
          showBindings &&
          ['bindings_invalid', 'schema_invalid'].includes(error.code)
        ) {
          const details = error.details as
            | { bindings?: BindingReviewIssue[]; issues?: { path: string; message: string }[] }
            | undefined;
          setBindingIssues(details?.bindings ?? []);
          const at = steps.indexOf('bindings');
          if (at >= 0) setStep(at);
        }
        throw error;
      }
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error('Review the changes before approval.');
      const input = {
        ...(accessOnly ? { accessOnly: true } : {}),
        ...(turnOn ? { turnOn: true } : {}),
        ...plan.input,
        planDigest: plan.preview.planDigest,
      };
      if (accessOnly && retained) return api.approveExtensionAccess(retained.id, input, plan.key);
      if (turnOn && retained) return api.turnOnExtension(retained.id, input, plan.key);
      if (editBindings && retained) return api.upgradeExtension(retained.id, input, plan.key);
      if (reconnect && retained) return api.reconnectExtension(retained.id, input, plan.key);
      if (upgrade && retained) return api.upgradeExtension(retained.id, input, plan.key);
      return api.installExtension(input, plan.key);
    },
    onSuccess: (result) => (accessOnly ? onDone(result.id, plan?.input) : onDone(result.id)),
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
  const schemaIssues =
    error instanceof RetainerApiError && error.code === 'schema_invalid'
      ? (error.details as { issues?: { path: string; message: string }[] } | undefined)?.issues
      : undefined;
  const last = step === steps.length - 2;
  const reviewAI = accessOnly && hasOptionalSetupModel(release.manifest);
  const reviewLabel = reviewAI
    ? 'Review AI access'
    : reconnect
      ? 'Review reconnect'
      : editBindings
        ? 'Review new plan'
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
    <>
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
    </>
  );
  const name = extensionName(release.manifest.universalId, release.manifest.name);
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
        {suggestAction && !showBindings ? <Row>{suggestAction}</Row> : null}
        <ExtensionCard title="Extension settings" icon={Settings2} actions={actions}>
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <SettingFields
              release={release}
              values={values}
              secrets={secrets}
              {...(retained ? { existing: retained } : {})}
              references={references}
              allowConnectionEdit={reconnect || retained?.state === 'configuring'}
              allowNewCredentials={accessOnly || upgrade}
              providedSecrets={providedSecrets}
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
              <Checkbox
                variant="card"
                checked={replaceSourceAccount}
                onChange={(event) => setReplaceSourceAccount(event.target.checked)}
                label="Use a different provider account"
                description="Retire the previous account binding and callback addresses. Imported evidence stays in its existing namespace."
              />
            ) : null}
          </fieldset>
        </ExtensionCard>
      </Form>
    );
  else if (current === 'bindings') {
    const proposedBy =
      release.bindingProposal &&
      Object.keys(release.bindingProposal.choices).some((key) => !suggestions?.bindings?.[key])
        ? (release.bindingProposal.proposedBy.name ?? release.bindingProposal.proposedBy.id)
        : undefined;
    body = (
      <Form onSubmit={next}>
        <Stack>
          <StepHeader title={`Where ${name} saves data`} />
          {proposedBy ? <Muted>Proposed by {proposedBy}.</Muted> : null}
          <fieldset disabled={busy}>
            {showBindings && declarations ? (
              <BindingFields
                extension={name}
                declarations={declarations}
                choices={bound}
                objects={schema.objects}
                issues={bindingIssues}
                suggested={suggestions?.bindings}
                reasons={suggestions?.bindingReasons}
                onChange={(key, choice) => {
                  setBound((prior) => ({ ...prior, [key]: choice }));
                  setBindingIssues((prior) => prior.filter((issue) => issue.binding !== key));
                }}
              />
            ) : null}
          </fieldset>
          <StepActions>
            {suggestAction ? <div className="mr-auto">{suggestAction}</div> : null}
            {actions}
          </StepActions>
        </Stack>
      </Form>
    );
  } else {
    const backButton =
      steps.length > 1 ? (
        <Button disabled={busy} onClick={() => back(step - 1)}>
          Back
        </Button>
      ) : (
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      );
    body = (
      <Stack>
        <StepHeader title={reviewTitle} />
        {plan ? (
          <Review plan={plan} release={release}>
            {backButton}
            <Button variant="primary" disabled={busy} onClick={() => save.mutate()}>
              {save.isPending
                ? mode === 'install' && !accessOnly && !turnOn
                  ? 'Installing…'
                  : 'Approving…'
                : reconnect
                  ? 'Approve reconnect'
                  : accessOnly
                    ? reviewAI
                      ? 'Approve and get suggestions'
                      : 'Approve access'
                    : editBindings
                      ? 'Approve new plan'
                      : turnOn
                        ? `Turn on ${name}`
                        : grantIncrease
                          ? 'Approve access and upgrade'
                          : upgrade
                            ? 'Approve upgrade'
                            : `Install ${name}`}
            </Button>
          </Review>
        ) : (
          <>
            {review.isPending ? <Loading>Preparing the review…</Loading> : null}
            <StepActions>
              {backButton}
              {!review.isPending ? (
                <Button variant="primary" onClick={() => review.mutate()}>
                  Try again
                </Button>
              ) : null}
            </StepActions>
          </>
        )}
      </Stack>
    );
  }
  return (
    <StepFlow
      label={`${TITLES[mode](name)} steps`}
      steps={steps.map((s) => {
        if (s === 'review') return reviewTitle;
        return s === 'settings' && upgrade ? 'Settings' : STEP_LABELS[s];
      })}
      current={step}
      onBack={back}
    >
      {error ? (
        <Notice error>
          {schemaIssues?.length ? (
            <ul className="list-disc space-y-1 pl-4">
              {schemaIssues.map(({ path, message }) => (
                <li key={`${path}:${message}`}>
                  {path ? `${path}: ` : ''}
                  {message}
                </li>
              ))}
            </ul>
          ) : (
            error.message
          )}
        </Notice>
      ) : null}
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

/** "read and write as an agent", plus model use when granted. */
function grantSummary(grants: { actor: string; scopes: string[]; uses: string[] }) {
  return `${grants.scopes.join(' and ')}${grants.uses.includes('model') ? ' with model use' : ''} as an ${grants.actor}`;
}

/** What approving will do: access, schema changes, field mapping, saved views and warnings. */
function Review({
  plan,
  release,
  children,
}: {
  plan: Plan;
  release: Release;
  children: ReactNode;
}) {
  const { schema } = useWorkspace();
  const { preview } = plan;
  const { grants } = preview;
  const canRead = grants.scopes.includes('read');
  const canWrite = grants.scopes.includes('write');
  const schemaOps = preview.operations as DiffOp[];
  const hasChanges = schemaOps.length > 0 || !!preview.bindings || preview.views.length > 0;
  const createPeople = String(plan.input.settings.createPeople ?? release.manifest.createPeople);
  const name = extensionName(release.manifest.universalId, release.manifest.name);
  const notes = [
    ...preview.notices,
    ...(preview.previousGrants
      ? [`Access changes from ${grantSummary(preview.previousGrants)} to ${grantSummary(grants)}.`]
      : []),
    ...preview.warnings,
  ];
  const access = [
    {
      label: 'CRM data',
      value: canRead ? (canWrite ? 'Read and write' : 'Read') : canWrite ? 'Write' : 'None',
    },
    ...(canWrite
      ? [
          {
            label: 'Writes recorded as',
            value: grants.actor === 'agent' ? 'Agent' : 'Integration',
          },
          { label: 'Create people', value: optionLabel('createPeople', createPeople) },
          ...(release.manifest.source
            ? [
                {
                  label: `Deleted in ${name}`,
                  value: optionLabel(
                    'onSourceDelete',
                    sourceDeletePolicy(release.manifest, plan.input.settings),
                  ),
                },
              ]
            : []),
        ]
      : []),
  ];

  return (
    <Stack>
      <ReviewCard>
        <ReviewCardHeader leading={<ReviewIcon icon={ShieldCheck} />} title="Access" />
        <ReviewCardBody>
          <dl className="flex flex-wrap gap-2">
            {access.map(({ label, value }) => (
              <div key={label} className="min-w-0 max-w-full rounded-md bg-muted/50 px-2.5 py-1.5">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {notes.length ? (
            <div className="border-t border-border pt-3">
              <ReviewNote icon={Info}>
                <ul aria-label="Setup notes" className="space-y-1.5">
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </ReviewNote>
            </div>
          ) : null}
        </ReviewCardBody>
      </ReviewCard>
      {hasChanges ? (
        <ReviewCard>
          <ReviewCardHeader leading={<ReviewIcon icon={LayoutList} />} title="Workspace changes" />
          <ReviewCardBody>
            {release.manifest.bindings && preview.bindings ? (
              <BindingSummary
                extension={name}
                declarations={release.manifest.bindings}
                choices={preview.bindings}
                objects={schema.objects}
                discloseFields
              />
            ) : null}
            {schemaOps.length ? (
              <MappingDisclosure
                label="List and field changes"
                summary={<Badge>{schemaOps.length}</Badge>}
                subtle={!!preview.bindings}
              >
                <ul className="list-disc space-y-1 pl-7 text-sm">
                  {schemaOps.map((operation) => (
                    <li key={JSON.stringify(operation)}>
                      {describeDiffOp(operation, schema.objects)}
                    </li>
                  ))}
                </ul>
              </MappingDisclosure>
            ) : null}
            {preview.views.length ? (
              <MappingDisclosure
                label="Saved views"
                summary={<Badge>{preview.views.length}</Badge>}
              >
                <ul className="list-disc space-y-1 pl-7 text-sm">
                  {preview.views.map((view) => (
                    <li key={view.universalId}>
                      {VIEW_ACTIONS[view.action]} {view.name}
                    </li>
                  ))}
                </ul>
              </MappingDisclosure>
            ) : null}
          </ReviewCardBody>
        </ReviewCard>
      ) : null}
      <ReviewCardFooter className="sticky bottom-0 z-10 -mx-4 bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:rounded-lg sm:border sm:bg-muted/30 sm:pb-3">
        {children}
      </ReviewCardFooter>
    </Stack>
  );
}

/** A setup page's frame: its title and a way back, around what is loaded. */
function SetupPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page
      eyebrow="Extensions"
      eyebrowLink={{ to: '/extensions' }}
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
  const existing = data.installed.find((i) => i.registrationId === registration);
  const release =
    existing?.state === 'configuring'
      ? installedRelease(data.releases, existing)
      : data.newest.get(registration);
  if (!release)
    return (
      <SetupPage title="Set up an extension">
        <Empty
          title="Extension not found"
          description="This server does not offer this extension."
        />
      </SetupPage>
    );
  const name = extensionName(release.manifest.universalId, release.manifest.name);
  if (!canMutate(session, 'admin'))
    return (
      <SetupPage title={TITLES.install(name)}>
        <Notice>A workspace admin can set up this extension.</Notice>
      </SetupPage>
    );
  if (existing && !['configuring', 'uninstalled'].includes(existing.state))
    return (
      <SetupPage title={TITLES.install(name)}>
        <Notice>
          <Row>
            {name} is already installed.
            <Link to="/extensions/$id" params={{ id: existing.id }} className="underline">
              Open it
            </Link>
          </Row>
        </Notice>
      </SetupPage>
    );
  return (
    <SetupPage title={TITLES.install(name)}>
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
    queryKey: detailKey(id),
    queryFn: ({ signal }) => api.extension(id, signal),
    enabled: mode === 'bindings' || mode === 'upgrade',
  });
  const installation = data?.installed.find((i) => i.id === id);
  const currentRelease = installation && installedRelease(data?.releases ?? [], installation);
  const name = installation
    ? extensionName(installation.registrationId, currentRelease?.manifest.name ?? 'extension')
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
  if (!data || (['bindings', 'upgrade'].includes(mode) && !detail.data))
    return (
      <SetupPage title={title}>
        <Loading>Loading extension…</Loading>
      </SetupPage>
    );
  const release = !installation
    ? undefined
    : mode === 'upgrade'
      ? upgradeFor(data.newest, installation)
      : currentRelease;
  const toDetail = () => void navigate({ to: '/extensions/$id', params: { id } });
  const problem = !installation
    ? 'This extension is not installed in this workspace.'
    : !canMutate(session, 'admin')
      ? 'A workspace admin can change this extension.'
      : !release
        ? mode === 'upgrade'
          ? 'This extension is already on the newest version.'
          : 'This server no longer offers the installed version.'
        : mode === 'bindings' && !release.manifest.bindings
          ? 'This extension has no bindings to edit.'
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
        bindingChoices={detail.data?.bindingChoices}
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
export const ExtensionBindingsPage = () => <ChangePage mode="bindings" />;
