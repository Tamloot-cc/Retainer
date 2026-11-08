import {
  type Actor,
  type CommentPage,
  MAX_COMMENT_LENGTH,
  type PresentedComment,
  type PresentedRecord,
  sameActor,
} from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import { after, page } from '../db/pagination.js';
import type { Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { claimIdempotencyKey, requestHash, storeIdempotentResult } from '../idempotency.js';
import { lockLinkTargets } from '../memory/event-links.js';
import { findLiveRecord, getRecord } from '../records/read.js';
import { withRead, withWrite } from '../records/service.js';
import type { WriteContext } from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';

/**
 * Comments (1.3): what people tell each other about a record. They sit
 * outside the evidence model: no write here touches an assertion, a fact,
 * `records.data` or the timeline, and nothing can cite a comment. Only `user`
 * actors write them; agents read them as context. A comment follows its
 * record through merges and `forget` (`records/merge.ts`, `privacy/forget.ts`).
 */

/** How many of a record's newest comments `get_record` returns. */
const COMMENTS_ON_RECORD = 20;
const COMMENT_COLUMNS = [
  'id',
  'record_id',
  'body',
  'author',
  'created_at',
  'updated_at',
  'edited_at',
] as const;

/** Plain text. Surrounding space is dropped, and line breaks inside it are kept. */
export const commentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
});
type CommentInput = z.infer<typeof commentInputSchema>;

type CommentRow = {
  id: string;
  record_id: string;
  body: string;
  author: Actor;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
};

function present(row: CommentRow): PresentedComment {
  return {
    id: row.id,
    record: row.record_id,
    body: row.body,
    author: row.author,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}

/** A live record's comments, newest first, with their total. */
async function commentPage(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  limit: number,
  cursor?: string,
): Promise<CommentPage> {
  const [rows, [counted]] = await Promise.all([
    tx<(CommentRow & { stamp: string })[]>`
      select ${tx(COMMENT_COLUMNS)}, created_at::text as stamp
      from comments
      where workspace_id = ${workspaceId} and record_id = ${recordId} and deleted_at is null
        and ${after(tx, tx`created_at`, tx`id`, cursor, true)}
      order by created_at desc, id desc
      limit ${limit + 1}`,
    tx<{ total: number }[]>`
      select count(*)::int as total from comments
      where workspace_id = ${workspaceId} and record_id = ${recordId} and deleted_at is null`,
  ]);
  const result = page(rows, limit);
  return {
    record: recordId,
    items: result.items.map(present),
    total: counted?.total ?? 0,
    nextCursor: result.nextCursor,
  };
}

/** `GET /v1/records/:id/comments` and `list_comments`. A merged ID follows the merge. */
export async function listComments(
  sql: Sql,
  caller: Caller,
  recordId: string,
  limit: number,
  cursor?: string,
): Promise<CommentPage> {
  return withRead(sql, caller, async (tx, schema) => {
    const record = await findLiveRecord(tx, caller.workspaceId, schema, recordId);
    return commentPage(tx, caller.workspaceId, record.id, limit, cursor);
  });
}

/** `get_record`: the record with its newest comments and their total (4.1). */
export async function readRecordWithComments(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<PresentedRecord & { comments: Omit<CommentPage, 'record'> }> {
  return withRead(sql, caller, async (tx, schema) => {
    const record = await getRecord(tx, caller.workspaceId, schema, id);
    const { record: _record, ...comments } = await commentPage(
      tx,
      caller.workspaceId,
      record.id,
      COMMENTS_ON_RECORD,
    );
    return { ...record, comments };
  });
}

/**
 * Runs a comment write once per idempotency key, in the transaction of the
 * key's claim. A key is bound to the person: someone else reusing it gets
 * `idempotency_key_reused`, not the first author's comment back.
 */
async function once<T>(
  tx: Tx,
  context: WriteContext,
  operation: string,
  key: string | undefined,
  request: Record<string, unknown>,
  write: () => Promise<T>,
): Promise<T> {
  if (key === undefined) return write();
  const { type, id } = context.actor;
  const hash = requestHash({ ...request, actor: { type, id } });
  const claimed = await claimIdempotencyKey(tx, context.workspaceId, operation, key, hash, {
    personId: context.person?.id,
  });
  if (claimed.kind === 'replay') return claimed.result as T;
  const result = await write();
  await storeIdempotentResult(tx, claimed.id, result);
  return result;
}

/**
 * Adds a comment; a `user` key only (C2). The record is locked `FOR KEY
 * SHARE`, following merges, as relation writes do (4.2): a concurrent merge
 * either commits first and the comment lands on the survivor, or waits and
 * then moves this comment with the rest.
 */
export async function addComment(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: CommentInput,
  idempotencyKey?: string,
): Promise<PresentedComment> {
  if (caller.actor.type !== 'user') {
    throw forbidden(
      'only a person writes comments. Agents and integrations read them with get_record or ' +
        'list_comments as context; to keep something a comment says, write it with ' +
        'upsert_record or remember',
    );
  }
  return withWrite(sql, caller, (tx, context) =>
    once(
      tx,
      context,
      'comment.add',
      idempotencyKey,
      { record: recordId, body: input.body },
      async () => {
        const target = await lockTarget(tx, context, recordId);
        const [row] = await tx<CommentRow[]>`
          insert into comments (workspace_id, record_id, body, author)
          values (${caller.workspaceId}, ${target}, ${input.body}, ${tx.json(caller.actor)})
          returning ${tx(COMMENT_COLUMNS)}`;
        return present(row as CommentRow);
      },
    ),
  );
}

async function lockTarget(tx: Tx, context: WriteContext, recordId: string): Promise<string> {
  const records = await lockLinkTargets(tx, context.workspaceId, context.schema, [recordId]);
  const record = records.get(recordId);
  if (!record) throw notFound('record', { id: recordId });
  if (record.deleted) {
    throw new AppError(404, 'record_deleted', `record ${record.id} was deleted`, {
      recordId: record.id,
    });
  }
  return record.id;
}

/**
 * A live comment, locked. A comment hidden with its record, or deleted, is
 * not found, so what a person can no longer read they cannot change.
 */
async function lockComment(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
): Promise<CommentRow> {
  const [row] = await tx<
    (CommentRow & {
      deleted_at: Date | null;
      record_deleted_at: Date | null;
      object_type_id: string;
    })[]
  >`
    select c.id, c.record_id, c.body, c.author, c.created_at, c.updated_at, c.edited_at,
      c.deleted_at, r.deleted_at as record_deleted_at, r.object_type_id
    from comments c join records r on r.id = c.record_id
    where c.id = ${id} and c.workspace_id = ${workspaceId}
    for update of c`;
  if (
    !row ||
    row.deleted_at ||
    row.record_deleted_at ||
    schema.objectsById.get(row.object_type_id)?.hidden
  ) {
    throw notFound('comment', { id });
  }
  return row;
}

/** Edits the body; its author only. The same text again changes nothing, not even `editedAt`. */
export async function editComment(
  sql: Sql,
  caller: Caller,
  id: string,
  input: CommentInput,
  idempotencyKey?: string,
): Promise<PresentedComment> {
  return withWrite(sql, caller, (tx, context) =>
    once(tx, context, 'comment.edit', idempotencyKey, { id, body: input.body }, async () => {
      const row = await lockComment(tx, caller.workspaceId, context.schema, id);
      if (!sameActor(row.author, caller.actor)) {
        throw forbidden('only the author of a comment can edit it');
      }
      if (row.body === input.body) return present(row);
      const [updated] = await tx<CommentRow[]>`
        update comments set body = ${input.body}, edited_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where id = ${id}
        returning ${tx(COMMENT_COLUMNS)}`;
      return present(updated as CommentRow);
    }),
  );
}

/**
 * Soft-deletes a comment, as other memory is by default (2.1); `forget` is
 * what removes the text. Its author deletes it, or a `user` key with `admin`.
 */
export async function deleteComment(
  sql: Sql,
  caller: Caller,
  id: string,
  idempotencyKey?: string,
): Promise<{ id: string; deleted: true }> {
  return withWrite(sql, caller, (tx, context) =>
    once(tx, context, 'comment.delete', idempotencyKey, { id }, async () => {
      const row = await lockComment(tx, caller.workspaceId, context.schema, id);
      if (
        !sameActor(row.author, caller.actor) &&
        !canApproveDestructive(caller.actor, caller.scopes)
      ) {
        throw forbidden('only the author of a comment or an admin can delete it');
      }
      await tx`
        update comments set deleted_at = clock_timestamp(), updated_at = clock_timestamp(),
          deleted_by = ${tx.json(caller.actor)}
        where id = ${id}`;
      return { id, deleted: true as const };
    }),
  );
}
