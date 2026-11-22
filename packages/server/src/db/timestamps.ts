/**
 * A timestamp column as ISO 8601 text with all six fractional digits. A
 * JavaScript `Date` keeps milliseconds only, so two changes in one
 * millisecond would share a record's `expectedUpdatedAt` (rule 2.5). Fixed
 * text only: `column` is never a request value.
 */
export const preciseTimestamp = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
