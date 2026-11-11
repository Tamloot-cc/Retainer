import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, type Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

const envelopeSchema = z.strictObject({
  keyVersion: z.string().min(1).max(100),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export type SecretEnvelope = z.infer<typeof envelopeSchema>;
export type SecretIdentity = {
  workspaceId: string;
  installationId: string;
  registrationId: string;
  name: string;
};
const associated = (identity: SecretIdentity) =>
  Buffer.from(
    JSON.stringify([
      identity.workspaceId,
      identity.installationId,
      identity.registrationId,
      identity.name,
    ]),
  );

/** Encryption keys are injected from outside Postgres, with old versions retained for rotation. */
export class SecretCipher {
  private readonly keys: Map<string, Buffer>;
  constructor(
    readonly currentVersion: string,
    keys: ReadonlyMap<string, Uint8Array>,
  ) {
    this.keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
    if (
      !this.keys.has(currentVersion) ||
      [...this.keys.values()].some((key) => key.byteLength !== 32)
    )
      throw new Error('extension encryption keys must contain exactly 32 bytes');
  }
  encrypt(value: string, identity: SecretIdentity): SecretEnvelope {
    if (!value || Buffer.byteLength(value) > 65536)
      throw new AppError(422, 'invalid_secret', 'secret must contain 1–65536 bytes');
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error('current encryption key is unavailable');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associated(identity));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      keyVersion: this.currentVersion,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  decrypt(value: unknown, identity: SecretIdentity): string {
    try {
      const envelope = envelopeSchema.parse(value),
        key = this.keys.get(envelope.keyVersion);
      if (!key) throw new Error('key unavailable');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(associated(identity));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new AppError(
        503,
        'connection_required',
        'stored secret cannot be decrypted with the configured keys',
      );
    }
  }
}

export type PendingSecret = {
  id: string;
  draft_installation_id: string;
  registration_id: string;
  name: string;
};
/** A separate pool/role can read ciphertext. The ordinary API pool has no SELECT privilege. */
export class SecretBroker {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: SecretCipher,
  ) {}
  async stage(
    caller: Caller,
    input: { registrationId: string; installationId?: string; name: string; value: string },
  ) {
    if (!canApproveDestructive(caller.actor, caller.scopes))
      throw new AppError(403, 'forbidden', 'only a human admin can provide connection secrets');
    const installationId = input.installationId ?? randomUUID();
    const envelope = this.cipher.encrypt(input.value, {
      workspaceId: caller.workspaceId,
      installationId,
      registrationId: input.registrationId,
      name: input.name,
    });
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const [row] = await tx<
        { id: string; expiresAt: Date }[]
      >`insert into extension_pending_secrets
        (workspace_id,draft_installation_id,registration_id,name,envelope,created_by)
        values(${caller.workspaceId},${installationId},${input.registrationId},${input.name},${tx.json(envelope)},${tx.json(caller.actor)})
        returning id,expires_at as "expiresAt"`;
      if (!row) throw new Error('pending secret insert returned no row');
      return { pendingSecretId: row.id, installationId, expiresAt: row.expiresAt.toISOString() };
    });
  }
  /** Caller must hold run admission in its API transaction until this read completes. */
  async read(identity: SecretIdentity) {
    return inWorkspace(this.sql, identity.workspaceId, async (tx) => {
      const [row] = await tx<
        { envelope: unknown; revision: number }[]
      >`select envelope,revision from extension_secrets
        where installation_id=${identity.installationId} and name=${identity.name} and (delete_after is null or delete_after>clock_timestamp())`;
      if (!row)
        throw new AppError(
          409,
          'connection_required',
          'requested connection secret is unavailable',
        );
      return { value: this.cipher.decrypt(row.envelope, identity), revision: row.revision };
    });
  }
  async rotate(identity: SecretIdentity, expectedRevision: number) {
    return inWorkspace(this.sql, identity.workspaceId, async (tx) => {
      const [row] = await tx<
        { envelope: unknown; revision: number }[]
      >`select envelope,revision from extension_secrets
        where installation_id=${identity.installationId} and name=${identity.name} and delete_after is null for update`;
      if (!row || row.revision !== expectedRevision)
        throw new AppError(409, 'revision_conflict', 'secret revision changed');
      const value = this.cipher.decrypt(row.envelope, identity),
        envelope = this.cipher.encrypt(value, identity);
      const [updated] = await tx<
        { revision: number }[]
      >`update extension_secrets set envelope=${tx.json(envelope)},revision=revision+1
        where installation_id=${identity.installationId} and name=${identity.name} returning revision`;
      return updated;
    });
  }
  async collectExpired(workspace: string) {
    return inWorkspace(this.sql, workspace, async (tx) => {
      await tx`delete from extension_pending_secrets where expires_at<=clock_timestamp() or consumed_at<clock_timestamp()-interval '1 hour'`;
      await tx`delete from extension_secrets where delete_after<=clock_timestamp()`;
    });
  }
}

/** No ciphertext crosses this function; the API sees only bounded pending-reference metadata. */
export async function pendingSecrets(tx: Tx, refs: string[]): Promise<PendingSecret[]> {
  if (!refs.length) return [];
  return tx<PendingSecret[]>`select * from retainer_extension_pending_secrets(${refs}::uuid[])`;
}
