import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { forbidden, notFound } from '../errors.js';
import { enrolledPasskeys, verifyStepUp } from './cli-approvals.js';

export const assertionSchema = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({
    authenticatorData: z.string(),
    clientDataJSON: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
});

export const proofSchema = z.object({ id: z.uuid(), assertion: assertionSchema });
type Proof = z.infer<typeof proofSchema>;

export const passkeyChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('insert'),
    credentialId: z.string().min(1).max(4096),
    attestationHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ kind: z.literal('delete'), id: z.uuid() }),
]);
type Change = z.infer<typeof passkeyChange>;
type Session = { userId: string; sessionId: string };
type Stored = { change: Change; session: Session; challenge: string };
const identifier = (id: string) => `retainer-passkey-change:${id}`;

export async function passkeyChangeOptions(
  sql: Sql,
  session: Session,
  change: Change,
  origin: string,
) {
  const keys = await enrolledPasskeys(sql, session.userId);
  if (!keys.length) throw forbidden('There is no existing passkey to verify this change.');
  if (change.kind === 'delete' && !keys.some((key) => key.id === change.id))
    throw notFound('passkey');
  const id = randomUUID();
  const value: Stored = { change, session, challenge: randomBytes(32).toString('base64url') };
  await sql`insert into auth_verifications (identifier, value, expires_at)
    values (${identifier(id)}, ${JSON.stringify(value)}, clock_timestamp() + interval '3 minutes')`;
  return {
    id,
    options: {
      challenge: value.challenge,
      rpId: new URL(origin).hostname,
      userVerification: 'required',
      allowCredentials: keys.map((key) => ({ id: key.credential_id, type: 'public-key' })),
    },
  };
}

async function authorize(tx: Tx, session: Session, proof: Proof, change: Change, origin: string) {
  await tx`select id from users where id=${session.userId} and disabled_at is null for update`;
  const [stored] = await tx<{ value: string }[]>`delete from auth_verifications
    where identifier=${identifier(proof.id)} and expires_at > clock_timestamp() returning value`;
  if (!stored) throw forbidden('This passkey request has expired. Start the change again.');
  const approved = JSON.parse(stored.value) as Stored;
  if (
    approved.session.userId !== session.userId ||
    approved.session.sessionId !== session.sessionId ||
    JSON.stringify(approved.change) !== JSON.stringify(change)
  )
    throw forbidden('The passkey proof is for a different change.');
  const keys = await enrolledPasskeys(tx, session.userId);
  await verifyStepUp(tx, session.userId, origin, approved.challenge, proof.assertion, keys);
  return keys;
}

async function permit(tx: Tx, userId: string, kind: Change['kind'], credential: string) {
  await tx`insert into passkey_change_authorizations (user_id, kind, credential_id, expires_at)
    values (${userId}, ${kind}, ${credential}, clock_timestamp() + interval '30 seconds')
    on conflict (user_id, kind, credential_id) do update set expires_at=excluded.expires_at`;
}

export async function authorizePasskeyRegistration(
  sql: Sql,
  session: Session,
  proof: Proof,
  origin: string,
  credential: { id: string; publicKey: Uint8Array },
  attestation: string,
) {
  const attestationHash = createHash('sha256').update(attestation).digest('hex');
  const publicKeyHash = createHash('sha256').update(credential.publicKey).digest('hex');
  await sql.begin(async (tx) => {
    await authorize(
      tx,
      session,
      proof,
      { kind: 'insert', credentialId: credential.id, attestationHash },
      origin,
    );
    await permit(tx, session.userId, 'insert', `${credential.id}:${publicKeyHash}`);
  });
}

export async function removePasskey(
  sql: Sql,
  session: Session,
  id: string,
  proof: Proof,
  origin: string,
) {
  await sql.begin(async (tx) => {
    const keys = await authorize(tx, session, proof, { kind: 'delete', id }, origin);
    const key = keys.find((candidate) => candidate.id === id);
    if (!key) throw notFound('passkey');
    await permit(tx, session.userId, 'delete', key.credential_id);
    await tx`delete from passkeys where id=${id} and user_id=${session.userId}`;
  });
}
