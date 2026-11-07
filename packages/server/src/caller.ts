import type { Actor } from '@retainer/shared';
import type { ApiKeyScope } from './db/schema.js';

/**
 * Who is making a request: taken from the credential (an API key, or in
 * accounts mode a person's session or an app's OAuth token), never from the
 * payload.
 */
export type Caller = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
  /** The signed-in person, in accounts mode. */
  userId?: string;
  /**
   * The person who connected the app, for an MCP OAuth token (accounts spec
   * 4.7). The caller is still an agent: `userId` stays unset.
   */
  connectedBy?: string;
};

/** Only a `user` actor with `admin` scope is a human approval (3). */
export function canApproveDestructive(actor: Actor, scopes: readonly ApiKeyScope[]): boolean {
  return actor.type === 'user' && scopes.includes('admin');
}
