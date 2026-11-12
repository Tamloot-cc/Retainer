import { createHash, randomBytes } from 'node:crypto';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';

export const isInstallationKey = (value: string) => value.startsWith('rti_');
export const mintInstallationKey = () => `rti_${randomBytes(32).toString('base64url')}`;
export const hashInstallationKey = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function lookupInstallationKey(sql: Sql, value: string): Promise<Caller> {
  if (!/^rti_[A-Za-z0-9_-]{43}$/.test(value))
    throw new AppError(401, 'unauthorized', 'installation key is unknown or revoked');
  const [key] = await sql<
    {
      credential_id: string;
      workspace_id: string;
      installation_id: string;
      registration_id: string;
      generation: number;
      actor_type: 'agent' | 'integration';
      scopes: ('read' | 'write')[];
    }[]
  >`select * from retainer_lookup_extension_key(${hashInstallationKey(value)})`;
  if (!key) throw new AppError(401, 'unauthorized', 'installation key is unknown or revoked');
  return {
    workspaceId: key.workspace_id,
    actor: { type: key.actor_type, id: key.installation_id },
    scopes: key.scopes,
    installation: {
      installationId: key.installation_id,
      registrationId: key.registration_id,
      grantGeneration: key.generation,
      credentialId: key.credential_id,
      kind: 'key',
      scopes: key.scopes,
    },
  };
}
