export type ChangeOperation =
  | 'create'
  | 'update'
  | 'links'
  | 'delete'
  | 'merge'
  | 'retract'
  | 'supersede'
  | 'review'
  | 'forget'
  /**
   * Schema-level: a field or object type was deleted (deprecated) or an
   * object's label field changed. `recordId` is null, `objectTypeId` names
   * the affected type and `changedKeys` the affected field keys. No per-record
   * changes follow, so a handler rescans the type's current records.
   */
  | 'schema';
export type RecordChange = {
  cursor: string;
  /** Null only for a `schema` change. */
  recordId: string | null;
  objectTypeId: string;
  operation: ChangeOperation;
  changedKeys: string[];
  originInstallationId: string | null;
  cause: string[];
  relatedRecordIds: string[];
  mergedIntoId: string | null;
};
export type ChangePage = {
  changes: RecordChange[];
  nextCursor: string;
  headCursor: string;
  hasMore: boolean;
};
