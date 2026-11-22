import { type ExtensionManifest, functionSecrets, functionUses } from '@retainer/extension';
import type { JsonSchemaSubset, RoutineToolDescription, ToolContract } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { type RuntimeCatalog, resolveRelease } from '../extension-runtime/availability.js';

/**
 * A tool an installed extension publishes (extensions-tools spec 2), with
 * what calling it needs: its installation, function and release, and whether
 * a standing routine can use it now (spec 5).
 */
export type InstalledTool = RoutineToolDescription & {
  installationId: string;
  registrationId: string;
  functionId: string;
  releaseDigest: string;
  inputSchema: JsonSchemaSubset;
  outputSchema: JsonSchemaSubset;
};

type InstallationRow = {
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  state: string;
  connection_health: string;
  granted_uses: string[];
  /** A live, unrevoked credential of the current grant: a standalone app's service can answer. */
  credential: boolean;
  secret_names: string[];
};

/** Every tool of the workspace's active installations, by name. Two with one name conflict. */
export async function installedTools(tx: Tx, catalog: RuntimeCatalog): Promise<InstalledTool[]> {
  const rows = await tx<InstallationRow[]>`
    select i.id,i.registration_id,i.version,i.release_digest,i.state,i.connection_health,i.granted_uses,
      retainer_extension_credential_live(i.workspace_id,i.id,i.grant_generation) as credential,
      retainer_extension_secret_names(i.id) as secret_names
    from extension_installations i where i.state='active' order by i.created_at,i.id`;
  const tools: InstalledTool[] = [];
  for (const row of rows) {
    const resolution = resolveRelease(catalog, row);
    if (!resolution.available) continue;
    const manifest: ExtensionManifest = resolution.manifest;
    for (const fn of manifest.functions) {
      if (fn.trigger.kind !== 'tool') continue;
      const uses = functionUses(fn);
      // A standalone app's tool calls the app's own service, so it is ready
      // only while the app holds a live credential and has written the
      // generated secrets the tool reads. Revocation does not change
      // connection_health, so this is checked here (spec 8).
      const connected =
        manifest.execution !== 'standalone' ||
        (row.credential &&
          functionSecrets(manifest, fn)
            .filter((name) => manifest.settings[name]?.generated)
            .every((name) => row.secret_names.includes(name)));
      tools.push({
        name: fn.name,
        title: fn.trigger.title,
        description: fn.description,
        effect: fn.trigger.effect,
        connection: fn.trigger.connection,
        model: uses.includes('model') && row.granted_uses.includes('model'),
        extension: manifest.name,
        status:
          fn.trigger.connection === 'member'
            ? 'member_only'
            : !connected || row.connection_health === 'needs_reconnect'
              ? 'not_connected'
              : row.connection_health === 'ok'
                ? 'ready'
                : 'unhealthy',
        inputSchema: fn.inputSchema as JsonSchemaSubset,
        outputSchema: fn.trigger.outputSchema as JsonSchemaSubset,
        installationId: row.id,
        registrationId: row.registration_id,
        functionId: fn.universalId,
        releaseDigest: row.release_digest,
      });
    }
  }
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  for (const tool of tools) if ((counts.get(tool.name) ?? 0) > 1) tool.status = 'conflict';
  return tools;
}

/** Whether an installed tool still matches what a version pinned (routines spec §5.3). */
export const sameContract = (a: ToolContract | undefined, b: ToolContract | undefined) =>
  !!a &&
  !!b &&
  a.registrationId === b.registrationId &&
  a.effect === b.effect &&
  a.connection === b.connection &&
  a.model === b.model;

/** What a version pins about a tool (routines spec §5.3): a change pauses the routine. */
export const toolContract = (tool: InstalledTool): ToolContract => ({
  registrationId: tool.registrationId,
  effect: tool.effect,
  connection: tool.connection,
  model: tool.model,
});
