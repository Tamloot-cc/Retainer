#!/usr/bin/env node
import { loadConfig, ownerDatabaseUrl } from './config.js';
import { createSql } from './db/client.js';
import { runCli } from './operator/commands.js';

/** `retainer-ops`: the operator CLI (7.1). Talks to DATABASE_URL directly. */
const config = loadConfig();
const sql = createSql(ownerDatabaseUrl(config), { max: 2 });
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    sql,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} finally {
  await sql.end({ timeout: 5 });
}
