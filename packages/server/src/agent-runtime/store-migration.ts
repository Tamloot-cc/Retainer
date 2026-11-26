import { MASTRA_ROLE } from '../config.js';
import { createSql } from '../db/client.js';

/**
 * The migration step for the agent's store (agent spec §5.2): after
 * Drizzle's migrations, Mastra's `init()` creates or upgrades its tables in
 * the `mastra` schema as the migration role, then `retainer_mastra` gets DML
 * on them (the migrations already set default privileges; this covers tables
 * an older Mastra made before). At runtime neither the agent nor the API's
 * read store runs DDL. Idempotent. Mastra loads only here and in the
 * agent's own code, so a migration is the one server path that needs it.
 */
export async function migrateAgentStore(ownerUrl: string): Promise<void> {
  const { initMastraSchema } = await import('@retainer/agent');
  await initMastraSchema(ownerUrl);
  const sql = createSql(ownerUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`grant usage on schema mastra to ${MASTRA_ROLE}`);
      await tx.unsafe(
        `grant select, insert, update, delete on all tables in schema mastra to ${MASTRA_ROLE}`,
      );
      await tx.unsafe(`grant usage, select on all sequences in schema mastra to ${MASTRA_ROLE}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
