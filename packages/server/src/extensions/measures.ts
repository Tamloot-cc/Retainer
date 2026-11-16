import type { Sql } from '../db/client.js';

/** `connect` failures that mean Tamloot access may have been left behind (spec 5.8). */
const LEAK_CODES = ['release_backlog', 'lost_backlog', 'exchange_interrupted'] as const;
/** The failure codes that move a connection to `needs_reconnect` (extension-runtime/lifecycle.ts). */
const RECONNECT_CODES = ['connection_required', 'invalid_connection', 'provider_unauthorized'];

/**
 * Connect with Tamloot's success measures for the last `days` days, per
 * registration (Tamloot connect spec 7). Counts and timings only; run as the
 * operator, across workspaces.
 */
export async function connectionMeasures(owner: Sql, days: number) {
  const rows = await owner<
    {
      registration_id: string;
      oauth: number;
      key: number;
      timed: number;
      median_seconds: number | null;
      needs_reconnect: number;
      release_incomplete: number;
      release_backlog: number;
      lost_backlog: number;
      exchange_interrupted: number;
    }[]
  >`with since as (select now()-${days}*interval '1 day' as t),
    connections as (
      select i.registration_id,c.* from extension_connections c
      join extension_installations i on i.id=c.installation_id and i.workspace_id=c.workspace_id
      where c.created_at>=(select t from since)),
    failures as (
      select i.registration_id,j.code from extension_jobs j
      join extension_installations i on i.id=j.installation_id and i.workspace_id=j.workspace_id
      where j.trigger_kind='connect' and j.status='failed' and j.updated_at>=(select t from since)
        and j.code=any(${[...LEAK_CODES]}::text[])),
    -- No column records when a connection reached needs_reconnect: the failed run
    -- that moved it there does (extension-runtime/lifecycle.ts), so long-lived
    -- connections count by when it happened, not by when they were created.
    reconnects as (
      select distinct i.registration_id,c.id from extension_jobs j
      join extension_connections c on c.id=j.connection_id and c.workspace_id=j.workspace_id
      join extension_installations i on i.id=c.installation_id and i.workspace_id=c.workspace_id
      where c.credential='oauth' and j.status='failed' and j.updated_at>=(select t from since)
        and j.code=any(${[...RECONNECT_CODES]}::text[]))
    select r.registration_id,
      (select count(*)::int from connections c where c.registration_id=r.registration_id and c.credential='oauth') as oauth,
      (select count(*)::int from connections c where c.registration_id=r.registration_id and c.credential='key') as key,
      (select count(*)::int from connections c where c.registration_id=r.registration_id
        and c.authorization_started_at is not null and c.connected_at is not null) as timed,
      (select percentile_cont(0.5) within group (order by extract(epoch from c.connected_at-c.authorization_started_at))
        from connections c where c.registration_id=r.registration_id
        and c.authorization_started_at is not null and c.connected_at is not null) as median_seconds,
      (select count(*)::int from reconnects x where x.registration_id=r.registration_id) as needs_reconnect,
      (select count(*)::int from extension_connections c join extension_installations i on i.id=c.installation_id
        where i.registration_id=r.registration_id and c.release_incomplete_at>=(select t from since)) as release_incomplete,
      (select count(*)::int from failures f where f.registration_id=r.registration_id and f.code='release_backlog') as release_backlog,
      (select count(*)::int from failures f where f.registration_id=r.registration_id and f.code='lost_backlog') as lost_backlog,
      (select count(*)::int from failures f where f.registration_id=r.registration_id and f.code='exchange_interrupted') as exchange_interrupted
    from (select distinct registration_id from connections
          union select distinct registration_id from failures
          union select distinct registration_id from reconnects
          union select distinct i.registration_id from extension_connections c join extension_installations i on i.id=c.installation_id
            where c.release_incomplete_at>=(select t from since)) r
    order by r.registration_id`;
  return rows.map((r) => ({
    registrationId: r.registration_id,
    newConnections: { oauth: r.oauth, key: r.key },
    /** Click to first activation, for OAuth connections that activated. */
    connectSeconds: {
      count: r.timed,
      median: r.median_seconds === null ? null : Math.round(r.median_seconds),
    },
    oauthNeedsReconnect: r.needs_reconnect,
    releaseIncomplete: r.release_incomplete,
    connectFailures: {
      release_backlog: r.release_backlog,
      lost_backlog: r.lost_backlog,
      exchange_interrupted: r.exchange_interrupted,
    },
  }));
}
