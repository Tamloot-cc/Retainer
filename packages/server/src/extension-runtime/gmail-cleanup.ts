import {
  deleteNangoGmailConnection,
  GmailProviderError,
  listNangoGmailAttemptConnections,
} from '@retainer/extension/nango-gmail';
import type { Sql } from '../db/client.js';
import { log } from '../log.js';

/** Discover grants even when a member never submits the OAuth completion. The
 * executor owns only the tags and the permission to list or delete connections. */
export async function cleanGmailAuthorizations(sql: Sql) {
  const apiKey = process.env.RETAINER_GMAIL_NANGO_CLEANUP_KEY ?? process.env.NANGO_API_KEY;
  if (!apiKey) return;
  const due = await sql<
    {
      attempt_id: string;
      workspace_id: string;
      member_tag: string;
      integration_id: string;
      bound_connection_id: string | null;
      fence: number;
      final_check: boolean;
    }[]
  >`
    with due as (
      select attempt_id from gmail_authorization_cleanups
      where next_attempt_at<=statement_timestamp()
      order by next_attempt_at,attempt_id limit 4 for update skip locked
    )
    update gmail_authorization_cleanups c
    set fence=c.fence+1,next_attempt_at=clock_timestamp()+interval '5 minutes'
    from due where c.attempt_id=due.attempt_id
    returning c.attempt_id,c.workspace_id,c.member_tag,c.integration_id,
      c.bound_connection_id,c.fence,c.final_check_at<=clock_timestamp() as final_check`;

  await Promise.all(
    due.map(async (attempt) => {
      const signal = AbortSignal.timeout(20000);
      const config = { apiKey, integrationId: attempt.integration_id };
      const tags = {
        organization_id: attempt.workspace_id,
        end_user_id: attempt.member_tag,
        retainer_attempt_id: attempt.attempt_id,
      };
      try {
        // Always drain the first page. Deleting from a paginated result would
        // shift the next page's offset. At most one bound connection may stay.
        for (;;) {
          const connections = await listNangoGmailAttemptConnections(config, tags, signal);
          const unbound = connections.filter((id) => id !== attempt.bound_connection_id);
          if (!unbound.length) break;
          await Promise.all(
            unbound.map((connectionId) =>
              deleteNangoGmailConnection({ ...config, connectionId }, signal),
            ),
          );
        }
        if (attempt.final_check) {
          await sql`delete from gmail_authorization_cleanups
          where attempt_id=${attempt.attempt_id} and fence=${attempt.fence}`;
        } else {
          // Recheck after the provider session and ordinary OAuth callbacks
          // have had time to settle, even if the first lookup was empty.
          await sql`update gmail_authorization_cleanups set next_attempt_at=final_check_at
          where attempt_id=${attempt.attempt_id} and fence=${attempt.fence}`;
        }
      } catch (error) {
        if (!(error instanceof GmailProviderError)) throw error;
        log.warn('gmail_authorization_cleanup_pending', { code: error.code });
      }
    }),
  );
}
