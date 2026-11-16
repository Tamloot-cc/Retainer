import type { ExtensionManifest } from '@retainer/extension';
import { z } from 'zod';
import type { ExtensionCatalog } from './catalog.js';

/** `https`, or `http` only for local work and tests (Tamloot connect spec 4.1). */
const address = z.url().refine((value) => {
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
}, 'use https, or http only for localhost');

const clientSchema = z.strictObject({
  clientId: z.string().min(1).max(2048),
  clientSecret: z.string().min(1).max(4096),
  authorizationEndpoint: address,
  tokenEndpoint: address,
  apiOrigin: address.optional(),
  scope: z.string().min(1).max(1000).optional(),
  keyFallback: z.boolean().default(true),
});
export type ExtensionOAuthClientConfig = z.infer<typeof clientSchema> & {
  /** `<RETAINER_PUBLIC_ORIGIN>/app/connect/callback`; fixed per deployment. */
  redirectUri: string;
};
/** Operator OAuth clients by registration universal ID. Workspaces can neither set nor read them. */
export type ExtensionOAuthClients = ReadonlyMap<string, ExtensionOAuthClientConfig>;

export const CONNECT_CALLBACK_PATH = '/app/connect/callback';

/**
 * Parses `RETAINER_EXTENSION_OAUTH_CLIENTS`. Throws on a malformed value or on
 * a registration none of whose releases declares `oauth`; the caller replaces
 * the error with its redacted configuration error.
 */
export function parseOAuthClients(
  raw: string | undefined,
  catalog: ExtensionCatalog,
  publicOrigin: string | undefined,
): ExtensionOAuthClients {
  if (!raw) return new Map();
  const parsed = z.record(z.uuid(), clientSchema).parse(JSON.parse(raw));
  const clients = new Map<string, ExtensionOAuthClientConfig>();
  for (const [registration, client] of Object.entries(parsed)) {
    if (
      !catalog
        .list()
        .some((release) => release.manifest.universalId === registration && release.manifest.oauth)
    )
      throw new Error('an OAuth client names a registration without an OAuth release');
    // Without a public origin there is no redirect address, so OAuth is unavailable.
    if (!publicOrigin) continue;
    clients.set(registration, {
      ...client,
      redirectUri: new URL(CONNECT_CALLBACK_PATH, publicOrigin).toString(),
    });
  }
  return clients;
}

/** The methods a member may use to connect to this release on this server (spec 4.8). */
export function connectionMethods(
  manifest: Pick<ExtensionManifest, 'connection' | 'oauth' | 'universalId'>,
  clients: ExtensionOAuthClients,
  brokerConfigured: boolean,
): ('oauth' | 'key')[] | undefined {
  if (manifest.connection !== 'member') return undefined;
  const client = oauthClientFor(manifest, clients, brokerConfigured);
  // An OAuth release's key method needs a `keySetting` and the broker to stage it.
  const key = !manifest.oauth || (!!manifest.oauth.keySetting && brokerConfigured);
  if (!client) return key ? ['key'] : [];
  return client.keyFallback && key ? ['oauth', 'key'] : ['oauth'];
}

/** The client when OAuth is available for this release (spec 4.1), else undefined. */
export function oauthClientFor(
  manifest: Pick<ExtensionManifest, 'connection' | 'oauth' | 'universalId'>,
  clients: ExtensionOAuthClients,
  brokerConfigured: boolean,
): ExtensionOAuthClientConfig | undefined {
  if (manifest.connection !== 'member' || !manifest.oauth || !brokerConfigured) return undefined;
  return clients.get(manifest.universalId);
}
