import {
  compareVersions,
  type ExtensionBindingChoices,
  type ExtensionManifest,
  TAMLOOT_REGISTRATION_ID,
} from '@retainer/extension';
import { gmailRegistrationId } from '@retainer/extension/nango-gmail';
import type { Sql } from '../db/client.js';
import { jsonValue, lockPrivacyShared, lockSchemaExclusive, type Tx } from '../db/tx.js';
import { presentBindingPlan, type StoredBindingPlan } from '../extension-runtime/bindings.js';
import { resolveBindingPlan } from '../extensions/bindings.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import { creationPolicy } from '../extensions/creation-policy.js';
import { loadSchemaState } from '../schema/load.js';
import type { SchemaState } from '../schema/types.js';

// This private map is the one sanctioned use of former base schema IDs in
// application code, solely to migrate pre-bindings installations. No runtime
// path may import it. New installations use the binding review.
const old = {
  person: '7e87d873-8c93-4786-9a0b-95447310c8d3',
  company: '1f24f94d-6bc5-4955-b6ab-ac946e2b140a',
  task: 'd0690d5f-d7f4-47ce-8007-0a81a276a70b',
  conversation: '564ad764-a57c-4741-ad63-61604fa4cf5a',
  taskId: '72ef5898-253b-4335-bcdb-50dfc8031095',
  taskTitle: '5f37aa96-fac8-4572-9647-6b0da5d6d0c8',
  taskStatus: '107158ae-ba0f-482e-afe1-5e45bd6ccfd6',
  taskPerson: '3d66fcfe-2e9c-4aeb-a88a-7d6b3c2194ba',
  companyDomain: 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641',
  companyName: 'ba596fe8-a75f-4a88-9d80-ca22d51d7c72',
  medium: '6475aaeb-54ab-4e7c-8e43-d1a4469a12a0',
  transcript: 'fe832d36-cccb-48e4-8423-942e793741f9',
  granolaUrl: '0833a814-d14f-4700-915a-10fae4d3c279',
  personContact: '7131412f-cc90-4a45-9482-3a9060bf9426',
  companyContact: '92166eb2-4d95-477e-8db6-04ed3c0094f5',
};

const registrations = {
  tamloot: TAMLOOT_REGISTRATION_ID,
  granola: '9e427713-3c8a-4981-872c-c8db69703113',
  gmail: gmailRegistrationId,
  enrichment: '9796c2c7-46f3-4006-8f35-059d5ef3553e',
  lastContact: 'c1e8ba8a-69bb-4b2e-8db3-6ddc6c7b1606',
};
// Before bindings, these registrations wrote to the former base schema.
const formerBaseUsers = new Set(Object.values(registrations));

type LegacyMapping = { outputs?: Record<string, { fieldUniversalId: string }> };

type Row = {
  id: string;
  workspace_id: string;
  registration_id: string;
  release_digest: string;
  state: string;
  /** Absent before the generated DDL runs, including in the pre-merge report. */
  bindings?: { legacyMapping?: LegacyMapping };
  mapping?: LegacyMapping;
  settings: Record<string, unknown> & { createPeople?: ExtensionManifest['createPeople'] };
};

type Release = ReturnType<ExtensionCatalog['list']>[number];

function existingPlan(
  state: SchemaState,
  row: Row,
  manifest: ExtensionManifest,
  createPeople: ExtensionManifest['createPeople'],
): StoredBindingPlan {
  const choices: ExtensionBindingChoices = {};
  const prior: StoredBindingPlan = {
    extension: manifest.name,
    declarations: manifest.bindings ?? [],
    destinations: {},
    createPeople,
  };
  const bind = (
    key: string,
    id: string,
    ids: Record<string, string | undefined> = {},
    values: Record<string, Record<string, string>> = {},
  ) => {
    const object = state.objects.find(
      (entry) => entry.universalId === id && entry.status === 'active',
    );
    if (!object) throw new Error(`The previous destination for ${key} is missing or deleted.`);
    const declaration = prior.declarations.find((entry) => entry.key === key);
    if (!declaration) throw new Error(`The rebuilt release does not declare ${key}.`);
    const fields: NonNullable<
      Extract<ExtensionBindingChoices[string], { action: 'existing' }>['fields']
    > = {};
    const destinations: NonNullable<StoredBindingPlan['destinations'][string]>['fields'] = {};
    for (const rule of declaration.fields) {
      const field = object.fields.find(
        (entry) => entry.universalId === ids[rule.key] && entry.status === 'active',
      );
      if (!field && ids[rule.key])
        throw new Error(`The previous field for ${key}.${rule.key} is missing or deleted.`);
      if (!field) {
        fields[rule.key] = { action: 'skip' };
        continue;
      }
      const options = values[rule.key] ?? {};
      fields[rule.key] = { action: 'existing', field: field.name, values: options };
      destinations[rule.key] = { id: field.universalId, values: options };
    }
    choices[key] = { action: 'existing', objects: [object.nameSingular], fields };
    prior.destinations[key] = { objects: [id], fields: destinations };
  };
  const person = state.objects.find((entry) => entry.universalId === old.person);
  const emails = person?.fields.find(
    (field) =>
      field.type === 'emails' &&
      field.status === 'active' &&
      (prior.createPeople === 'never' || field.isUnique),
  );
  const name = person?.fields.find(
    (field) => field.type === 'full_name' && field.status === 'active',
  );
  switch (manifest.universalId) {
    case registrations.tamloot:
      bind('meeting', old.conversation);
      bind('person', old.person, { emails: emails?.universalId, name: name?.universalId });
      bind(
        'task',
        old.task,
        { title: old.taskTitle, status: old.taskStatus, person: old.taskPerson },
        { status: { open: 'todo', done: 'done' } },
      );
      break;
    case registrations.granola:
      bind(
        'meeting',
        old.conversation,
        { url: old.granolaUrl, medium: old.medium, transcript: old.transcript },
        { medium: { meeting: 'meeting' } },
      );
      bind('person', old.person, { emails: emails?.universalId, name: name?.universalId });
      break;
    case registrations.gmail:
      bind('email', old.conversation, { medium: old.medium }, { medium: { email: 'email' } });
      bind('person', old.person, { emails: emails?.universalId });
      break;
    case registrations.lastContact:
      bind('contact', old.conversation);
      bind('person', old.person, { lastContact: old.personContact });
      bind('company', old.company, { lastContact: old.companyContact });
      break;
    case registrations.enrichment:
      bind('company', old.company, {
        domain: old.companyDomain,
        name: old.companyName,
        ...Object.fromEntries(
          Object.entries((row.mapping ?? row.bindings?.legacyMapping)?.outputs ?? {}).map(
            ([key, field]) => [key, field.fieldUniversalId],
          ),
        ),
      });
      break;
    default:
      throw new Error('There is no migration for this release’s previous destinations.');
  }

  // An optional binding added after bindings existed had no destination before.
  for (const declaration of prior.declarations)
    if (!declaration.required && !choices[declaration.key])
      choices[declaration.key] = { action: 'skip' };
  const resolved = resolveBindingPlan(state, manifest, choices, prior, prior.createPeople);
  if (resolved.operations.length)
    throw new Error(
      'The previous destinations need schema changes and must be reviewed by an admin.',
    );
  return resolved.plan;
}

async function applyPlan(
  tx: Tx,
  row: Row,
  release: Release,
  plan: StoredBindingPlan,
  schema: SchemaState,
  settings: Row['settings'],
) {
  const binding = release.manifest.source?.event;
  const destination = binding ? plan.destinations[binding] : null;
  const object = schema.objects.find((object) => object.universalId === destination?.objects[0]);
  if (binding && destination && object) {
    const projection = {
      binding,
      canonicalType: object.universalId,
      fields: Object.fromEntries(
        Object.entries(destination.fields).flatMap(([key, target]) => {
          const field = object.fields.find((entry) => entry.universalId === target.id);
          return field
            ? [
                [
                  key,
                  {
                    field: {
                      type: field.type,
                      settings: field.settings,
                      isNullable: field.isNullable,
                    },
                    values: target.values,
                    canonicalKey: field.key,
                  },
                ],
              ]
            : [];
        }),
      ),
    };
    await tx`update source_receipts receipt
      set projection = ${tx.json(jsonValue(projection))}::jsonb || jsonb_build_object(
        'includeContent', exists (
          select 1 from event_bodies body
          where body.workspace_id = receipt.workspace_id
            and body.event_id = (receipt.response->>'eventId')::uuid
        )
      )
      where receipt.projection is null and receipt.item_id in (
        select s.id from source_items s join source_accounts a on a.id = s.account_id
        where a.workspace_id = ${row.workspace_id} and a.registration_id = ${row.registration_id}
      )`;
  }
  await tx`update extension_installations set bindings=${tx.json(jsonValue(plan))}, bindings_revision=1,
    release_digest=${release.digest}, version=${release.manifest.version},
    settings=${tx.json(jsonValue(settings))}, updated_at=now() where id=${row.id}`;
  await tx`update extension_attempts set status='cancelled',code='installation_changed',finished_at=now()
    where finished_at is null and job_id in (select id from extension_jobs where installation_id=${row.id})`;
  await tx`update extension_jobs set release_digest=${release.digest},status='queued',
    available_at=case when status='running' then now() else available_at end,
    lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=now()
    where installation_id=${row.id} and status in ('queued','running')`;
  await tx`update webhook_bindings set release_digest=${release.digest}
    where installation_id=${row.id} and release_digest=${row.release_digest} and state<>'retired'`;
}

async function uninstall(tx: Tx, row: Row) {
  await tx`update extension_installations set state='uninstalled',bindings=null,generation=generation+1,
    grant_generation=grant_generation+1,updated_at=now(),last_error='binding_unavailable' where id=${row.id}`;
  await tx`update extension_attempts set status='cancelled',code='installation_changed',finished_at=now()
    where finished_at is null and job_id in (select id from extension_jobs where installation_id=${row.id})`;
  await tx`update extension_jobs set status='cancelled',code='installation_changed',
    lease_owner=null,lease_until=null,run_until=null,updated_at=now()
    where installation_id=${row.id} and status in ('queued','running')`;
  await tx`delete from extension_schedules where installation_id=${row.id}`;
  await tx`update webhook_bindings set state='retired',updated_at=now() where installation_id=${row.id}`;
}

const needsBindings = (sql: Sql | Tx) => sql`
  i.state <> 'uninstalled'
  and coalesce((to_jsonb(i)->>'bindings_revision')::int, 0) = 0
  and ((to_jsonb(i)->>'bindings') is null or (to_jsonb(i)->'bindings') ? 'legacyMapping')`;

export async function bindingsMigrationPending(
  sql: Sql,
  catalog: ExtensionCatalog,
): Promise<boolean> {
  const registrations = [
    ...formerBaseUsers,
    ...catalog.list().map(({ manifest }) => manifest.universalId),
  ];
  const [row] = await sql<{ pending: boolean }[]>`
    select exists (
      select 1 from extension_installations i where ${needsBindings(sql)}
        and (i.registration_id = any(${registrations}::uuid[]) or
          (to_jsonb(i)->'bindings') ? 'legacyMapping' or
          coalesce(to_jsonb(i)->'mapping'->'outputs', '{}'::jsonb) <> '{}'::jsonb)
    ) as pending`;
  return row?.pending ?? false;
}

/** The same decisions drive the preflight report and the apply transaction. */
export async function migrateExtensionBindings(
  sql: Sql,
  catalog: ExtensionCatalog,
  reportOnly: boolean,
) {
  const releases = new Map<string, Release>();
  for (const release of catalog.list()) {
    const previous = releases.get(release.manifest.universalId);
    if (!previous || compareVersions(release.manifest.version, previous.manifest.version) > 0)
      releases.set(release.manifest.universalId, release);
  }
  return sql.begin(async (tx) => {
    if (reportOnly) await tx`set transaction isolation level repeatable read, read only`;
    const installations = await tx<Row[]>`
      select i.* from extension_installations i
      where ${needsBindings(tx)}
      order by i.workspace_id,i.id`;
    const report = [];
    for (const row of installations) {
      const release = releases.get(row.registration_id);
      const base = {
        workspaceId: row.workspace_id,
        installationId: row.id,
        registrationId: row.registration_id,
      };
      if (!release) {
        if (
          formerBaseUsers.has(row.registration_id) ||
          row.bindings?.legacyMapping ||
          Object.keys(row.mapping?.outputs ?? {}).length
        )
          throw new Error(
            `Load the rebuilt extension release for installation ${row.id} before migrating its bindings.`,
          );
        report.push({
          ...base,
          action: 'deferred' as const,
          reason: 'The release is not loaded. The installation is unchanged.',
        });
        continue;
      }
      if (!reportOnly) {
        await lockPrivacyShared(tx, row.workspace_id);
        await lockSchemaExclusive(tx, row.workspace_id);
      }
      const { manifest } = release;
      const requested = row.settings.createPeople;
      const createPeople = creationPolicy(manifest, requested, 'migration');
      const changedPolicy = requested !== undefined && requested !== createPeople;
      const policyChange = changedPolicy
        ? { createPeopleChange: { from: requested, to: createPeople } }
        : {};
      const settings = { ...row.settings };
      if (changedPolicy) {
        if (Object.hasOwn(manifest.settings, 'createPeople')) settings.createPeople = createPeople;
        else delete settings.createPeople;
      }
      if (!manifest.bindings?.length) {
        if (!reportOnly) {
          const plan: StoredBindingPlan = {
            extension: manifest.name,
            declarations: [],
            destinations: {},
            createPeople,
          };
          await tx`update extension_installations set bindings=${tx.json(jsonValue(plan))}, bindings_revision=1,
            settings=${tx.json(jsonValue(settings))}, updated_at=now() where id=${row.id}`;
        }
        report.push({
          ...base,
          ...policyChange,
          action: 'no_bindings_needed' as const,
          reason: 'No bindings needed.',
        });
        continue;
      }
      const schema = await loadSchemaState(tx, row.workspace_id);
      let plan: StoredBindingPlan | undefined;
      let reason = 'The previous destinations cannot be bound.';
      try {
        plan = existingPlan(schema, row, manifest, createPeople);
      } catch (error) {
        if (error instanceof Error) reason = error.message;
      }
      if (!reportOnly)
        await tx`delete from extension_contributions where installation_id=${row.id}
          and kind='field' and universal_id=${old.taskId}`;
      if (plan) {
        if (!reportOnly) await applyPlan(tx, row, release, plan, schema, settings);
        report.push({
          ...base,
          ...policyChange,
          action: 'bind' as const,
          plan: presentBindingPlan(schema, plan, 1),
        });
      } else {
        if (!reportOnly) await uninstall(tx, row);
        report.push({ ...base, action: 'uninstall' as const, reason });
      }
    }
    return report;
  });
}
