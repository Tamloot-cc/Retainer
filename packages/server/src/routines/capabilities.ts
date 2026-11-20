import { createHash } from 'node:crypto';
import {
  aggregateOps,
  filterOperatorsFor,
  generateRoutineTypes,
  isReservedRoutineName,
  ROUTINE_GAP_CODES,
  ROUTINE_LIMITS,
  type RoutineCapabilities,
  type RoutineObjectDescription,
  SORTABLE_TYPES,
} from '@retainer/shared';
import type { WorkspaceSettings } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import { type InstalledTool, installedTools } from '../extensions/tools.js';
import type { CompiledSchema } from '../schema/compiled.js';

/** What the routines module needs from the server's configuration. */
export type RoutineConfig = {
  /** The extension catalog, for tools; none means no tools. */
  catalog?: RuntimeCatalog | undefined;
  /** Whether the server has a model key (§4.5). */
  modelAvailable: boolean;
};

/** The workspace's objects as routine code sees them: fields by key (§4.4). */
export function describeObjects(schema: CompiledSchema): RoutineObjectDescription[] {
  const objects: RoutineObjectDescription[] = [];
  for (const object of schema.objectsByName.values()) {
    if (isReservedRoutineName(object.name)) continue;
    objects.push({
      name: object.name,
      universalId: object.state.universalId,
      label: object.state.labelSingular,
      description: object.state.description,
      isEvent: object.isEvent,
      fields: object.activeFields.map((field) => {
        const target = field.settings.targetObjectId
          ? schema.objectsByUniversalId.get(field.settings.targetObjectId)?.name
          : undefined;
        return {
          key: field.key,
          name: field.name,
          label: field.label,
          type: field.type,
          description: field.description,
          filterable: field.isFilterable,
          // What the API takes, from the same rules its validators use.
          operators: field.isFilterable ? [...filterOperatorsFor(field)] : [],
          sortable: field.isFilterable && SORTABLE_TYPES.includes(field.type),
          aggregates: aggregateOps(field),
          nullable: field.isNullable,
          ...(field.settings.options
            ? { options: field.settings.options.map((o) => o.value) }
            : {}),
          ...(field.type === 'relation'
            ? {
                ...(target ? { target } : {}),
                many: field.settings.relationCardinality !== 'many_to_one',
              }
            : {}),
          ...(field.settings.isInverse ? { readOnly: true } : {}),
        };
      }),
    });
  }
  return objects.sort((a, b) => a.name.localeCompare(b.name));
}

export const fingerprint = (types: string) => createHash('sha256').update(types).digest('hex');

export type Capabilities = RoutineCapabilities & { installed: InstalledTool[] };

/** Everything that exists, as facts and as the SDK's types (§5.2, item 1). */
export async function capabilities(
  tx: Tx,
  schema: CompiledSchema,
  config: RoutineConfig,
): Promise<Capabilities> {
  const [workspace] = await tx<{ settings: WorkspaceSettings }[]>`
    select settings from workspaces where id=nullif(current_setting('app.workspace_id',true),'')::uuid`;
  const installed = config.catalog ? await installedTools(tx, config.catalog) : [];
  const objects = describeObjects(schema);
  const tools = installed.map(
    ({ installationId, registrationId, functionId, releaseDigest, ...tool }) => tool,
  );
  const types = generateRoutineTypes({ objects, tools, model: config.modelAvailable });
  return {
    objects,
    tools,
    installed,
    model: { available: config.modelAvailable },
    timezone: workspace?.settings.timeZone ?? 'UTC',
    triggers: ['record', 'schedule', 'manual'],
    limits: ROUTINE_LIMITS,
    gapCodes: ROUTINE_GAP_CODES,
    types,
    typesFingerprint: fingerprint(types),
  };
}
