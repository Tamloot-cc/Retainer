import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import setup from '../global-setup.js';
import { databaseUrl } from '../helpers/db.js';

it('uses an external template without migrating or taking ownership of it', async () => {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `retainer_hook_${randomBytes(8).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  const prior = process.env.RETAINER_TEST_TEMPLATE;
  const provided: Record<string, unknown> = {};
  const project = {
    provide: (key: string, value: unknown) => {
      provided[key] = value;
    },
  } as TestProject;
  await admin.unsafe(`create database "${name}"`);
  try {
    process.env.RETAINER_TEST_TEMPLATE = name;
    expect(await setup(project)).toBeUndefined();
    expect(provided).toEqual({ adminDatabaseUrl: adminUrl, templateDatabase: name });
    const source = postgres(databaseUrl(adminUrl, name), { max: 1 });
    try {
      // Empty on purpose: migrating would create public tables here.
      expect(await source`select tablename from pg_tables where schemaname = 'public'`).toEqual([]);
    } finally {
      await source.end();
    }
    process.env.RETAINER_TEST_TEMPLATE = `${name}_missing`;
    await expect(setup(project)).rejects.toThrow('does not exist');
    process.env.RETAINER_TEST_TEMPLATE = 'bad"name';
    await expect(setup(project)).rejects.toThrow('simple Postgres database name');
  } finally {
    if (prior === undefined) delete process.env.RETAINER_TEST_TEMPLATE;
    else process.env.RETAINER_TEST_TEMPLATE = prior;
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});
