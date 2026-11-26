import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { migrateAgentStore } from '../src/agent-runtime/store-migration.js';
import { runMigrations } from '../src/db/migrate.js';
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for browser tests');
  const name = `retainer_browser_template_${randomBytes(4).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${name}"`);
  const templateUrl = new URL(url);
  templateUrl.pathname = `/${name}`;
  try {
    await runMigrations(templateUrl.toString());
    // The agent's own store (agent spec §5.2), as `pnpm db:migrate` creates it.
    await migrateAgentStore(templateUrl.toString());
  } catch (e) {
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end();
    throw e;
  }
  process.env.RETAINER_BROWSER_TEMPLATE = name;
  return async () => {
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end();
  };
}
