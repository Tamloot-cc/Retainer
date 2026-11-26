import type { Actor, WorkspaceRole } from '@retainer/shared';
import type { CliIdentity } from './db/cli.js';
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
  /** A routine run's credential (routines spec §3.3); never reaches personal memory. */
  routine?: RoutineCaller;
  /** A workspace agent turn's credential (agent spec §7.3): writes re-check the turn. */
  agent?: AgentBinding;
  /** The API key the request came with, by its hash: a chat minted from it re-checks it (agent spec §7.3). */
  apiKey?: { hash: string };
  scopes: readonly ApiKeyScope[];
  /** The signed-in person, in accounts mode. */
  userId?: string;
  /**
   * The person who connected the app, for an MCP OAuth token (accounts spec
   * 4.7). The caller is still an agent: `userId` stays unset.
   */
  connectedBy?: string;
  cli?: CliIdentity & { role: WorkspaceRole; userName: string };
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
  | ({ kind: 'cli' } & CliIdentity)
  | { kind: 'key'; hash: string }
  /** A workspace agent chat's person (agent spec §7.1): their membership, through `retainer_agent_access`. */
  | { kind: 'agent'; userId: string };

/**
 * One claimed turn of a workspace agent session (agent spec §6.3). Writes
 * re-check it in their own transaction: a cancelled, timed-out or replaced
 * turn writes nothing more. A turn minted from the CLI login also needs that
 * login's elevation for each write (§6.7).
 */
export type AgentBinding = {
  sessionId: string;
  turnId: string;
  generation: number;
  cli?: CliIdentity;
};

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
   * What this request reacts to, from `Retainer-Caused-By`: feed positions
   * and tool calls (job IDs) of this installation. Its writes inherit their
   * server-recorded cause chains, so a hosted function or routine that
   * caused the app's write is not triggered by it again (§9.4).
   */
  causedBy?: { changes: string[]; toolCalls: string[] };
};

/** A routine run, from its signed token (routines spec §3.3). */
export type RoutineCaller = {
  runId: string;
  routineId: string | null;
  fence: string;
  mode: 'run' | 'test' | 'dry' | 'check' | 'build';
  /** The tools the run may call: its manifest's list. */
  tools: string[];
  /**
   * Set only by the server's effects path, which numbers and records each
   * write (§6.2). A routine token on the plain REST routes can only read.
   */
  effect?: boolean;
};
