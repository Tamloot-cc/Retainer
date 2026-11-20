import type { Hono } from 'hono';
import type { Sql } from '../../db/client.js';
import { AppError } from '../../errors.js';
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
    new Sources(sql, (registration, version, digest) => {
      const release = catalog.get(registration, version);
      if (release.digest !== digest)
        throw new AppError(409, 'incompatible_runtime', 'source release changed');
      return release.manifest;
    }),
  );
}
