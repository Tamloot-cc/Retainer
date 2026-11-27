import {
  type Actor,
  type DashboardSummary,
  type DashboardVisibility,
  type SavedDashboard,
  sameActor,
} from '@retainer/shared';
import { z } from 'zod';
import { agentAccessOf } from '../agent-runtime/access.js';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { aggregateInputSchema } from '../records/aggregate.js';
import { queryInputSchema } from '../records/query.js';
import { aggregate, findRecords } from '../records/service.js';
import { type CompiledSchema, getSchema } from '../schema/compiled.js';
import { translateDashboard } from './translate.js';

const visibility = z.enum(['private', 'workspace']);
const name = z.string().trim().min(1).max(100);
const chatId = z.uuid().nullable().optional();
export const dashboardChatFilter = z.uuid().optional();
export const createDashboardSchema = z.strictObject({
  name,
  program: z.string(),
  visibility: visibility.default('private'),
  chatId,
});
export const updateDashboardSchema = z.strictObject({
  name: name.optional(),
  program: z.string().optional(),
  visibility: visibility.optional(),
  chatId,
  position: z.number().finite().optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});

type Row = {
  id: string;
  name: string;
  program: string;
  visibility: DashboardVisibility;
  position: number;
  chat_id: string | null;
  created_by: Actor;
  updated_by: Actor;
  created_at: Date;
  updated_at: Date;
};
const ownerOf = (caller: Caller) => agentAccessOf(caller, { keys: true })?.owner ?? null;

function visible(tx: Tx, { actor }: Caller) {
  return tx`(d.visibility = 'workspace'
    or (d.created_by ->> 'type' = ${actor.type} and d.created_by ->> 'id' = ${actor.id}))`;
}

async function ownedChat(tx: Tx, caller: Caller, id: string, lock = false) {
  const [row] = await tx<{ id: string }[]>`
    select id from agent_sessions where id = ${id} and owner = ${ownerOf(caller)}
      and kind = 'chat' and status = 'open' ${lock ? tx`for share` : tx``}`;
  return !!row;
}

async function validateChat(tx: Tx, caller: Caller, id?: string | null) {
  if (id && !(await ownedChat(tx, caller, id, true)))
    throw new AppError(422, 'invalid_dashboard_chat', 'Choose an open chat you own');
}

function summary(row: Omit<Row, 'program'>, chat: string | null): DashboardSummary {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    visibility: row.visibility,
    chatId: chat,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function present(
  tx: Tx,
  caller: Caller,
  schema: CompiledSchema,
  row: Row,
): Promise<SavedDashboard> {
  const chat = row.chat_id && (await ownedChat(tx, caller, row.chat_id)) ? row.chat_id : null;
  const { program, issues } = translateDashboard(row.program, schema, 'read');
  return { ...summary(row, chat), program, issues };
}

async function workspace<T>(sql: Sql, caller: Caller, write: boolean, fn: (tx: Tx) => Promise<T>) {
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    if (write) await lockSchemaShared(tx, caller.workspaceId);
    await admitCaller(tx, caller, write);
    return fn(tx);
  });
}

async function load(tx: Tx, caller: Caller, id: string, lock = false): Promise<Row> {
  const [row] = await tx<Row[]>`
    select d.* from dashboards d where d.id = ${id} and ${visible(tx, caller)}
    ${lock ? tx`for update` : tx``}`;
  if (!row) throw notFound('dashboard');
  return row;
}

function storedProgram(program: string, schema: CompiledSchema) {
  const result = translateDashboard(program, schema, 'store');
  if (result.issues.length)
    throw new AppError(422, 'invalid_dashboard', 'Dashboard program is invalid', {
      problems: result.issues,
    });
  return result.program;
}

export async function listDashboards(sql: Sql, caller: Caller, chat?: string) {
  return workspace(sql, caller, false, async (tx) => {
    if (chat !== undefined && !(await ownedChat(tx, caller, chat))) throw notFound('chat');
    const rows = await tx<Omit<Row, 'program'>[]>`
      select d.id, d.name, d.visibility, d.position, d.created_by, d.updated_by, d.created_at, d.updated_at,
        s.id as chat_id
      from dashboards d left join agent_sessions s on s.id = d.chat_id
        and s.owner = ${ownerOf(caller)} and s.kind = 'chat' and s.status = 'open'
      where ${visible(tx, caller)} ${chat ? tx`and s.id = ${chat}` : tx``}
      order by d.position, d.created_at, d.id`;
    return { dashboards: rows.map((row) => summary(row, row.chat_id)) };
  });
}

export function readDashboard(sql: Sql, caller: Caller, id: string) {
  return workspace(sql, caller, false, async (tx) =>
    present(tx, caller, await getSchema(tx, caller.workspaceId), await load(tx, caller, id)),
  );
}

export function createDashboard(
  sql: Sql,
  caller: Caller,
  input: z.infer<typeof createDashboardSchema>,
) {
  return workspace(sql, caller, true, async (tx) => {
    await validateChat(tx, caller, input.chatId);
    const schema = await getSchema(tx, caller.workspaceId);
    const program = storedProgram(input.program, schema);
    const [row] = await tx<Row[]>`
      insert into dashboards (workspace_id, name, program, visibility, position, chat_id, created_by, updated_by)
      values (${caller.workspaceId}, ${input.name}, ${program}, ${input.visibility},
        (select coalesce(max(d.position), 0) + 1 from dashboards d where ${visible(tx, caller)}),
        ${input.chatId ?? null}, ${tx.json(caller.actor)}, ${tx.json(caller.actor)})
      returning *`;
    if (!row) throw new Error('Dashboard insert returned no row');
    return present(tx, caller, schema, row);
  });
}

export function updateDashboard(
  sql: Sql,
  caller: Caller,
  id: string,
  input: z.infer<typeof updateDashboardSchema>,
) {
  return workspace(sql, caller, true, async (tx) => {
    // Chat deletion locks the chat, then clears the dashboard's foreign key.
    await validateChat(tx, caller, input.chatId);
    const before = await load(tx, caller, id, true);
    if (before.updated_at.getTime() !== new Date(input.expectedUpdatedAt).getTime())
      throw new AppError(409, 'dashboard_changed', 'This dashboard changed since you opened it');
    if (
      input.visibility &&
      input.visibility !== before.visibility &&
      !sameActor(before.created_by, caller.actor)
    )
      throw forbidden('Only the dashboard creator can change visibility');
    const schema = await getSchema(tx, caller.workspaceId);
    const program =
      input.program === undefined ? before.program : storedProgram(input.program, schema);
    const [row] = await tx<Row[]>`
      update dashboards set name = ${input.name ?? before.name}, program = ${program},
        visibility = ${input.visibility ?? before.visibility}, position = ${input.position ?? before.position},
        chat_id = ${input.chatId === undefined ? before.chat_id : input.chatId},
        updated_by = ${tx.json(caller.actor)},
        updated_at = greatest(date_trunc('milliseconds', clock_timestamp()),
          date_trunc('milliseconds', updated_at) + interval '1 millisecond')
      where id = ${id} returning *`;
    if (!row) throw notFound('dashboard');
    return present(tx, caller, schema, row);
  });
}

export function deleteDashboard(sql: Sql, caller: Caller, id: string) {
  return workspace(sql, caller, true, async (tx) => {
    const rows =
      await tx`delete from dashboards d where d.id = ${id} and ${visible(tx, caller)} returning id`;
    if (!rows.length) throw notFound('dashboard');
  });
}

export async function checkDashboard(sql: Sql, caller: Caller, program: string) {
  const { issues: problems, queries } = await workspace(sql, caller, false, async (tx) =>
    translateDashboard(program, await getSchema(tx, caller.workspaceId), 'store'),
  );
  const checked: { statement: string; rows: number }[] = [];
  if (problems.length) return { ok: false, problems, queries: checked };
  for (const query of queries) {
    const { statement } = query;
    try {
      let rows: number;
      if (query.tool === 'query_records') {
        const { object, fields: _fields, ...input } = query.args;
        const result = await findRecords(
          sql,
          caller,
          object,
          queryInputSchema.parse({ ...input, include: ['relationReferences'] }),
        );
        rows = result.records.length;
      } else {
        const { object, ...input } = query.args;
        const result = await aggregate(sql, caller, object, aggregateInputSchema.parse(input));
        rows = result.total;
      }
      checked.push({ statement, rows });
      if (!rows) problems.push({ statement, message: 'The query returned no records' });
    } catch (error) {
      const message =
        error instanceof AppError || error instanceof z.ZodError
          ? error.message
          : 'The query failed';
      problems.push({ statement, message });
    }
  }
  return { ok: problems.length === 0, problems, queries: checked };
}
