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
export type RecordChange = {
  cursor: string;
  recordId: string;
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
