import type { ExtensionBindingChoices, ExtensionManifest } from '@retainer/extension';
import type { Sql } from '../db/client.js';
import { jsonValue, lockPrivacyShared, lockSchemaExclusive, type Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { presentBindingPlan, type StoredBindingPlan } from '../extension-runtime/bindings.js';
import { resolveBindingPlan } from '../extensions/bindings.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import { loadSchemaState } from '../schema/load.js';
import type { SchemaState } from '../schema/types.js';

// Release identities before binding plans. These IDs are only used to migrate
// existing installations. New installations go through the binding review.
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
  settings: { createPeople?: ExtensionManifest['createPeople'] };
};

type Release = ReturnType<ExtensionCatalog['list']>[number];

function existingPlan(
  state: SchemaState,
  row: Row,
  manifest: ExtensionManifest,
): StoredBindingPlan {
  const choices: ExtensionBindingChoices = {};
  const prior: StoredBindingPlan = {
    extension: manifest.name,
    declarations: manifest.bindings ?? [],
    destinations: {},
    createPeople: row.settings.createPeople ?? manifest.createPeople,
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
  switch (manifest.name) {
    case 'tamloot':
      bind('meeting', old.conversation);
      bind('person', old.person, { emails: emails?.universalId, name: name?.universalId });
      bind(
        'task',
        old.task,
        { title: old.taskTitle, status: old.taskStatus, person: old.taskPerson },
        { status: { open: 'todo', done: 'done' } },
      );
      break;
    case 'granola':
      bind(
        'meeting',
        old.conversation,
        { url: old.granolaUrl, medium: old.medium, transcript: old.transcript },
        { medium: { meeting: 'meeting' } },
      );
      bind('person', old.person, { emails: emails?.universalId, name: name?.universalId });
      break;
    case 'gmail':
      bind('email', old.conversation, { medium: old.medium }, { medium: { email: 'email' } });
      bind('person', old.person, { emails: emails?.universalId });
      break;
    case 'last-contact':
      bind('contact', old.conversation);
      bind('person', old.person, { lastContact: old.personContact });
      bind('company', old.company, { lastContact: old.companyContact });
      break;
    case 'company-enrichment':
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
    release_digest=${release.digest}, version=${release.manifest.version}, updated_at=now() where id=${row.id}`;
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

export async function bindingsMigrationPending(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ pending: boolean }[]>`
    select exists (select 1 from extension_installations i where ${needsBindings(sql)}) as pending`;
  return row?.pending ?? false;
}

/** The same decisions drive the preflight report and the apply transaction. */
export async function migrateExtensionBindings(
  sql: Sql,
  catalog: ExtensionCatalog,
  reportOnly: boolean,
) {
  const releases = catalog.list().filter((release) => release.manifest.bindings?.length);
  return sql.begin(async (tx) => {
    if (reportOnly) await tx`set transaction isolation level repeatable read, read only`;
    const installations = await tx<Row[]>`
      select i.* from extension_installations i
      where ${needsBindings(tx)}
      order by i.workspace_id,i.id`;
    if (installations.length && !releases.length)
      throw new Error('Load the rebuilt extension catalog before planning the binding migration.');
    const report = [];
    for (const row of installations) {
      if (!reportOnly) {
        await lockPrivacyShared(tx, row.workspace_id);
        await lockSchemaExclusive(tx, row.workspace_id);
      }
      const schema = await loadSchemaState(tx, row.workspace_id);
      const release = releases
        .filter((release) => release.manifest.universalId === row.registration_id)
        .sort((a, b) =>
          b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric: true }),
        )[0];
      const base = {
        workspaceId: row.workspace_id,
        installationId: row.id,
        registrationId: row.registration_id,
      };
      let plan: StoredBindingPlan | undefined;
      let reason = 'The rebuilt catalog has no binding contract for this installation.';
      if (release) {
        try {
          plan = existingPlan(schema, row, release.manifest);
        } catch (error) {
          reason =
            error instanceof AppError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'The previous destinations cannot be bound.';
        }
      }
      if (!reportOnly)
        await tx`delete from extension_contributions where installation_id=${row.id}
          and kind='field' and universal_id=${old.taskId}`;
      if (plan && release) {
        if (!reportOnly) await applyPlan(tx, row, release, plan, schema);
        report.push({
          ...base,
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
