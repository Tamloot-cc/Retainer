import type { Caller } from '../caller.js';
import { jsonValue, publishAtCommit, type Tx } from '../db/tx.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { stableJson } from '../stable-json.js';

export type ChangeOperation =
  | 'create'
  | 'update'
  | 'links'
  | 'delete'
  | 'merge'
  | 'retract'
  | 'supersede'
  | 'review'
  | 'forget';
type Snapshot = {
  id: string;
  object_type_id: string;
  private_to_user: string | null;
  data: Record<string, unknown>;
  deleted: boolean;
  merged_into_id: string | null;
  current_evidence: boolean;
  type_active: boolean;
  label: string | null;
  incoming: string[];
  relations: Record<string, string[]>;
  participants: {
    link: string;
    handle: string | null;
    record_id: string | null;
    role: string | null;
  }[];
};
type Entry = { before: Snapshot | null; operation?: ChangeOperation; reviewKeys: Set<string> };
const values = (snapshot: Snapshot) => ({ ...snapshot.data, ...snapshot.relations });
const related = (snapshot: Snapshot | null) =>
  snapshot
    ? [
        ...Object.values(snapshot.relations).flat(),
        ...snapshot.participants.flatMap((p) => (p.record_id ? [p.record_id] : [])),
        ...snapshot.incoming,
        ...(snapshot.merged_into_id ? [snapshot.merged_into_id] : []),
      ]
    : [];
const equal = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);

/** In-memory transaction-local baselines only. Neither record bodies nor handles enter the outbox. */
export class ChangeCollector {
  private static readonly transactions = new WeakMap<Tx, ChangeCollector>();
  private readonly entries = new Map<string, Entry>();
  private published = false;
  private readonly erasedIds = new Set<string>();
  constructor(
    private readonly workspace: string,
    private readonly schema: CompiledSchema,
    private readonly origin: string | null,
    private readonly cause: string[],
  ) {}
  static async forCaller(tx: Tx, caller: Caller, schema: CompiledSchema) {
    const existing = ChangeCollector.transactions.get(tx);
    if (existing) return existing;
    const [job] = caller.run
      ? await tx<
          { cause: string[] }[]
        >`select cause from extension_jobs where id=${caller.run.jobId}`
      : [];
    const chain = job?.cause ?? [];
    const origin = caller.run?.installationId ?? caller.installation?.installationId ?? null;
    const collector = new ChangeCollector(
      caller.workspaceId,
      schema,
      origin,
      origin && !chain.includes(origin) ? [...chain, origin] : chain,
    );
    return ChangeCollector.attach(tx, collector);
  }
  static forSchema(tx: Tx, workspace: string, schema: CompiledSchema) {
    return (
      ChangeCollector.transactions.get(tx) ??
      ChangeCollector.attach(tx, new ChangeCollector(workspace, schema, null, []))
    );
  }
  private static attach(tx: Tx, collector: ChangeCollector) {
    ChangeCollector.transactions.set(tx, collector);
    publishAtCommit(tx, () => collector.publish(tx));
    return collector;
  }
  private async snapshot(tx: Tx, id: string): Promise<Snapshot | null> {
    const [row] = await tx<
      Snapshot[]
    >`select r.id,r.object_type_id,r.private_to_user,r.label,o.status='active' as type_active,
      coalesce((select jsonb_object_agg(f.key,r.data->f.key) from fields f where f.object_type_id=r.object_type_id and f.status='active' and r.data ? f.key),'{}'::jsonb) as data,
      r.deleted_at is not null as deleted,r.merged_into_id,
      not exists(select 1 from source_revisions v where v.workspace_id=r.workspace_id and v.event_id=r.id and not v.is_current) as current_evidence,
      coalesce((select jsonb_object_agg(x.key,x.targets) from (
        select f.key,jsonb_agg(l.target_record_id order by l.target_record_id) as targets from record_links l join fields f on f.id=l.field_id
        join records target on target.id=l.target_record_id and target.deleted_at is null and target.merged_into_id is null
        join object_types target_type on target_type.id=target.object_type_id and target_type.status='active'
        where l.workspace_id=r.workspace_id and l.source_record_id=r.id and f.status='active' group by f.key) x),'{}'::jsonb) as relations,
      coalesce((select jsonb_agg(jsonb_build_object('link',l.link,'handle',l.handle,'record_id',l.record_id,'role',l.role) order by l.position,l.id)
        from event_links l where l.workspace_id=r.workspace_id and l.event_id=r.id),'[]'::jsonb) as participants,
      coalesce((select jsonb_agg(distinct ref.id) from (
        select source_record_id as id from record_links where target_record_id=r.id
        union select event_id as id from event_links where record_id=r.id) ref),'[]'::jsonb) as incoming
      from records r join object_types o on o.id=r.object_type_id where r.workspace_id=${this.workspace} and r.id=${id}`;
    return row ?? null;
  }
  async capture(tx: Tx, id: string, operation?: ChangeOperation) {
    if (this.published) throw new Error('cannot capture records after feed publication');
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { before: await this.snapshot(tx, id), reviewKeys: new Set() };
      this.entries.set(id, entry);
    }
    if (operation) entry.operation = operation;
  }
  created(id: string) {
    if (this.published) throw new Error('cannot create records after feed publication');
    if (!this.entries.has(id)) this.entries.set(id, { before: null, reviewKeys: new Set() });
  }
  erase(ids: readonly string[]) {
    for (const id of ids) this.erasedIds.add(id);
  }
  async review(tx: Tx, id: string, key: string) {
    await this.capture(tx, id, 'review');
    this.entries.get(id)?.reviewKeys.add(key);
  }
  /** Must be the final stage: allocate positions only after all CRM locks and writes are finished. */
  private async publish(tx: Tx) {
    if (this.published) throw new Error('feed already published');
    this.published = true;
    const changes = [];
    for (const [id, entry] of [...this.entries].sort(([a], [b]) => a.localeCompare(b))) {
      const current = await this.snapshot(tx, id),
        prior = entry.before,
        visible = current ?? prior;
      if (
        !visible ||
        visible.private_to_user ||
        this.schema.objectsById.get(visible.object_type_id)?.hidden
      )
        continue;
      if (!prior && !current) continue;
      const before = prior ? values(prior) : {},
        after = current ? values(current) : {};
      const fieldKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => !equal(before[key], after[key]))
        .sort();
      const linksChanged = !equal(prior?.participants ?? [], current?.participants ?? []);
      const moved = prior && current && prior.object_type_id !== current.object_type_id;
      if (moved)
        changes.push({
          workspace_id: this.workspace,
          record_id: id,
          object_type_id: prior.object_type_id,
          operation: 'delete' as ChangeOperation,
          field_keys: Object.keys(before).sort(),
          related_record_ids: [...new Set(related(prior))]
            .filter((id) => !this.erasedIds.has(id))
            .sort(),
          origin_installation_id: this.origin,
          cause: this.cause,
          merged_into_id: null,
        });
      let operation: ChangeOperation = entry.operation ?? 'update';
      if (!prior || moved) operation = 'create';
      else if (!current) operation = entry.operation === 'forget' ? 'forget' : 'delete';
      else if (current.merged_into_id !== prior.merged_into_id) operation = 'merge';
      else if (current.deleted !== prior.deleted)
        operation = entry.operation === 'retract' ? 'retract' : 'delete';
      else if (current.type_active !== prior.type_active)
        operation = current.type_active ? 'create' : 'delete';
      else if (current.current_evidence !== prior.current_evidence) operation = 'supersede';
      else if (!fieldKeys.length && linksChanged) operation = 'links';
      else if (
        !fieldKeys.length &&
        !linksChanged &&
        equal(prior.label, current.label) &&
        operation !== 'review'
      )
        continue;
      const relationChanged = fieldKeys.some((key) =>
        this.schema.objectsById
          .get(visible.object_type_id)
          ?.activeFields.some((field) => field.key === key && field.type === 'relation'),
      );
      changes.push({
        workspace_id: this.workspace,
        record_id: id,
        object_type_id: visible.object_type_id,
        operation,
        field_keys: [...new Set([...fieldKeys, ...entry.reviewKeys])].sort(),
        related_record_ids: (['update', 'review'].includes(operation) && !relationChanged
          ? []
          : [...new Set([...related(prior), ...related(current)])]
        )
          .filter((id) => !this.erasedIds.has(id))
          .sort(),
        origin_installation_id: this.origin,
        cause: this.cause,
        merged_into_id: current?.merged_into_id ?? null,
      });
    }
    if (!changes.length) return;
    const candidates = [...new Set(changes.flatMap((change) => change.related_record_ids))];
    const authorized = candidates.length
      ? await tx<
          { id: string }[]
        >`select r.id from records r join object_types o on o.id=r.object_type_id and o.status='active'
      where r.id=any(${candidates}::uuid[]) and r.private_to_user is null and r.deleted_at is null and r.merged_into_id is null
      and r.object_type_id=any(${this.schema.visibleObjectIds}::uuid[])`
      : [];
    const allowed = new Set(authorized.map((r) => r.id));
    for (const change of changes)
      change.related_record_ids = change.related_record_ids.filter(
        (id) => allowed.has(id) && id !== change.record_id,
      );
    const [counter] = await tx<
      { position: string }[]
    >`insert into change_counters(workspace_id,position) values(${this.workspace},${changes.length})
      on conflict(workspace_id) do update set position=change_counters.position+excluded.position returning position`;
    if (!counter) throw new Error('feed counter unavailable');
    const end = BigInt(counter.position),
      start = end - BigInt(changes.length) + 1n;
    // No CRM reads, row locks or callbacks after acquiring the counter, and
    // one statement for every row, so the counter lock is held briefly.
    const rows = changes.map((change, i) => ({
      position: (start + BigInt(i)).toString(),
      record_id: change.record_id,
      object_type_id: change.object_type_id,
      operation: change.operation,
      field_keys: change.field_keys,
      related_record_ids: change.related_record_ids,
      origin_installation_id: change.origin_installation_id,
      cause: jsonValue(change.cause),
      merged_into_id: change.merged_into_id,
    }));
    await tx`insert into record_changes(workspace_id,position,record_id,object_type_id,operation,field_keys,related_record_ids,origin_installation_id,cause,merged_into_id)
      select ${this.workspace}::uuid,r.position,r.record_id,r.object_type_id,r.operation,r.field_keys,r.related_record_ids,r.origin_installation_id,r.cause,r.merged_into_id
      from jsonb_to_recordset(${tx.json(rows)}::jsonb) as r(position bigint,record_id uuid,object_type_id uuid,operation text,
        field_keys jsonb,related_record_ids jsonb,origin_installation_id uuid,cause jsonb,merged_into_id uuid)`;
  }
}
