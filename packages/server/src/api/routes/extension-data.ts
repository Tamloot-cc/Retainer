import type { Hono } from 'hono';
import type { Sql } from '../../db/client.js';
import type { ExtensionCatalog } from '../../extensions/catalog.js';
import type { AppEnv } from '../../http/response.js';
import { Sources } from '../../sources/service.js';
import { gmailRuntimeRoutes } from './gmail.js';
import { lastContactRoutes } from './last-contact.js';
import { sourceRoutes } from './sources.js';

/**
 * Routes under `/v1/extensions/:id/` that extension functions call with their
 * run credential. The hosted gateway sends all of `/v1/extensions` to the
 * extension-control app, so it mounts them as well as the main API.
 */
export function extensionDataRoutes(v1: Hono<AppEnv>, sql: Sql, catalog: ExtensionCatalog) {
  lastContactRoutes(v1, sql, catalog);
  gmailRuntimeRoutes(v1, sql, catalog);
  sourceRoutes(
    v1,
    // The installation's release, which admission matched to the run's.
    new Sources(
      sql,
      (registrationId, _version, releaseDigest) =>
        catalog.forRun({ registrationId, releaseDigest }).manifest,
    ),
  );
}
