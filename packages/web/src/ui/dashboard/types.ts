import type {
  AggregateInput,
  AggregateResult,
  AggregateValue,
  PresentedRecord,
  QueryInput,
  RecordPage,
} from '@retainer/shared';

export type { AggregateInput, AggregateResult, AggregateValue, PresentedRecord, QueryInput };

/** The two reads the data tools need: the web app's API client has both. */
export type RetainerClientLike = {
  queryRecords(object: string, input?: QueryInput): Promise<RecordPage>;
  aggregate(object: string, input?: AggregateInput): Promise<AggregateResult>;
};
