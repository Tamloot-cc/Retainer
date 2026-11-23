import type { Context } from 'hono';
import { INSTALLATION_CLAIM, WORKSPACE_CLAIM, WORKSPACE_ROLE_CLAIM } from '../auth/oauth-token.js';
import { accountsConfig, accountsOrigin, type Config } from '../config.js';
import type { Sql } from '../db/client.js';
import { parseExtensionCatalog } from '../extensions/catalog.js';
import { type AuthOptions, createAuth, type GoogleOverrides } from './auth.js';
import { ensureCliClient } from './cli-logins.js';
import { appSignInTarget } from './extensions.js';
import { createAccountsApp } from './routes.js';

export { CLIENT_IP_HEADER } from './auth.js';

/**
 * /account for one process: the container's (index.ts) or the control
 * function's (lambda/control.ts). Throws at startup when accounts mode is
 * only half configured (4.1).
 */
export function createAccountsServer(input: {
  config: Config;
  hostedOnboarding?: boolean;
  /** A connection as the control role. */
  sql: Sql;
  /**
   * Another, for Better Auth alone. Its adapter runs on drizzle-orm, whose
   * postgres-js driver replaces the pool's date and JSON parsers; every raw
   * query sharing that pool would read strings instead of dates.
   */
  authSql: Sql;
  clientIp: (c: Context) => string | undefined;
  google?: GoogleOverrides;
  /** Tests run a local fake of Microsoft's sign-in service. */
  microsoftAuthority?: string;
  rateLimit?: boolean;
  fetchClientMetadata?: AuthOptions['fetchClientMetadata'];
}) {
  const { config } = input;
  const publicOrigin = accountsOrigin(config);
  const extensionCatalog = parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG);
  const auth = createAuth({
    // An app sign-in's ID token names the workspace, role and installation,
    // rechecked when it is issued (extensions spec 8).
    appSignInClaims: async (claims) => {
      const target = await appSignInTarget(input.sql, extensionCatalog, claims);
      return target
        ? {
            [WORKSPACE_CLAIM]: target.workspaceId,
            [WORKSPACE_ROLE_CLAIM]: target.role,
            [INSTALLATION_CLAIM]: target.installationId,
          }
        : null;
    },
    sql: input.authSql,
    controlSql: input.sql,
    config: accountsConfig(config),
    publicOrigin,
    ...(input.google ? { google: input.google } : {}),
    ...(input.microsoftAuthority ? { microsoftAuthority: input.microsoftAuthority } : {}),
    ...(input.rateLimit === undefined ? {} : { rateLimit: input.rateLimit }),
    ...(input.fetchClientMetadata ? { fetchClientMetadata: input.fetchClientMetadata } : {}),
  });
  const app = createAccountsApp({
    auth,
    ...(input.hostedOnboarding ? { hostedOnboarding: true } : {}),
    sql: input.sql,
    publicOrigin,
    clientIp: input.clientIp,
    extensionCatalog,
  });
  return Object.assign(app, { initializeCli: () => ensureCliClient(input.sql, publicOrigin) });
}
