import { fileURLToPath } from 'node:url';
import { migrateAgentStore } from './agent-runtime/store-migration.js';
import { loadConfig, ownerDatabaseUrl } from './config.js';
import { createSql } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { parseExtensionCatalog } from './extensions/catalog.js';
import { migrateExtensionBindings } from './workspaces/binding-migration.js';
import { upgradeWorkspaces } from './workspaces/upgrade.js';

async function main(reportOnly: boolean) {
  const config = loadConfig();
  const url = ownerDatabaseUrl(config);
  const catalog = parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG);
  if (!reportOnly) {
    await runMigrations(url);
    // Mastra's tables for the workspace agent, after Drizzle's (agent spec §5.2).
    await migrateAgentStore(url);
  }
  const sql = createSql(url, { max: 1 });
  try {
    const report = await migrateExtensionBindings(sql, catalog, reportOnly);
    if (reportOnly) console.log(JSON.stringify(report, null, 2));
    else {
      const workspaces = await upgradeWorkspaces(sql);
      if (workspaces.failed.length) throw new Error('Workspace upgrades failed.');
      console.log('Migrations applied.');
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.includes('--report-bindings'));
}
