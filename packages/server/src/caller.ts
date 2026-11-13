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
  /** A signed, installation-bound execution credential; never reaches personal memory. */
  run?: RunBinding;
  /** A standalone workspace grant; no hosted lease, installer impersonation or personal memory. */
  installation?: InstallationBinding;
  scopes: readonly ApiKeyScope[];
  /** The signed-in person, in accounts mode. */
  userId?: string;
  /**
   * The person who connected the app, for an MCP OAuth token (accounts spec
   * 4.7). The caller is still an agent: `userId` stays unset.
   */
  connectedBy?: string;
  /**
   * The person whose personal memory this credential reaches, as `me`
   * (personal memory spec 4.3): the signed-in person, the person who
   * connected the app, or the person an API key works for. Unset for keys
   * that work for nobody and in key mode.
   */
  person?: CallerPerson;
};

export type CallerPerson = {
  id: string;
  name: string;
  /** How to ask again, inside a transaction, whether the credential still reaches the person. */
  check: PersonCheck;
};

/**
 * The credential behind `person`, re-checked through the same `SECURITY
 * DEFINER` function that authenticated it (4.3).
 */
export type PersonCheck =
  | { kind: 'session'; token: string }
  | { kind: 'oauth'; subject: string; workspace: string; client: string }
  | { kind: 'key'; hash: string };

/** Only a `user` actor with `admin` scope is a human approval (3). */
export function canApproveDestructive(actor: Actor, scopes: readonly ApiKeyScope[]): boolean {
  return actor.type === 'user' && scopes.includes('admin');
}

export type RunBinding = {
  /** Absent/null is the original workspace scope. Both fields are set for member runs. */
  connectionId?: string | null;
  connectionGeneration?: number | null;
  /** Reviewed registration name, copied by the trusted executor for display only. */
  registrationName?: string;
  installationId: string;
  registrationId: string;
  generation: number;
  jobId: string;
  owner: string;
  fence: string;
  releaseDigest: string;
  /** The claimed job's function; a run credential acts only for its own job's function. */
  functionId: string;
  scopes: ('read' | 'write')[];
};

export type InstallationBinding = {
  installationId: string;
  registrationId: string;
  /** The installation grant this credential was issued for; release upgrades keep it. */
  grantGeneration: number;
  credentialId: string;
  kind: 'key' | 'oauth';
  scopes: ('read' | 'write')[];
  /**
   * The feed position this request reacts to, from `Retainer-Caused-By`.
   * Its writes inherit that change's server-recorded cause chain, so a
   * hosted function that triggered the app is not triggered again (§9.4).
   */
  causedBy?: string;
};
