import { randomBytes } from 'node:crypto';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import {
  type FileMetadata,
  type FileStorage,
  fileMetadataSchema,
  type StoredObject,
} from '../file-storage/contract.js';
import { requestHash } from '../idempotency.js';
import { withRead, withWrite } from '../records/service.js';

export { fileMetadataSchema };

type Row = {
  id: string;
  installation_id: string | null;
  storage_id: string;
  object_key: string;
  metadata: FileMetadata;
  state: string;
  created_by: Caller['actor'];
  request_hash: string;
  upload_expires_at: Date;
};
const owner = (row: Row, caller: Caller) =>
  caller.run
    ? row.installation_id === caller.run.installationId
    : row.installation_id === null &&
      row.created_by.type === caller.actor.type &&
      row.created_by.id === caller.actor.id;
const missingStorage = () =>
  new AppError(503, 'storage_unavailable', 'file storage is not configured or unavailable');
async function lockBudget(tx: Tx, workspace: string) {
  await tx`select pg_advisory_xact_lock(21065::int4,hashtext(${workspace}))`;
}
export class Files {
  constructor(
    private readonly sql: Sql,
    private readonly storage: FileStorage | undefined,
    private readonly quota = 1024 * 1024 * 1024,
  ) {}
  private adapter(row?: Row) {
    if (!this.storage || (row && row.storage_id !== this.storage.id)) throw missingStorage();
    return this.storage;
  }
  async intent(caller: Caller, raw: FileMetadata, key: string) {
    const metadata = fileMetadataSchema.parse(raw),
      storage = this.adapter();
    if (!key || key.length > 200)
      throw new AppError(
        400,
        'invalid_request',
        'Idempotency-Key containing 1–200 characters required',
      );
    const requestKey = requestHash({
      actor: caller.actor,
      installation: caller.run?.installationId ?? null,
      generation: caller.run?.generation ?? null,
      key,
    });
    const digest = requestHash(metadata);
    const row = await withWrite(
      this.sql,
      caller,
      async (tx) => {
        await lockBudget(tx, caller.workspaceId);
        const [existing] = await tx<Row[]>`select * from files where request_key=${requestKey}`;
        if (existing) {
          if (existing.request_hash !== digest)
            throw new AppError(
              409,
              'idempotency_conflict',
              'upload key was used for different file metadata',
            );
          if (existing.state !== 'pending')
            throw new AppError(
              409,
              'upload_not_pending',
              'use the finalized file or create a new upload intent',
            );
          return existing;
        }
        const [usage] = await tx<
          { bytes: string; count: number }[]
        >`select count(*)::int as count,coalesce(sum(bytes),0)::text as bytes from files where state<>'erased'`;
        if ((usage?.count ?? 0) >= 10000 || Number(usage?.bytes ?? 0) + metadata.bytes > this.quota)
          throw new AppError(429, 'storage_quota_exceeded', 'workspace storage quota exceeded', {
            retryAfterSeconds: 60,
          });
        const [row] = await tx<
          Row[]
        >`insert into files(workspace_id,installation_id,storage_id,object_key,metadata,bytes,created_by,request_key,request_hash)
        values(${caller.workspaceId},${caller.run?.installationId ?? null},${storage.id},${randomBytes(32).toString('hex')},${tx.json(metadata)},${metadata.bytes},${tx.json(caller.actor)},${requestKey},${digest}) returning *`;
        if (!row) throw new Error('upload intent insert returned no row');
        return row;
      },
      {},
      { asPerson: false },
    );
    if (row.upload_expires_at.getTime() <= Date.now())
      throw new AppError(410, 'upload_expired', 'create a new upload intent');
    try {
      return {
        id: row.id,
        upload: await storage.upload(row.object_key, row.metadata, caller.run ? 'run' : 'public'),
      };
    } catch {
      throw missingStorage();
    }
  }
  async finalize(caller: Caller, id: string) {
    const candidate = await withRead(this.sql, caller, async (tx) => {
      const [row] = await tx<Row[]>`select * from files where id=${id}`;
      if (!row || !owner(row, caller)) throw notFound('file upload');
      return row;
    });
    const adapter = this.adapter(candidate);
    let object: StoredObject | null;
    try {
      object = await adapter.head(candidate.object_key);
    } catch {
      throw missingStorage();
    }
    if (
      !object ||
      object.bytes !== candidate.metadata.bytes ||
      object.sha256 !== candidate.metadata.sha256 ||
      object.mediaType !== candidate.metadata.mediaType
    )
      throw new AppError(
        422,
        'invalid_file_upload',
        'stored object does not match the upload intent',
      );
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const [row] = await tx<Row[]>`select * from files where id=${id} for update`;
        if (!row || !owner(row, caller)) throw notFound('file upload');
        if (!['pending', 'ready'].includes(row.state)) throw notFound('file upload');
        const [expired] =
          await tx`select 1 from files where id=${id} and expires_at<=clock_timestamp()`;
        if (row.state === 'pending' && expired)
          throw new AppError(410, 'upload_expired', 'upload intent expired');
        await tx`update files set state='ready' where id=${id}`;
        return { id, ...row.metadata, state: 'ready' as const };
      },
      {},
      { asPerson: false },
    );
  }
  private async visible(tx: Tx, id: string) {
    const [row] = await tx<
      Row[]
    >`select f.* from files f where f.id=${id} and f.state='ready' and exists(
      select 1 from file_references ref join field_assertions a on a.id=ref.assertion_id join records r on r.id=a.record_id
      where ref.file_id=f.id and ref.workspace_id=f.workspace_id and r.deleted_at is null and r.merged_into_id is null)`;
    if (!row) throw notFound('file');
    return row;
  }
  async get(caller: Caller, id: string) {
    return withRead(this.sql, caller, async (tx) => {
      const row = await this.visible(tx, id);
      return { id, ...row.metadata };
    });
  }
  async erasureStatus(caller: Caller, ids: string[]) {
    if (!caller.scopes.includes('admin'))
      throw new AppError(403, 'forbidden', 'admin scope required for erasure status');
    return withRead(this.sql, caller, async (tx) => {
      const jobs = await tx<
        { id: string; status: string; code: string | null }[]
      >`select id,status,code from file_deletions where id=any(${ids}::uuid[]) order by id`;
      if (jobs.length !== new Set(ids).size) throw notFound('file erasure');
      return {
        pending: jobs.filter((j) => j.status !== 'succeeded').length,
        succeeded: jobs.filter((j) => j.status === 'succeeded').length,
        jobs,
      };
    });
  }
  async download(caller: Caller, id: string) {
    // The shared privacy lock prevents erasure from overtaking visibility admission.
    return withRead(
      this.sql,
      caller,
      async (tx) => {
        const row = await this.visible(tx, id);
        try {
          return await this.adapter(row).download(
            row.object_key,
            row.metadata,
            caller.run ? 'run' : 'public',
          );
        } catch {
          throw missingStorage();
        }
      },
      { privacy: true },
    );
  }
}
