import { randomUUID } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Caller, RunBinding } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { AppError } from '../errors.js';
import { admitRun } from './admission.js';
import type { ClaimedJob } from './queue.js';

const binding = z.strictObject({
  connectionId: z.uuid().nullable().optional(),
  connectionGeneration: z.number().int().positive().nullable().optional(),
  registrationName: z.string().min(1).max(200).optional(),
  installationId: z.uuid(),
  registrationId: z.uuid(),
  generation: z.number().int().positive(),
  jobId: z.uuid(),
  owner: z.string().min(1).max(200),
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  functionId: z.uuid(),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .max(2),
});
const audience = 'retainer:extension-run';
const prefix = 'rt_run_';
export const isRunToken = (token: string) => token.startsWith(prefix);

/**
 * A model token opens model calls and nothing else (model calls spec 3.2). It
 * has its own audience, so the API refuses it and the proxy refuses a run token.
 */
const modelAudience = 'retainer:extension-model';
const routineModelAudience = 'retainer:routine-model';
const modelTokenType = 'retainer-model+jwt';
const routineModelTokenType = 'retainer-routine-model+jwt';
/** Where the self-hosted server serves the model proxy, under the API origin (spec 3.6). */
export const MODEL_PROXY_PATH = '/v1/extensions/runtime/model';
const modelPrefix = 'rt_model_';
export const isModelToken = (token: string) => token.startsWith(modelPrefix);
const extensionModelClaims = z.strictObject({
  kind: z.literal('model'),
  workspaceId: z.uuid(),
  installationId: z.uuid(),
  registrationId: z.uuid(),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  functionId: z.uuid(),
  jobId: z.uuid(),
  attempt: z.number().int().positive(),
});
/**
 * A routine's model token (routines spec §4.5, §6.3): one per call, issued by
 * the API once it has reserved the call against the caps. The proxy accepts
 * only a plain call with it: this model, a bounded output, no tools.
 */
const routineModelClaims = z.strictObject({
  kind: z.literal('routine'),
  workspaceId: z.uuid(),
  routineId: z.uuid().nullable(),
  runId: z.uuid(),
  position: z.number().int().positive(),
  attempt: z.number().int().positive(),
  model: z.string().min(1).max(200),
  maxTokens: z.number().int().positive().max(4096),
});
const modelClaims = z.discriminatedUnion('kind', [extensionModelClaims, routineModelClaims]);
/** Who a model call is for, taken from its token and never from the request. */
export type ModelClaims = z.infer<typeof modelClaims>;
export type ExtensionModelClaims = z.infer<typeof extensionModelClaims>;
export type RoutineModelClaims = z.infer<typeof routineModelClaims>;

/**
 * A routine run's credential (routines spec §3.3): bound to one run and its
 * fence, agent rank, limited to the tools its manifest lists. A dry run's
 * binding has no write scope. It carries no model access.
 */
const routineBinding = z.strictObject({
  runId: z.uuid(),
  routineId: z.uuid().nullable(),
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
  mode: z.enum(['run', 'test', 'dry', 'check', 'build']),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(20),
});
export type RoutineBinding = z.infer<typeof routineBinding>;
const routineAudience = 'retainer:routine-run';
const routinePrefix = 'rt_routine_';
export const isRoutineToken = (token: string) => token.startsWith(routinePrefix);
/** A verified model token: its claims, and when it expires (seconds since the epoch). */
export type VerifiedModelToken = ModelClaims & { expiresAt: number };

/** The run verification key's JWK shape; the private key extends it with `d`. */
export const runPublicJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  alg: z.literal('EdDSA').optional(),
  use: z.literal('sig').optional(),
  kid: z.string().optional(),
});
/** The run verification key from `RETAINER_EXTENSION_RUN_PUBLIC_KEY`. */
export async function importRunPublicKey(json: string): Promise<CryptoKey> {
  const key = await importJWK(runPublicJwkSchema.parse(JSON.parse(json)), 'EdDSA');
  if (key instanceof Uint8Array) throw new Error('asymmetric run keys required');
  return key;
}

/** The hosted API can sign routine model tokens with a separate key. */
export class RunTokens {
  constructor(
    private readonly options: {
      issuer: string;
      keyId: string;
      verificationKey: CryptoKey;
      signingKey?: CryptoKey;
      routineModelSigningKey?: CryptoKey;
      routineModelVerificationKey?: CryptoKey;
    },
  ) {}
  async issue(sql: Sql, job: ClaimedJob, registrationId: string, scopes: ('read' | 'write')[]) {
    if (job.system) throw new Error('system lifecycle jobs have no run credentials');
    const key = this.options.signingKey;
    if (!key) throw new Error('run signing key is unavailable');
    // The claim already narrowed job.scopes to the function's needs within the grant.
    if (!scopes.length || scopes.some((scope) => !job.scopes.includes(scope)))
      throw new AppError(403, 'forbidden', "run scopes exceed the function's effective scopes");
    const run: RunBinding = {
      installationId: job.installationId,
      ...(job.connectionId
        ? { connectionId: job.connectionId, connectionGeneration: job.connectionGeneration }
        : {}),
      ...(job.registrationName ? { registrationName: job.registrationName } : {}),
      registrationId,
      generation: job.generation,
      jobId: job.jobId,
      owner: job.owner,
      fence: job.fence,
      releaseDigest: job.releaseDigest,
      functionId: job.functionId,
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
  /**
   * Mints the model token for a run whose function declares `model` and whose
   * grant includes it (claim computed `job.uses`). Same key and lifetime as
   * the run token; no database check, since it opens nothing in Retainer.
   */
  async issueModel(job: ClaimedJob) {
    if (job.system) throw new Error('system lifecycle jobs have no run credentials');
    const key = this.options.signingKey;
    if (!key) throw new Error('run signing key is unavailable');
    if (!job.uses.includes('model'))
      throw new AppError(403, 'forbidden', 'the run has no model access');
    const expiry = Math.min(
      Math.floor(Date.now() / 1000) + 300,
      Math.floor(job.deadline.getTime() / 1000),
    );
    if (expiry <= Math.floor(Date.now() / 1000))
      throw new AppError(409, 'lease_expired', 'run deadline passed');
    const claims: ExtensionModelClaims = {
      kind: 'model',
      workspaceId: job.workspaceId,
      installationId: job.installationId,
      registrationId: job.registrationId,
      releaseDigest: job.releaseDigest,
      functionId: job.functionId,
      jobId: job.jobId,
      attempt: job.attempt,
    };
    const token = await new SignJWT({ model: extensionModelClaims.parse(claims) })
      .setProtectedHeader({ alg: 'EdDSA', typ: modelTokenType, kid: this.options.keyId })
      .setIssuer(this.options.issuer)
      .setAudience(modelAudience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setJti(randomUUID())
      .sign(key);
    return modelPrefix + token;
  }
  /**
   * A routine model call's token, after the API reserved the call. It lasts
   * one request: at most five minutes, and never past the run's expiry.
   */
  async issueRoutineModel(claims: RoutineModelClaims, until: Date) {
    const routineKey = this.options.routineModelSigningKey;
    const key = routineKey ?? this.options.signingKey;
    if (!key) throw new Error('routine model signing key is unavailable');
    const expiry = Math.min(
      Math.floor(Date.now() / 1000) + 300,
      Math.floor(until.getTime() / 1000),
    );
    if (expiry <= Math.floor(Date.now() / 1000))
      throw new AppError(409, 'run_expired', 'the run has expired');
    const token = await new SignJWT({ model: routineModelClaims.parse(claims) })
      .setProtectedHeader({
        alg: 'EdDSA',
        typ: routineKey ? routineModelTokenType : modelTokenType,
        kid: this.options.keyId,
      })
      .setIssuer(this.options.issuer)
      .setAudience(routineKey ? routineModelAudience : modelAudience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setJti(randomUUID())
      .sign(key);
    return modelPrefix + token;
  }
  /** A routine run's token, valid until `until` and at most five minutes. */
  async issueRoutine(workspaceId: string, binding: RoutineBinding, until: Date) {
    const key = this.options.signingKey;
    if (!key) throw new Error('run signing key is unavailable');
    const expiry = Math.min(
      Math.floor(Date.now() / 1000) + 300,
      Math.floor(until.getTime() / 1000),
    );
    if (expiry <= Math.floor(Date.now() / 1000))
      throw new AppError(409, 'lease_expired', 'run deadline passed');
    const token = await new SignJWT({
      routine: routineBinding.parse(binding),
      workspace: workspaceId,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'retainer-routine+jwt', kid: this.options.keyId })
      .setIssuer(this.options.issuer)
      .setAudience(routineAudience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setJti(randomUUID())
      .sign(key);
    return routinePrefix + token;
  }
  /** Verifies a routine token's signature and lifetime; admission checks the run itself. */
  async verifyRoutine(token: string): Promise<{ workspaceId: string; binding: RoutineBinding }> {
    try {
      if (!isRoutineToken(token)) throw new Error('wrong credential type');
      const { payload, protectedHeader } = await jwtVerify(
        token.slice(routinePrefix.length),
        this.options.verificationKey,
        {
          algorithms: ['EdDSA'],
          issuer: this.options.issuer,
          audience: routineAudience,
          maxTokenAge: '5m',
          requiredClaims: ['iat', 'exp', 'jti'],
        },
      );
      if (
        protectedHeader.typ !== 'retainer-routine+jwt' ||
        protectedHeader.kid !== this.options.keyId ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp - payload.iat > 300
      )
        throw new Error('invalid routine token header or lifetime');
      return {
        workspaceId: z.uuid().parse(payload.workspace),
        binding: routineBinding.parse(payload.routine),
      };
    } catch {
      throw new AppError(401, 'unauthorized', 'routine credential is invalid or expired');
    }
  }
  /**
   * Checks a model token's signature, audience and expiry, without the
   * database: a token for a fenced or cancelled run keeps working until it
   * expires (spec 3.6). `graceSeconds` lets a usage report follow a response
   * that outlasted its token.
   */
  async verifyModel(token: string, graceSeconds = 0): Promise<VerifiedModelToken> {
    try {
      if (!isModelToken(token)) throw new Error('wrong credential type');
      const jwt = token.slice(modelPrefix.length);
      const usingRoutineKey = decodeProtectedHeader(jwt).typ === routineModelTokenType;
      const routineKey = this.options.routineModelVerificationKey;
      const key = usingRoutineKey ? routineKey : this.options.verificationKey;
      if (!key) throw new Error('routine model verification key is unavailable');
      const { payload, protectedHeader } = await jwtVerify(jwt, key, {
        algorithms: ['EdDSA'],
        issuer: this.options.issuer,
        audience: usingRoutineKey ? routineModelAudience : modelAudience,
        maxTokenAge: '5m',
        clockTolerance: graceSeconds,
        requiredClaims: ['iat', 'exp', 'jti'],
      });
      if (
        protectedHeader.typ !== (usingRoutineKey ? routineModelTokenType : modelTokenType) ||
        protectedHeader.kid !== this.options.keyId ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp - payload.iat > 300
      )
        throw new Error('invalid model token header or lifetime');
      const claims = modelClaims.parse(payload.model);
      // Dedicated credentials only authorize routine calls. The shared run key
      // still signs routine model tokens on self-hosted installations.
      if ((usingRoutineKey || routineKey) && usingRoutineKey !== (claims.kind === 'routine'))
        throw new Error('model claims do not match the signing key');
      return { ...claims, expiresAt: payload.exp };
    } catch {
      throw new AppError(401, 'unauthorized', 'model credential is invalid or expired');
    }
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
