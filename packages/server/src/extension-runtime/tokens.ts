import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Caller, RunBinding } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { AppError } from '../errors.js';
import { admitRun } from './admission.js';
import type { ClaimedJob } from './queue.js';

const binding = z.strictObject({
  installationId: z.uuid(),
  registrationId: z.uuid(),
  generation: z.number().int().positive(),
  jobId: z.uuid(),
  owner: z.string().min(1).max(200),
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .max(2),
});
const audience = 'retainer:extension-run';
const prefix = 'rt_run_';
export const isRunToken = (token: string) => token.startsWith(prefix);

/** The coordinator holds a private key; API processes need only the verification key. */
export class RunTokens {
  constructor(
    private readonly options: {
      issuer: string;
      keyId: string;
      verificationKey: CryptoKey;
      signingKey?: CryptoKey;
    },
  ) {}
  async issue(sql: Sql, job: ClaimedJob, registrationId: string, scopes: ('read' | 'write')[]) {
    if (job.system) throw new Error('system lifecycle jobs have no run credentials');
    const key = this.options.signingKey;
    if (!key) throw new Error('run signing key is unavailable');
    const run: RunBinding = {
      installationId: job.installationId,
      registrationId,
      generation: job.generation,
      jobId: job.jobId,
      owner: job.owner,
      fence: job.fence,
      releaseDigest: job.releaseDigest,
      scopes,
    };
    await inWorkspace(sql, job.workspaceId, async (tx) => {
      await lockSchemaShared(tx, job.workspaceId);
      await admitRun(tx, job.workspaceId, run, false, 'authenticate');
    });
    const expiry = Math.min(
      Math.floor(Date.now() / 1000) + 300,
      Math.floor(job.deadline.getTime() / 1000),
    );
    if (expiry <= Math.floor(Date.now() / 1000))
      throw new AppError(409, 'lease_expired', 'run deadline passed');
    const token = await new SignJWT({ run: binding.parse(run), workspace: job.workspaceId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'retainer-run+jwt', kid: this.options.keyId })
      .setIssuer(this.options.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setJti(randomUUID())
      .sign(key);
    return prefix + token;
  }
  async authenticate(sql: Sql, token: string): Promise<Caller> {
    try {
      if (!isRunToken(token)) throw new Error('wrong credential type');
      const { payload, protectedHeader } = await jwtVerify(
        token.slice(prefix.length),
        this.options.verificationKey,
        {
          algorithms: ['EdDSA'],
          issuer: this.options.issuer,
          audience,
          maxTokenAge: '5m',
          requiredClaims: ['iat', 'exp', 'jti'],
        },
      );
      if (
        protectedHeader.typ !== 'retainer-run+jwt' ||
        protectedHeader.kid !== this.options.keyId ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp - payload.iat > 300
      )
        throw new Error('invalid run header or lifetime');
      const workspaceId = z.uuid().parse(payload.workspace),
        run = binding.parse(payload.run);
      return await inWorkspace(sql, workspaceId, async (tx) => {
        await lockSchemaShared(tx, workspaceId);
        const authority = await admitRun(tx, workspaceId, run, false, 'authenticate');
        return { workspaceId, ...authority, run };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'unauthorized', 'run credential is invalid or expired');
    }
  }
}
