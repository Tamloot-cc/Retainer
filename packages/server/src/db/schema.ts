import type {
  Actor,
  CoreRole,
  ExtensionRunFieldStatus,
  FieldSettings,
  FieldType,
  ObjectClass,
  OrganizationRole,
  SchemaChangeStatus,
  SchemaOwner,
  SchemaStatus,
  WorkspaceRole,
} from '@retainer/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Constraints Drizzle cannot express live in the custom migration
// drizzle/0001_security.sql: composite foreign keys that SET NULL a single
// column, the runtime role and its grants, row-level security policies and
// the API-key lookup function.

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

// Time-ordered (Postgres 18): new rows land at the end of the primary key index.
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });
const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/**
 * Tenant foreign keys include `workspace_id`, so a row can only reference a
 * parent in its own workspace. Every parent has a unique `(workspace_id, id)`.
 */
function tenantFk(
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  parent: [AnyPgColumn, AnyPgColumn],
) {
  return foreignKey({ name, columns, foreignColumns: parent }).onDelete('cascade');
}

// ---------------------------------------------------------------------------
// Tenancy and auth
// ---------------------------------------------------------------------------

export type AppliedTemplate = { name: string; version: number; appliedAt: string };

export type WorkspaceSettings = {
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold?: number;
  /** An IANA time zone; routine schedules are read in it (routines spec §7). UTC when unset. */
  timeZone?: string;
};

// ---------------------------------------------------------------------------
// People and organizations (docs/specs/accounts-and-access.md 4.2)
//
// Not tenant tables. Like api_keys they have row-level security on, with no
// policy and no grants for the runtime role (drizzle/0025_accounts_security).
// ---------------------------------------------------------------------------

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Better Auth's tables, as plain Drizzle definitions that import nothing from
 * it. The keys are Better Auth's field names; the `accounts` module maps its
 * models onto these tables. Columns follow this schema's naming instead of
 * its generated camelCase and naive timestamps.
 */
export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Set by an operator. A disabled person has no session and no access. */
  disabledAt: timestamptz('disabled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Sessions hold Better Auth's raw token; the signed cookie protects it (4.4). */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * A sign-in method linked to a person: their Google or Microsoft account, by
 * the provider's own ID. At most one of each per person (accounts spec 4.4).
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: id(),
    /** The provider's stable ID for the person: Google's subject, Microsoft's object ID. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    /** Unused: there are no passwords. Better Auth's model has the column. */
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('auth_accounts_provider_account_uq').on(t.providerId, t.accountId),
    // Also serves lookups by user_id alone.
    unique('auth_accounts_user_provider_uq').on(t.userId, t.providerId),
  ],
);

/** Short-lived values Better Auth checks once, such as OAuth state. */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull().unique(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: timestamptz('created_at').defaultNow(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

/** Browser-approved, person-bound CLI sign-ins. */
export const cliLogins = pgTable(
  'cli_logins',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    machineName: text('machine_name').notNull(),
    createdAt: createdAt(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [index('cli_logins_user_idx').on(t.userId)],
).enableRLS();

export const cliApprovals = pgTable(
  'cli_approvals',
  {
    id: id(),
    loginId: uuid('login_id')
      .notNull()
      .references(() => cliLogins.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    action: jsonb('action').notNull(),
    actionHash: text('action_hash').notNull(),
    resultId: uuid('result_id'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamptz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('cli_approvals_kind', sql`${t.kind} in ('elevation', 'action')`),
    check(
      'cli_approvals_status',
      sql`${t.status} in ('pending', 'approved', 'denied', 'used', 'ended', 'expired')`,
    ),
    check('cli_approvals_target', sql`num_nonnulls(${t.workspaceId}, ${t.organizationId}) = 1`),
    index('cli_approvals_login_idx').on(t.loginId),
    index('cli_approvals_workspace_idx').on(t.workspaceId),
    index('cli_approvals_organization_idx').on(t.organizationId),
    index('cli_approvals_decided_by_idx').on(t.decidedBy),
  ],
).enableRLS();

/** A verified passkey change, consumed by the write trigger. */
export const passkeyChangeAuthorizations = pgTable(
  'passkey_change_authorizations',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    credentialId: text('credential_id').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    check('passkey_change_authorizations_kind', sql`${t.kind} in ('insert', 'delete')`),
    unique('passkey_change_authorizations_target_uq').on(t.userId, t.kind, t.credentialId),
  ],
).enableRLS();

/** Sign-in rate limits, shared by every function instance (4.6). */
export const authRateLimits = pgTable('auth_rate_limits', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// ---------------------------------------------------------------------------
// OAuth for MCP (accounts spec 4.7): Better Auth's jwt, mcp() and cimd()
// models, written from its table definitions in this schema's style. Like
// the tables above, the runtime role has no access; the API reads signing
// keys and checks access through SECURITY DEFINER functions
// (drizzle/0036_oauth_security.sql).
// ---------------------------------------------------------------------------

/**
 * Signing keys for OAuth access tokens. The private key is encrypted with
 * RETAINER_AUTH_SECRET; the API reads public keys only.
 */
export const jwks = pgTable('jwks', {
  id: id(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  alg: text('alg'),
  crv: text('crv'),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at'),
});

/**
 * Apps that connect over OAuth: from a client metadata document, whose URL
 * is the client ID, or from dynamic registration.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: id(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    /** Public native client pre-registered for this workspace's setup prompt. */
    onboardingWorkspaceId: uuid('onboarding_workspace_id').references(
      (): AnyPgColumn => workspaces.id,
      {
        onDelete: 'cascade',
      },
    ),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at'),
    updatedAt: timestamptz('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('oauth_clients_user_idx').on(t.userId),
    index('oauth_clients_onboarding_workspace_idx')
      .on(t.onboardingWorkspaceId)
      .where(sql`${t.onboardingWorkspaceId} is not null`),
  ],
);

/** The protected resources tokens are issued for: Retainer's /mcp. */
export const oauthResources = pgTable('oauth_resources', {
  id: id(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: timestamptz('created_at'),
  updatedAt: timestamptz('updated_at'),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResources = pgTable(
  'oauth_client_resources',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at'),
  },
  (t) => [
    unique('oauth_client_resources_uq').on(t.clientId, t.resourceId),
    index('oauth_client_resources_resource_idx').on(t.resourceId),
  ],
);

/**
 * Better Auth's referenceId: the workspace UUID for existing person grants,
 * or a reviewed installation-credential UUID for workspace app grants.
 * Both reference kinds cascade with their owning workspace.
 */
const grantWorkspace = () =>
  uuid('reference_id').references(() => oauthGrantReferences.id, { onDelete: 'cascade' });

/** Rotating refresh tokens, stored hashed. */
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: id(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referenceId: grantWorkspace(),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    revoked: timestamptz('revoked'),
    rotatedAt: timestamptz('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamptz('rotation_replay_expires_at'),
    authTime: timestamptz('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_refresh_tokens_client_idx').on(t.clientId),
    index('oauth_refresh_tokens_session_idx').on(t.sessionId),
    index('oauth_refresh_tokens_user_idx').on(t.userId),
    index('oauth_refresh_tokens_code_idx').on(t.authorizationCodeId),
    index('oauth_refresh_tokens_workspace_idx').on(t.referenceId),
  ],
);

/**
 * Opaque access tokens, which Better Auth issues only without a resource.
 * Tokens for /mcp are JWTs and are not stored.
 */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: id(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: grantWorkspace(),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: uuid('refresh_id').references(() => oauthRefreshTokens.id, {
      onDelete: 'cascade',
    }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    revoked: timestamptz('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_access_tokens_client_idx').on(t.clientId),
    index('oauth_access_tokens_session_idx').on(t.sessionId),
    index('oauth_access_tokens_user_idx').on(t.userId),
    index('oauth_access_tokens_code_idx').on(t.authorizationCodeId),
    index('oauth_access_tokens_refresh_idx').on(t.refreshId),
    index('oauth_access_tokens_reference_idx').on(t.referenceId),
  ],
);

/**
 * A person's consent for an app in one workspace. A token works only while
 * its consent exists: disconnecting the app deletes it (4.7).
 */
export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: grantWorkspace(),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    // One consent per app, person and workspace; access checks look it up.
    unique('oauth_consents_grant_uq').on(t.clientId, t.userId, t.referenceId),
    index('oauth_consents_user_idx').on(t.userId),
    index('oauth_consents_workspace_idx').on(t.referenceId),
  ],
);

/** Single-use client assertion IDs (private_key_jwt clients). */
export const oauthClientAssertions = pgTable('oauth_client_assertions', {
  id: id(),
  expiresAt: timestamptz('expires_at').notNull(),
});

/** Quotas an organization may use; null means unlimited (4.10). */
export type OrganizationLimits = { workspaces?: number; members?: number };

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  limits: jsonb('limits').$type<OrganizationLimits>(),
  createdAt: createdAt(),
});

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrganizationRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('organization_members_user_idx').on(t.userId),
    check('organization_members_role', sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

/**
 * A person's role in one workspace. The composite foreign keys mean a role
 * exists only in a workspace of an organization the person belongs to, and
 * leaving the organization removes it in the same statement.
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<WorkspaceRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
    foreignKey({
      name: 'workspace_members_member_fk',
      columns: [t.organizationId, t.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_members_workspace_fk',
      columns: [t.organizationId, t.workspaceId],
      foreignColumns: [workspaces.organizationId, workspaces.id],
    }).onDelete('cascade'),
    check('workspace_members_role', sql`${t.role} in ('viewer', 'editor', 'admin')`),
  ],
);

/** A workspace and the role an invitation grants in it. */
export type InvitedWorkspace = { workspaceId: string; role: WorkspaceRole };

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Lowercased; accepting needs a verified address that matches (4.5). */
    email: text('email').notNull(),
    role: text('role').$type<OrganizationRole>().notNull(),
    workspaces: jsonb('workspaces').$type<InvitedWorkspace[]>().notNull().default([]),
    /** SHA-256 of the token in the link. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_organization_idx').on(t.organizationId),
    // GET /account looks up the invitations sent to the person's address.
    index('invitations_email_idx').on(t.email),
    check('invitations_role', sql`${t.role} in ('owner', 'admin', 'member')`),
    check('invitations_email_lower', sql`${t.email} = lower(${t.email})`),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    /**
     * Owns the workspace and its members. Never cascades: an organization is
     * deleted only once it has no workspaces.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** Set when someone deletes it; a scheduled run removes it 7 days later (4.5). */
    deletionScheduledAt: timestamptz('deletion_scheduled_at'),
    /** Increments on every applied schema change. API/MCP schemas cache on it. */
    schemaVersion: integer('schema_version').notNull().default(0),
    settings: jsonb('settings').$type<WorkspaceSettings>().notNull().default({}),
    /** Templates applied to this workspace, with their versions (3.1). */
    templates: jsonb('templates').$type<AppliedTemplate[]>().notNull().default([]),
    /** First applied change that adds a visible type. */
    initializedAt: timestamp('initialized_at', { withTimezone: true }),
    /**
     * Digest of the internal definitions and protection rules
     * the workspace was last fully upgraded to (3). Null until the first
     * upgrade run; a mismatch makes the next run plan an upgrade.
     */
    definitionsDigest: text('definitions_digest'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('workspaces_organization_id_uq').on(t.organizationId, t.id)],
);

export const API_KEY_SCOPES = ['read', 'write', 'schema:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * The runtime role has no access to this table; it reads keys only through
 * the SECURITY DEFINER function `retainer_lookup_api_key`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** First characters of the key, shown in listings. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key. The key itself is never stored. */
    hash: text('hash').notNull().unique(),
    scopes: text('scopes').array().$type<ApiKeyScope[]>().notNull(),
    /** The actor every write made with this key is attributed to. */
    actor: jsonb('actor').$type<Actor>().notNull(),
    /** The person who created it in the web app; null for CLI keys. */
    createdByUser: uuid('created_by_user').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The person this agent works for (personal memory spec 4.3): its
     * `me` is their personal memory. Set only to the person who creates the
     * key in the web app; never by the CLI.
     */
    actsForUser: uuid('acts_for_user').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('api_keys_workspace_idx').on(t.workspaceId),
    // Keys that work for a person, to revoke when they leave and to delete with them.
    index('api_keys_acts_for_idx')
      .on(t.actsForUser, t.workspaceId)
      .where(sql`${t.actsForUser} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// Schema (metadata)
// ---------------------------------------------------------------------------

export const objectTypes = pgTable(
  'object_types',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Same in every workspace for standard objects. */
    universalId: uuid('universal_id').notNull(),
    owner: text('owner').$type<SchemaOwner>().notNull(),
    status: text('status').$type<SchemaStatus>().notNull(),
    nameSingular: text('name_singular').notNull(),
    namePlural: text('name_plural').notNull(),
    labelSingular: text('label_singular').notNull(),
    labelPlural: text('label_plural').notNull(),
    description: text('description'),
    /** The field shown when a record is referenced (usually its name). */
    labelFieldId: uuid('label_field_id'),
    /** Server code depends on the object; set by the schema engine only (1.1). */
    isProtected: boolean('is_protected').notNull().default(false),
    /**
     * `entity` (a thing tracked) or `event` (something that happened, with a
     * time, a source identity and links). Fixed when the object is created.
     */
    class: text('class').$type<ObjectClass>().notNull().default('entity'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('object_types_workspace_id_uq').on(t.workspaceId, t.id),
    uniqueIndex('object_types_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('object_types_singular_uq')
      .on(t.workspaceId, t.nameSingular)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('object_types_plural_uq')
      .on(t.workspaceId, t.namePlural)
      .where(sql`${t.status} = 'active'`),
    check('object_types_class', sql`${t.class} in ('entity', 'event')`),
  ],
);

export const fields = pgTable(
  'fields',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id').notNull(),
    universalId: uuid('universal_id').notNull(),
    /**
     * Short permanent key used in `records.data`. Never changes and is never
     * reused, so renaming a field (changing `name`) never rewrites data.
     */
    key: text('key').notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    type: text('type').$type<FieldType>().notNull(),
    settings: jsonb('settings').$type<FieldSettings>().notNull().default({}),
    isNullable: boolean('is_nullable').notNull().default(true),
    isUnique: boolean('is_unique').notNull().default(false),
    isFilterable: boolean('is_filterable').notNull().default(false),
    isSearchable: boolean('is_searchable').notNull().default(false),
    /** Server code depends on the field; set by the schema engine only (1.1). */
    isProtected: boolean('is_protected').notNull().default(false),
    /** An event type's core field (`title` or `summary`); set by the schema engine only. */
    coreRole: text('core_role').$type<CoreRole>(),
    owner: text('owner').$type<SchemaOwner>().notNull(),
    status: text('status').$type<SchemaStatus>().notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('fields_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'fields_object_type_fk',
      [t.workspaceId, t.objectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    uniqueIndex('fields_universal_uq').on(t.workspaceId, t.universalId),
    uniqueIndex('fields_key_uq').on(t.objectTypeId, t.key),
    uniqueIndex('fields_name_uq').on(t.objectTypeId, t.name).where(sql`${t.status} = 'active'`),
    uniqueIndex('fields_core_role_uq')
      .on(t.objectTypeId, t.coreRole)
      .where(sql`${t.coreRole} is not null and ${t.status} = 'active'`),
    check('fields_core_role', sql`${t.coreRole} is null or ${t.coreRole} in ('title', 'summary')`),
  ],
);

export { SCHEMA_CHANGE_STATUSES, type SchemaChangeStatus } from '@retainer/shared';

export const schemaChanges = pgTable(
  'schema_changes',
  {
    id: id(),
    workspaceId: workspaceId(),
    status: text('status').$type<SchemaChangeStatus>().notNull(),
    /** The operations as requested; approval re-runs the engine on these. */
    request: jsonb('request').$type<unknown[]>().notNull(),
    /** The operations produced by the schema engine's diff. */
    operations: jsonb('operations').$type<unknown[]>().notNull(),
    /** True when any operation is destructive (rename, delete, required…). */
    isDestructive: boolean('is_destructive').notNull(),
    reason: text('reason'),
    template: jsonb('template').$type<Pick<AppliedTemplate, 'name' | 'version'>>(),
    requestedBy: jsonb('requested_by').$type<Actor>().notNull(),
    decidedBy: jsonb('decided_by').$type<Actor>(),
    /** `schema_version` after this change was applied. */
    appliedVersion: integer('applied_version'),
    error: text('error'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('schema_changes_workspace_status_idx').on(t.workspaceId, t.status, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const records = pgTable(
  'records',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id').notNull(),
    /**
     * Field values keyed by `fields.key`. A cache computed from
     * `field_assertions`; it can always be rebuilt from them.
     */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Server-computed search text (5.1); not a generated column. */
    search: tsvector('search'),
    /** The label field as plain text, for display and fuzzy lookup (5.1). */
    label: text('label'),
    /** Set when this record was merged into another (4.2). */
    mergedIntoId: uuid('merged_into_id'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    updatedBy: jsonb('updated_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
    /**
     * The person a personal profile or its internal notes are private to
     * (personal memory spec 4.2); null for every shared record. Deleting the
     * person deletes them.
     */
    privateToUser: uuid('private_to_user').references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('records_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'records_object_type_fk',
      [t.workspaceId, t.objectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    index('records_workspace_object_idx').on(t.workspaceId, t.objectTypeId, t.createdAt),
    index('records_data_gin').using(
      'gin',
      t.workspaceId,
      t.objectTypeId,
      t.data.op('jsonb_path_ops'),
    ),
    index('records_search_gin').using('gin', t.workspaceId, t.search),
    index('records_label_trgm').using('gin', t.workspaceId, t.label.op('gin_trgm_ops')),
    // Search text waiting to be rebuilt on boot (5.1); empty once rebuilt.
    index('records_search_stale_idx')
      .on(t.workspaceId, t.id)
      .where(sql`${t.search} is null and ${t.mergedIntoId} is null`),
    // Deleting a record clears merged_into_id on whatever was merged into it.
    // Without this, each deleted record scans its workspace's records: purging
    // a workspace of 360,000 records ran past the control function's 300
    // seconds, and takes 16 with this and the two indexes on facts below.
    index('records_merged_into_idx').on(t.mergedIntoId).where(sql`${t.mergedIntoId} is not null`),
    // A person's profile and private notes, to find and delete them, and
    // for deleting the person.
    index('records_private_idx')
      .on(t.privateToUser, t.workspaceId, t.objectTypeId)
      .where(sql`${t.privateToUser} is not null`),
  ],
);

/** Relations between records, one row per edge, derived from assertions. */
export const recordLinks = pgTable(
  'record_links',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The owning (many_to_one or many_to_many) relation field this edge belongs to. */
    fieldId: uuid('field_id').notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    targetRecordId: uuid('target_record_id').notNull(),
    /**
     * Whether the field holds a set (many_to_many). Derived from the field by
     * a trigger, never trusted from the writer, so the partial unique index
     * below enforces one target per single-record field (5.3).
     */
    isCollection: boolean('is_collection').notNull().default(false),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk('record_links_field_fk', [t.workspaceId, t.fieldId], [fields.workspaceId, fields.id]),
    tenantFk(
      'record_links_source_fk',
      [t.workspaceId, t.sourceRecordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'record_links_target_fk',
      [t.workspaceId, t.targetRecordId],
      [records.workspaceId, records.id],
    ),
    uniqueIndex('record_links_edge_uq').on(
      t.workspaceId,
      t.sourceRecordId,
      t.fieldId,
      t.targetRecordId,
    ),
    uniqueIndex('record_links_single_target_uq')
      .on(t.sourceRecordId, t.fieldId)
      .where(sql`not ${t.isCollection}`),
    // Incoming edges by target and field, covering the source, so a record's
    // rolled-up history finds its sources from the index alone (7.2).
    index('record_links_target_idx').on(
      t.workspaceId,
      t.targetRecordId,
      t.fieldId,
      t.sourceRecordId,
    ),
  ],
);

export const IDENTIFIER_KINDS = ['email', 'phone', 'domain', 'value'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * Normalized identifiers pointing at a record (1.2): every email, phone and
 * website domain, plus the value of every `is_unique` field. A claim row
 * enforces uniqueness through one partial index, with no per-field DDL.
 */
export const recordIdentifiers = pgTable(
  'record_identifiers',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    kind: text('kind').$type<IdentifierKind>().notNull(),
    /** Canonical value: lowercased email, E.164 phone, host, or JSON text. */
    value: text('value').notNull(),
    /** True when the field is unique; claims are what the unique index covers. */
    isClaim: boolean('is_claim').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'record_identifiers_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'record_identifiers_field_fk',
      [t.workspaceId, t.fieldId],
      [fields.workspaceId, fields.id],
    ),
    uniqueIndex('record_identifiers_claim_uq')
      .on(t.workspaceId, t.fieldId, t.value)
      .where(sql`${t.isClaim}`),
    index('record_identifiers_lookup_idx').on(t.workspaceId, t.kind, t.value),
    index('record_identifiers_record_idx').on(t.recordId, t.fieldId),
  ],
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * The built-in columns of an event record (1.3): when it happened and the
 * source identity it was logged under. One row per event record, written in
 * the transaction that creates the record and never changed afterwards,
 * except that erasure clears a raw identity (2.1). A deferred trigger
 * (0015_events_security.sql) makes every event-class record have exactly
 * one, and only event-class records any.
 */
export const eventRecords = pgTable(
  'event_records',
  {
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Where it came from, e.g. "gmail", "zoom", "whatsapp", "api". Null once erased. */
    channel: text('channel'),
    /** The source system's ID. Makes logging the same item twice a no-op. */
    externalId: text('external_id'),
    createdAt: createdAt(),
    /**
     * The person this row is private to (personal memory spec 4.2), or null
     * for a shared row. Set by the server, never by a client; a restrictive
     * row-level security policy hides it from everyone else.
     */
    privateToUser: uuid('private_to_user'),
  },
  (t) => [
    primaryKey({ name: 'event_records_pk', columns: [t.recordId] }),
    unique('event_records_workspace_record_uq').on(t.workspaceId, t.recordId),
    tenantFk(
      'event_records_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    // Deleted events keep their row, so their identity stays reserved (6.1).
    uniqueIndex('event_records_external_uq')
      .on(t.workspaceId, t.channel, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('event_records_workspace_time_idx').on(t.workspaceId, t.occurredAt, t.recordId),
    // An event's time by ID without reading the row: the per-source merge of
    // a record's history reads it once per attached event (7.2).
    index('event_records_record_time_idx').on(t.recordId, t.occurredAt),
  ],
);

/**
 * Why a participant was not matched to a record (4.1, 6.2). `ambiguous`:
 * the handle is claimed by more than one live record (1.2). `suppressed`:
 * the handle was erased by `forget` (2.1), so it is not stored.
 */
export const UNMATCHED_REASONS = [
  'no_match',
  'phone_only',
  'deleted_record',
  'ambiguous',
  'suppressed',
] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

/**
 * How a row links its record to the event (1.3). `participant`: who took
 * part. `about`: a record the event concerns, such as the company or
 * project of a meeting; it carries only `record_id`.
 */
export const EVENT_LINKS = ['participant', 'about'] as const;
export type EventLink = (typeof EVENT_LINKS)[number];

export const eventLinks = pgTable(
  'event_links',
  {
    id: id(),
    workspaceId: workspaceId(),
    eventId: uuid('event_id').notNull(),
    /** The link's place in the logged list, so reads keep the agent's order. */
    position: integer('position').notNull(),
    /** Normalized email address or E.164 phone number. */
    handle: text('handle'),
    /** The agent's own word for the part they played, e.g. "customer" or "from". */
    role: text('role'),
    /** Set once the participant is matched to a record. FK in 0015_events_security. */
    recordId: uuid('record_id'),
    /** Set when `record_id` is null: why the participant stayed unresolved. */
    unmatchedReason: text('unmatched_reason').$type<UnmatchedReason>(),
    link: text('link').$type<EventLink>().notNull(),
    /**
     * The person this row is private to (personal memory spec 4.2), or null
     * for a shared row. Set by the server, never by a client; a restrictive
     * row-level security policy hides it from everyone else.
     */
    privateToUser: uuid('private_to_user'),
  },
  (t) => [
    tenantFk('event_links_event_fk', [t.workspaceId, t.eventId], [records.workspaceId, records.id]),
    index('event_links_event_idx').on(t.eventId, t.position),
    index('event_links_record_idx').on(t.workspaceId, t.recordId, t.link),
    index('event_links_deleted_record_idx')
      .on(t.workspaceId)
      .where(sql`${t.unmatchedReason} = 'deleted_record'`),
    check(
      'event_links_unmatched_reason',
      sql`${t.unmatchedReason} in ('no_match', 'phone_only', 'deleted_record', 'ambiguous', 'suppressed')`,
    ),
    check('event_links_link', sql`${t.link} in ('participant', 'about')`),
    // An about row is only a record link. Its record_id is not required here:
    // the record FK sets it null when a workspace is deleted, and forget
    // deletes about rows before it deletes the record.
    check(
      'event_links_about_shape',
      sql`${t.link} = 'participant' or (${t.handle} is null and ${t.role} is null and ${t.unmatchedReason} is null)`,
    ),
  ],
);

/**
 * Event identities erased by `forget` (6.4): a keyed HMAC of the workspace,
 * channel and external ID, so logging the same source again is refused
 * without keeping the raw identity. `key_id` names the suppression key that
 * made the HMAC, so a key rotation keeps matching and a missing key fails
 * closed instead of silently clearing the suppression.
 */
export const eventIdentityTombstones = pgTable(
  'event_identity_tombstones',
  {
    id: id(),
    workspaceId: workspaceId(),
    keyId: text('key_id').notNull(),
    hmac: text('hmac').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('event_identity_tombstones_uq').on(t.workspaceId, t.keyId, t.hmac)],
);

/**
 * `retracted`: the source event was deleted, so the assertion no longer
 * counts and can never win again (rules 2.1, 2.4).
 */
export const ASSERTION_STATUSES = [
  'active',
  'superseded',
  'pending_review',
  'rejected',
  'retracted',
] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

/**
 * Why an assertion waits for review (rule 2.3). `unique_conflict`: a
 * recomputation would have restored a value another record now claims.
 */
export type ReviewReason = 'outranked' | 'low_confidence' | 'unique_conflict';

/** A claimed value for one field of one record. `records.data` is derived from these. */
export const fieldAssertions = pgTable(
  'field_assertions',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    value: jsonb('value').$type<unknown>(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    /** The event record cited as the source. FK in 0015_events_security (sets only this column to null). */
    sourceRecordId: uuid('source_record_id'),
    /** Written by `log_event` as the event's own initial values (6.2). */
    isInitial: boolean('is_initial').notNull().default(false),
    /** 0..1. People and integrations write 1. */
    confidence: real('confidence').notNull().default(1),
    status: text('status').$type<AssertionStatus>().notNull(),
    reviewReason: text('review_reason').$type<ReviewReason>(),
    /**
     * When the claim was true at the source: the cited event's `occurred_at`,
     * or server time for direct writes. Decides ties within a precedence.
     */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    reviewedBy: jsonb('reviewed_by').$type<Actor>(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: createdAt(),
    /** Transaction time groups a human feed entry without changing assertion ranking.
     * Null on assertions written before the Home feed was introduced. */
    writeAt: timestamp('write_at', { withTimezone: true }),
    /**
     * The person this row is private to (personal memory spec 4.2), or null
     * for a shared row. Set by the server, never by a client; a restrictive
     * row-level security policy hides it from everyone else.
     */
    privateToUser: uuid('private_to_user'),
  },
  (t) => [
    unique('field_assertions_ws_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'field_assertions_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'field_assertions_field_fk',
      [t.workspaceId, t.fieldId],
      [fields.workspaceId, fields.id],
    ),
    index('field_assertions_record_field_idx').on(t.recordId, t.fieldId, t.status),
    // Relation claims by target, for merges and forget (4.2, 2.1).
    index('field_assertions_field_idx').on(t.workspaceId, t.fieldId),
    index('field_assertions_source_idx')
      .on(t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
    index('field_assertions_initial_idx').on(t.recordId, t.fieldId).where(sql`${t.isInitial}`),
    index('field_assertions_feed_idx')
      .on(t.workspaceId, t.writeAt, t.recordId)
      .where(sql`${t.writeAt} is not null`),
    index('field_assertions_review_idx')
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending_review'`),
  ],
);

/** Additional records whose relationship path supports a derived assertion; erased before FK cascades. */
export const assertionDependencies = pgTable(
  'assertion_dependencies',
  {
    workspaceId: workspaceId(),
    assertionId: uuid('assertion_id').notNull(),
    supportRecordId: uuid('support_record_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.assertionId, t.supportRecordId] }),
    index('assertion_dependencies_support_idx').on(t.workspaceId, t.supportRecordId),
    tenantFk(
      'assertion_dependencies_assertion_fk',
      [t.workspaceId, t.assertionId],
      [fieldAssertions.workspaceId, fieldAssertions.id],
    ),
    tenantFk(
      'assertion_dependencies_support_fk',
      [t.workspaceId, t.supportRecordId],
      [records.workspaceId, records.id],
    ),
    pgPolicy('assertion_dependencies_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** A plain-language claim about a record. Superseded, never silently deleted. */
export const facts = pgTable(
  'facts',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    content: text('content').notNull(),
    kind: text('kind').$type<'stated' | 'inferred'>().notNull(),
    confidence: real('confidence').notNull().default(1),
    /** When the fact became true in the world; set from the source (rule 2.6). */
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    /** FK in 0001_security (sets only this column to null). */
    supersededBy: uuid('superseded_by'),
    /**
     * When `remember` replaced this fact with `supersedes` (personal memory
     * spec 4.9). Permanent: erasing the replacement may clear
     * `superseded_by`, never this, so the fact never becomes current again.
     */
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    /** Server-computed from content (5.1). */
    search: tsvector('search'),
    actor: jsonb('actor').$type<Actor>().notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
    /**
     * The person this row is private to (personal memory spec 4.2), or null
     * for a shared row. Set by the server, never by a client; a restrictive
     * row-level security policy hides it from everyone else.
     */
    privateToUser: uuid('private_to_user'),
  },
  (t) => [
    unique('facts_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk('facts_record_fk', [t.workspaceId, t.recordId], [records.workspaceId, records.id]),
    // Every fact of a record, for merges and record deletion (4.2, 2.1).
    index('facts_record_idx').on(t.recordId),
    index('facts_record_current_idx')
      .on(t.recordId, t.validFrom)
      .where(sql`${t.validTo} is null and ${t.deletedAt} is null`),
    index('facts_search_gin').using('gin', t.workspaceId, t.search),
    // Deleting a fact clears superseded_by on the facts it replaced; see
    // records_merged_into_idx.
    index('facts_superseded_by_idx').on(t.supersededBy).where(sql`${t.supersededBy} is not null`),
  ],
);

/** What a fact rests on: an event record (optionally a quote) or other facts. */
export const factSources = pgTable(
  'fact_sources',
  {
    id: id(),
    workspaceId: workspaceId(),
    factId: uuid('fact_id').notNull(),
    /** The event record cited. FK in 0015_events_security (sets only this column to null). */
    sourceRecordId: uuid('source_record_id'),
    premiseFactId: uuid('premise_fact_id'),
    quote: text('quote'),
    /**
     * The person this row is private to (personal memory spec 4.2), or null
     * for a shared row. Set by the server, never by a client; a restrictive
     * row-level security policy hides it from everyone else.
     */
    privateToUser: uuid('private_to_user'),
  },
  (t) => [
    tenantFk('fact_sources_fact_fk', [t.workspaceId, t.factId], [facts.workspaceId, facts.id]),
    tenantFk(
      'fact_sources_premise_fk',
      [t.workspaceId, t.premiseFactId],
      [facts.workspaceId, facts.id],
    ),
    index('fact_sources_fact_idx').on(t.factId),
    index('fact_sources_source_idx').on(t.sourceRecordId),
    // Deleting a fact removes the sources that cite it as a premise.
    index('fact_sources_premise_idx')
      .on(t.premiseFactId)
      .where(sql`${t.premiseFactId} is not null`),
  ],
);

/**
 * What people tell each other about a record (1.3): plain text, outside the
 * evidence model. Nothing cites a comment and no value derives from one.
 * Follows its record through merges and `forget` (2.1).
 */
export const comments = pgTable(
  'comments',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    body: text('body').notNull(),
    /** From the API key, never the payload. Only `user` actors write comments. */
    author: jsonb('author').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Null until the body changes. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: deletedAt(),
    /** The author, or an admin. */
    deletedBy: jsonb('deleted_by').$type<Actor>(),
  },
  (t) => [
    tenantFk('comments_record_fk', [t.workspaceId, t.recordId], [records.workspaceId, records.id]),
    // Every comment of a record, for merges and `forget`.
    index('comments_record_idx').on(t.recordId),
    // A record's live comments, newest first, and its total.
    index('comments_record_live_idx')
      .on(t.recordId, t.createdAt, t.id)
      .where(sql`${t.deletedAt} is null`),
    check('comments_body_length', sql`char_length(${t.body}) between 1 and 10000`),
  ],
);

/** Suggested merges of duplicate records; a `user` actor decides (4.2). */
export const mergeSuggestions = pgTable(
  'merge_suggestions',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The pair is stored in sorted order, so each pair has one row. */
    recordAId: uuid('record_a_id').notNull(),
    recordBId: uuid('record_b_id').notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<'pending' | 'accepted' | 'dismissed'>().notNull(),
    decidedBy: jsonb('decided_by').$type<Actor>(),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    tenantFk(
      'merge_suggestions_record_a_fk',
      [t.workspaceId, t.recordAId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'merge_suggestions_record_b_fk',
      [t.workspaceId, t.recordBId],
      [records.workspaceId, records.id],
    ),
    uniqueIndex('merge_suggestions_pair_uq').on(t.workspaceId, t.recordAId, t.recordBId),
    // The pair index covers record_a; this one covers record_b (4.2).
    index('merge_suggestions_record_b_idx').on(t.workspaceId, t.recordBId),
    index('merge_suggestions_pending_idx')
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('merge_suggestions_sorted_pair', sql`${t.recordAId} < ${t.recordBId}`),
  ],
);

// ---------------------------------------------------------------------------
// Views (1.4)
// ---------------------------------------------------------------------------

/**
 * A view's settings as stored: every field is named by `fields.key`
 * (rule 1.4.1). The API translates to and from field names.
 */
export type StoredViewConfig = {
  filter?: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  columns?: {
    order: string[];
    widths?: Record<string, number>;
    aggregates?: Record<string, string>;
  };
  groupBy?: string;
  hiddenGroups?: (string | null)[];
  groupAggregate?: { field: string; op: string };
  dateField?: string;
};

/** Saved ways of looking at one object's records: display settings, not data (1.4). */
export const views = pgTable(
  'views',
  {
    id: id(),
    workspaceId: workspaceId(),
    objectTypeId: uuid('object_type_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'table' | 'board' | 'calendar'>().notNull(),
    visibility: text('visibility').$type<'workspace' | 'private'>().notNull(),
    /** Order in the object's list of views; fractional, so one move is one update. */
    position: doublePrecision('position').notNull().default(0),
    config: jsonb('config').$type<StoredViewConfig>().notNull().default({}),
    /** A private view belongs to this actor alone. */
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    updatedBy: jsonb('updated_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk(
      'views_object_type_fk',
      [t.workspaceId, t.objectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    index('views_object_idx').on(t.workspaceId, t.objectTypeId, t.position),
    check('views_kind', sql`${t.kind} in ('table', 'board', 'calendar')`),
    check('views_visibility', sql`${t.visibility} in ('workspace', 'private')`),
  ],
);

/** Caller idempotency keys for create-style writes (6.2). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    workspaceId: workspaceId(),
    operation: text('operation').notNull(),
    /**
     * Whose retries the key covers (personal memory spec 4.2): the person
     * behind the credential, or `NO_PERSON_SCOPE` for one with none. Two
     * people reusing one key get independent claims.
     */
    personScope: uuid('person_scope')
      .notNull()
      .default(sql`'00000000-0000-0000-0000-000000000000'`),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** The original response, stored in the same transaction as the write. */
    result: jsonb('result').$type<unknown>(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Set when the stored response reads or changes private facts (personal
     * memory spec 4.2), so only that person can replay it. Deleting the
     * person deletes it.
     */
    privateToUser: uuid('private_to_user').references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('idempotency_keys_uq').on(t.workspaceId, t.operation, t.personScope, t.key),
    // A person's private responses, to clear them and to delete the person.
    index('idempotency_keys_private_idx')
      .on(t.privateToUser, t.workspaceId)
      .where(sql`${t.privateToUser} is not null`),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
  ],
);

/** Handles that must never be recreated after `forget` (2.1). */
export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').$type<'email' | 'phone'>().notNull(),
    /** Keyed HMAC of the normalized handle; a plain hash would be guessable. */
    hmac: text('hmac').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_uq').on(t.workspaceId, t.kind, t.hmac)],
);

/** Minimal record of a hard deletion: who, when and how much, never what (2.1). */
export const deletionAuditLog = pgTable(
  'deletion_audit_log',
  {
    id: id(),
    workspaceId: workspaceId(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('deletion_audit_log_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * Events moved from one event type to another (1.3): who moved which
 * events, and how their fields mapped. IDs and field names only, never
 * values. Only ever added to.
 */
export const eventMoves = pgTable(
  'event_moves',
  {
    id: id(),
    workspaceId: workspaceId(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    fromObjectTypeId: uuid('from_object_type_id').notNull(),
    toObjectTypeId: uuid('to_object_type_id').notNull(),
    eventIds: uuid('event_ids').array().notNull(),
    /** The field mapping, dropped fields and defaults, by field ID and name. */
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'event_moves_from_object_type_fk',
      [t.workspaceId, t.fromObjectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    tenantFk(
      'event_moves_to_object_type_fk',
      [t.workspaceId, t.toObjectTypeId],
      [objectTypes.workspaceId, objectTypes.id],
    ),
    index('event_moves_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

/**
 * The consolidator's last run per workspace (4.2). Workers take turns
 * through an advisory lock. `compared_until` is how far records have been
 * compared for merge suggestions, so a later run probes only newer changes.
 */
export const consolidatorRuns = pgTable('consolidator_runs', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  comparedUntil: timestamp('compared_until', { withTimezone: true }).notNull(),
  /** Counts from the last run: superseded facts, new suggestions. */
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
});

/**
 * Requests each workspace made in the current window, for its rate limit
 * (accounts spec 4.8). One row per workspace, overwritten as windows pass.
 * Unlogged (drizzle/0033_rate_limits_security.sql): it writes no WAL, and a
 * crash only forgets the current window's counts.
 */
export const workspaceRequestCounts = pgTable('workspace_request_counts', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  windowStart: timestamptz('window_start').notNull(),
  count: integer('count').notNull(),
});

// Release-owned extension installations and admitted runtime generations.
export const extensionInstallations = pgTable(
  'extension_installations',
  {
    id: id(),
    workspaceId: workspaceId(),
    registrationId: uuid('registration_id').notNull(),
    version: text('version').notNull(),
    releaseDigest: text('release_digest').notNull(),
    stateChangedBy: jsonb('state_changed_by').$type<Actor>(),
    state: text('state').notNull().default('disabled'),
    connectionHealth: text('connection_health').notNull().default('needs_reconnect'),
    lastError: text('last_error'),
    setupKind: text('setup_kind').notNull().default('install'),
    activatedAt: timestamptz('activated_at'),
    cleanupDeadline: timestamptz('cleanup_deadline'),
    // Fences runs, jobs and leases: every release, settings or state change bumps it.
    generation: integer('generation').notNull().default(1),
    // What standalone keys and OAuth grants bind to. Bumped only on disable,
    // uninstall, a grant or execution change, and reconnect, so a plain upgrade
    // or settings change keeps them valid.
    grantGeneration: integer('grant_generation').notNull().default(1),
    grantedActor: text('granted_actor').notNull(),
    grantedScopes: jsonb('granted_scopes').notNull(),
    /** Platform capabilities an admin approved, such as `model` (model calls spec 3.1). */
    grantedUses: jsonb('granted_uses').$type<string[]>().notNull().default([]),
    settings: jsonb('settings').notNull().default({}),
    settingsRevision: integer('settings_revision').notNull().default(1),
    bindings: jsonb('bindings'),
    // Zero identifies pre-binding installations. New installs start at one.
    bindingsRevision: integer('bindings_revision').notNull().default(0),
    /**
     * The newest release digest the automatic upgrade checked and left for an
     * admin to approve (extensions/auto-upgrade.ts), so it is not planned again
     * until a newer release ships.
     */
    upgradeHeldDigest: text('upgrade_held_digest'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    lastClaimedAt: timestamptz('last_claimed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('extension_installations_ws_id_uq').on(t.workspaceId, t.id),
    unique('extension_installations_registration_uq').on(t.workspaceId, t.registrationId),
    // Automatic-upgrade discovery reads active installations by registration.
    index('extension_installations_active_registration_idx')
      .on(t.registrationId, t.updatedAt, t.id)
      .where(sql`${t.state} = 'active'`),
    check(
      'extension_installations_state',
      sql`${t.state} in ('configuring', 'installing', 'active', 'setup_failed', 'disabled', 'upgrading', 'uninstalling', 'uninstalled')`,
    ),
    check('extension_installations_actor', sql`${t.grantedActor} in ('agent', 'integration')`),
    check('extension_installations_generation', sql`${t.generation} > 0`),
    check('extension_installations_grant_generation', sql`${t.grantGeneration} > 0`),
    pgPolicy('extension_installations_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

// Standalone credentials bind a reviewed workspace grant, never the installer's ongoing membership.
export const extensionCredentials = pgTable(
  'extension_credentials',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    // The installation's grant_generation when issued; valid only while they match.
    generation: integer('generation').notNull(),
    kind: text('kind').notNull(),
    keyHash: text('key_hash'),
    prefix: text('prefix'),
    clientId: text('client_id'),
    subjectId: text('subject_id'),
    scopes: jsonb('scopes').$type<('read' | 'write')[]>().notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamptz('revoked_at'),
    pending: boolean('pending').notNull().default(false),
  },
  (t) => [
    unique('extension_credentials_ws_id_uq').on(t.workspaceId, t.id),
    unique('extension_credentials_hash_uq').on(t.keyHash),
    tenantFk(
      'extension_credentials_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    index('extension_credentials_install_idx').on(t.workspaceId, t.installationId),
    check(
      'extension_credentials_kind',
      sql`(${t.kind}='key' and ${t.keyHash} is not null and ${t.prefix} is not null and ${t.clientId} is null and ${t.subjectId} is null)
      or (${t.kind}='oauth' and ${t.keyHash} is null and ${t.prefix} is null and ${t.clientId} is not null and ${t.subjectId} is not null)`,
    ),
    check('extension_credentials_generation', sql`${t.generation}>0`),
    check('extension_credentials_pending', sql`not ${t.pending} or ${t.kind}='oauth'`),
    check(
      'extension_credentials_scopes',
      sql`jsonb_typeof(${t.scopes})='array' and jsonb_array_length(${t.scopes}) between 1 and 2 and ${t.scopes}<@'["read","write"]'::jsonb`,
    ),
    pgPolicy('extension_credentials_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** OAuth consent references preserve workspace UUIDs for person grants and use credential UUIDs for installations. */
export const oauthGrantReferences = pgTable(
  'oauth_grant_references',
  {
    id: id(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    credentialId: uuid('credential_id'),
    cliLoginId: uuid('cli_login_id').references(() => cliLogins.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('oauth_grant_references_ws_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'oauth_grant_references_credential_fk',
      [t.workspaceId, t.credentialId],
      [extensionCredentials.workspaceId, extensionCredentials.id],
    ),
    index('oauth_grant_references_credential_idx').on(t.workspaceId, t.credentialId),
    index('oauth_grant_references_cli_login_idx').on(t.cliLoginId),
    check(
      'oauth_grant_references_kind',
      sql`(${t.kind}='person' and ${t.workspaceId} is not null and ${t.id}=${t.workspaceId} and ${t.credentialId} is null and ${t.cliLoginId} is null)
      or (${t.kind}='installation' and ${t.workspaceId} is not null and ${t.credentialId} is not null and ${t.id}=${t.credentialId} and ${t.cliLoginId} is null)
      or (${t.kind}='cli' and ${t.workspaceId} is null and ${t.credentialId} is null and ${t.cliLoginId} is not null and ${t.id}=${t.cliLoginId})`,
    ),
    pgPolicy('oauth_grant_references_installation', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid and ${t.kind}='installation'`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid and ${t.kind}='installation'`,
    }),
  ],
).enableRLS();

export const extensionContributions = pgTable(
  'extension_contributions',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    kind: text('kind').notNull(),
    universalId: uuid('universal_id').notNull(),
    elementId: uuid('element_id').notNull(),
    definition: jsonb('definition').notNull(),
  },
  (t) => [
    tenantFk(
      'extension_contributions_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    index('extension_contributions_install_idx').on(t.workspaceId, t.installationId),
    unique('extension_contributions_owner_uq').on(t.workspaceId, t.kind, t.universalId),
    pgPolicy('extension_contributions_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionReceipts = pgTable(
  'extension_receipts',
  {
    id: id(),
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    installationId: uuid('installation_id').notNull(),
    generation: integer('generation').notNull(),
    response: jsonb('response').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'extension_receipts_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    index('extension_receipts_install_idx').on(t.workspaceId, t.installationId),
    unique('extension_receipts_key_uq').on(t.workspaceId, t.key),
    pgPolicy('extension_receipts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

/** A person's credential boundary; the installation still owns every grant and CRM write. */
export const extensionConnections = pgTable(
  'extension_connections',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    owner: jsonb('owner').$type<Actor>().notNull(),
    ownerId: text('owner_id').notNull(),
    state: text('state').notNull().default('connecting'),
    health: text('health').notNull().default('ok'),
    lastError: text('last_error'),
    generation: integer('generation').notNull().default(1),
    settings: jsonb('settings')
      .$type<Record<string, string | boolean | number>>()
      .notNull()
      .default({}),
    settingsRevision: integer('settings_revision').notNull().default(1),
    sourceAccountId: uuid('source_account_id'),
    disconnectFunctionId: uuid('disconnect_function_id'),
    /** The secrets the reviewed disconnect hook declares; written with disconnect_function_id. */
    disconnectSecrets: text('disconnect_secrets').array().notNull().default(sql`'{}'::text[]`),
    /** How the member connected, fixed at creation (Tamloot connect spec 4.3). */
    credential: text('credential').notNull().default('key'),
    /** When the member clicked Connect, for an OAuth connection. */
    authorizationStartedAt: timestamptz('authorization_started_at'),
    /** A cleanup that held provider credentials did not finish (spec 4.7). */
    releaseIncompleteAt: timestamptz('release_incomplete_at'),
    releaseNoticeDismissedAt: timestamptz('release_notice_dismissed_at'),
    /** Incident IDs already recorded, at most 32, oldest dropped first. */
    releaseIncidents: text('release_incidents').array().notNull().default(sql`'{}'::text[]`),
    lastClaimedAt: timestamptz('last_claimed_at'),
    createdAt: createdAt(),
    connectedAt: timestamptz('connected_at'),
    disconnectedAt: timestamptz('disconnected_at'),
  },
  (t) => [
    unique('extension_connections_scope_uq').on(t.workspaceId, t.installationId, t.id),
    check('extension_connections_credential', sql`${t.credential} in ('key','oauth')`),
    check('extension_connections_release_incidents', sql`cardinality(${t.releaseIncidents})<=32`),
    index('extension_connections_account_idx').on(t.workspaceId, t.sourceAccountId),
    uniqueIndex('extension_connections_owner_uq')
      .on(t.workspaceId, t.installationId, t.ownerId)
      .where(sql`${t.state}<>'disconnected'`),
    tenantFk(
      'extension_connections_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    tenantFk(
      'extension_connections_account_fk',
      [t.workspaceId, t.sourceAccountId],
      [sourceAccounts.workspaceId, sourceAccounts.id],
    ),
    check(
      'extension_connections_owner',
      sql`coalesce(${t.owner}->>'type'='user' and ${t.owner}->>'id'=${t.ownerId} and length(${t.ownerId})>0,false)`,
    ),
    check(
      'extension_connections_state',
      sql`${t.state} in ('connecting','active','setup_failed','needs_reconnect','disconnected')`,
    ),
    check('extension_connections_health', sql`${t.health} in ('ok','needs_reconnect','degraded')`),
    check('extension_connections_versions', sql`${t.generation}>0 and ${t.settingsRevision}>0`),
    pgPolicy('extension_connections_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** One OAuth handshake in progress (Tamloot connect spec 4.3). The state is stored only hashed. */
export const extensionAuthorizations = pgTable(
  'extension_authorizations',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    /** The existing connection (reconnect) or the draft ID of a new one. */
    connectionId: uuid('connection_id').notNull(),
    ownerId: text('owner_id').notNull(),
    stateHash: text('state_hash').notNull(),
    /** Nango performs its own OAuth exchange. */
    verifierRef: uuid('verifier_ref'),
    settings: jsonb('settings')
      .$type<Record<string, string | boolean | number>>()
      .notNull()
      .default({}),
    reconnect: boolean('reconnect').notNull().default(false),
    expectedGeneration: integer('expected_generation'),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
  },
  (t) => [
    uniqueIndex('extension_authorizations_state_uq').on(t.workspaceId, t.stateHash),
    index('extension_authorizations_connection_idx').on(t.workspaceId, t.connectionId),
    index('extension_authorizations_owner_idx').on(t.workspaceId, t.installationId, t.ownerId),
    tenantFk(
      'extension_authorizations_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    check('extension_authorizations_state_hash', sql`${t.stateHash} ~ '^[a-f0-9]{64}$'`),
    pgPolicy('extension_authorizations_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** An OAuth session may outlive its member, installation or workspace. Keep only its exact
 * Nango lookup tags and claimed connection ID until cleanup has confirmed completion. */
export const gmailAuthorizationCleanups = pgTable(
  'gmail_authorization_cleanups',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    memberTag: text('member_tag').notNull(),
    integrationId: text('integration_id').notNull(),
    boundConnectionId: text('bound_connection_id'),
    nextAttemptAt: timestamptz('next_attempt_at').notNull(),
    finalCheckAt: timestamptz('final_check_at').notNull(),
    fence: integer('fence').notNull().default(0),
  },
  (t) => [
    index('gmail_authorization_cleanups_due_idx').on(t.nextAttemptAt, t.attemptId),
    pgPolicy('gmail_authorization_cleanups_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
    pgPolicy('gmail_authorization_cleanups_executor', {
      for: 'all',
      to: 'retainer_executor',
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const extensionJobs = pgTable(
  'extension_jobs',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    sourceItemId: uuid('source_item_id'),
    generation: integer('generation').notNull(),
    connectionGeneration: integer('connection_generation'),
    releaseDigest: text('release_digest').notNull(),
    functionId: uuid('function_id').notNull(),
    input: jsonb('input').notNull(),
    /** Server-copied IDs/keys only, so an accepted trigger survives public-feed retention. */
    changeSnapshot: jsonb('change_snapshot'),
    triggerKind: text('trigger_kind').notNull().default('job'),
    inputHash: text('input_hash').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    cause: jsonb('cause').$type<string[]>().notNull().default([]),
    /**
     * Server-derived trigger hops behind this job; null means `cause.length`.
     * A chain a standalone app inherits through `Retainer-Caused-By` excludes
     * installations but adds no depth (extensions spec §9.4).
     */
    causeDepth: integer('cause_depth'),
    /**
     * The secret settings the claimed function declares, copied from the pinned
     * release at claim. Broker admission releases only these (extensions spec §8).
     */
    runSecrets: text('run_secrets').array(),
    /** The pinned release's standalone tool needs a live app credential at broker admission. */
    runRequiresCredential: boolean('run_requires_credential').notNull().default(false),
    status: text('status').notNull().default('queued'),
    leaseOwner: text('lease_owner'),
    fence: bigint('fence', { mode: 'number' }).notNull().default(0),
    leaseUntil: timestamptz('lease_until'),
    runUntil: timestamptz('run_until'),
    attempt: integer('attempt').notNull().default(0),
    cycleAttempt: integer('cycle_attempt').notNull().default(0),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull().default(sql`now() + interval '24 hours'`),
    code: text('code'),
    /**
     * A tool call's output, checked against the tool's `outputSchema` when the
     * run succeeds (extensions-tools spec 3). Null for every other job.
     */
    output: jsonb('output'),
    /** The routine run that called this tool; polls must come from the same run (spec 4). */
    callerRunId: uuid('caller_run_id'),
    /** The member who started this tool from a button; polls must come from them (spec 4). */
    callerUserId: text('caller_user_id'),
    /**
     * The agent task this invocation waits for (`waiting`), or whose answer
     * this child job carries (agent spec §9.2).
     */
    agentTaskId: uuid('agent_task_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'extension_jobs_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('extension_jobs_ws_id_uq').on(t.workspaceId, t.id),
    unique('extension_jobs_dedupe_uq')
      .on(
        t.workspaceId,
        t.installationId,
        t.connectionId,
        t.connectionGeneration,
        t.generation,
        t.dedupeKey,
      )
      .nullsNotDistinct(),
    // Tool calls have a lane of their own, so a call never waits behind a
    // long sync of the same installation (extensions-tools spec 4).
    uniqueIndex('extension_jobs_one_running_uq')
      .on(t.workspaceId, t.installationId)
      .where(
        sql`${t.status} = 'running' and ${t.connectionId} is null and ${t.triggerKind} <> 'tool'`,
      ),
    uniqueIndex('extension_jobs_one_running_connection_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .where(
        sql`${t.status} = 'running' and ${t.connectionId} is not null and ${t.triggerKind} <> 'tool'`,
      ),
    uniqueIndex('extension_jobs_one_running_tool_uq')
      .on(t.workspaceId, t.installationId)
      .where(
        sql`${t.status} = 'running' and ${t.connectionId} is null and ${t.triggerKind} = 'tool'`,
      ),
    uniqueIndex('extension_jobs_one_running_tool_connection_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .where(
        sql`${t.status} = 'running' and ${t.connectionId} is not null and ${t.triggerKind} = 'tool'`,
      ),
    check(
      'extension_jobs_tool_caller',
      sql`${t.triggerKind} = 'tool' or (${t.output} is null and ${t.callerRunId} is null and ${t.callerUserId} is null)`,
    ),
    check(
      'extension_jobs_connection_generation',
      sql`(${t.connectionId} is null and ${t.connectionGeneration} is null) or (${t.connectionId} is not null and ${t.connectionGeneration} is not null and ${t.connectionGeneration}>0)`,
    ),
    index('extension_jobs_due_idx').on(t.status, t.availableAt),
    index('extension_jobs_retention_idx')
      .on(t.updatedAt, t.workspaceId)
      .where(sql`${t.status} in ('succeeded','failed','cancelled')`),
    index('extension_jobs_expiry_idx')
      .on(t.expiresAt, t.workspaceId)
      .where(sql`${t.status} in ('queued','running')`),
    index('extension_jobs_install_idx').on(t.workspaceId, t.installationId, t.createdAt),
    // Connection drains also look up jobs without an installation predicate.
    index('extension_jobs_connection_generation_status_idx').on(
      t.connectionId,
      t.connectionGeneration,
      t.status,
    ),
    /** Finds a record's newest live change job, which a later change may coalesce into (R9). */
    index('extension_jobs_coalesce_idx')
      .on(t.installationId, t.functionId, sql`(${t.changeSnapshot}->>'record_id')`)
      .where(sql`${t.status} in ('queued','running') and ${t.triggerKind} = 'change'`),
    index('extension_jobs_source_idx').on(t.workspaceId, t.sourceItemId),
    foreignKey({
      name: 'extension_jobs_source_fk',
      columns: [t.workspaceId, t.sourceItemId],
      foreignColumns: [sourceItems.workspaceId, sourceItems.id],
    }),
    tenantFk(
      'extension_jobs_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    check(
      'extension_jobs_status',
      sql`${t.status} in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')`,
    ),
    pgPolicy('extension_jobs_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionAttempts = pgTable(
  'extension_attempts',
  {
    id: id(),
    workspaceId: workspaceId(),
    jobId: uuid('job_id').notNull(),
    attempt: integer('attempt').notNull(),
    fence: bigint('fence', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    code: text('code'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    /** Only destination field IDs and dispositions from writes to the trigger record. */
    mappedFields: jsonb('mapped_fields').$type<Record<string, ExtensionRunFieldStatus>>(),
  },
  (t) => [
    tenantFk(
      'extension_attempts_job_fk',
      [t.workspaceId, t.jobId],
      [extensionJobs.workspaceId, extensionJobs.id],
    ),
    unique('extension_attempts_job_attempt_uq').on(t.workspaceId, t.jobId, t.attempt),
    pgPolicy('extension_attempts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionKv = pgTable(
  'extension_kv',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: 'extension_kv_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('extension_kv_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId, t.key)
      .nullsNotDistinct(),
    tenantFk(
      'extension_kv_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    check('extension_kv_value_size', sql`octet_length(${t.value}::text) <= 65536`),
    pgPolicy('extension_kv_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionWriteBudgets = pgTable(
  'extension_write_budgets',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    windowStart: timestamptz('window_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'extension_write_budgets_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('extension_write_budgets_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .nullsNotDistinct(),
    tenantFk(
      'extension_write_budgets_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    pgPolicy('extension_write_budgets_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionPendingSecrets = pgTable(
  'extension_pending_secrets',
  {
    id: id(),
    workspaceId: workspaceId(),
    connectionId: uuid('connection_id'),
    ownerId: text('owner_id'),
    draftInstallationId: uuid('draft_installation_id').notNull(),
    registrationId: uuid('registration_id').notNull(),
    name: text('name').notNull(),
    envelope: jsonb('envelope').notNull(),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull().default(sql`now()+interval '15 minutes'`),
    consumedAt: timestamptz('consumed_at'),
  },
  (t) => [
    index('extension_pending_secrets_ws_expiry_idx').on(t.workspaceId, t.expiresAt),
    pgPolicy('extension_pending_secrets_workspace', {
      for: 'all',
      to: 'retainer_secret_broker',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();
export const extensionSecrets = pgTable(
  'extension_secrets',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    name: text('name').notNull(),
    envelope: jsonb('envelope').notNull(),
    revision: integer('revision').notNull().default(1),
    deleteAfter: timestamptz('delete_after'),
  },
  (t) => [
    foreignKey({
      name: 'extension_secrets_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('extension_secrets_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId, t.name)
      .nullsNotDistinct(),
    tenantFk(
      'extension_secrets_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    pgPolicy('extension_secrets_workspace', {
      for: 'all',
      to: 'retainer_secret_broker',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionSchedules = pgTable(
  'extension_schedules',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    functionId: uuid('function_id').notNull(),
    nextDueAt: timestamptz('next_due_at').notNull(),
    lastOccurrence: timestamptz('last_occurrence'),
  },
  (t) => [
    foreignKey({
      name: 'extension_schedules_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('extension_schedules_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId, t.functionId)
      .nullsNotDistinct(),
    tenantFk(
      'extension_schedules_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    pgPolicy('extension_schedules_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

/** Metadata only: immutable bytes are held by an external storage adapter. */
export const files = pgTable(
  'files',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id'),
    sourceItemId: uuid('source_item_id'),
    storageId: text('storage_id').notNull().default('local-v1'),
    objectKey: text('object_key').notNull(),
    metadata: jsonb('metadata').notNull(),
    bytes: integer('bytes').notNull(),
    state: text('state').notNull().default('pending'),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    uploadExpiresAt: timestamptz('upload_expires_at')
      .notNull()
      .default(sql`clock_timestamp()+interval '5 minutes'`),
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`clock_timestamp()+interval '24 hours'`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('files_ws_id_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'files_installation_fk',
      columns: [t.workspaceId, t.installationId],
      foreignColumns: [extensionInstallations.workspaceId, extensionInstallations.id],
    }),
    unique('files_object_key_uq').on(t.objectKey),
    unique('files_request_key_uq').on(t.workspaceId, t.requestKey),
    index('files_expiry_idx').on(t.workspaceId, t.expiresAt),
    index('files_installation_idx').on(t.workspaceId, t.installationId),
    index('files_source_idx').on(t.workspaceId, t.sourceItemId),
    foreignKey({
      name: 'files_source_fk',
      columns: [t.workspaceId, t.sourceItemId],
      foreignColumns: [sourceItems.workspaceId, sourceItems.id],
    }),
    check('files_state', sql`${t.state} in ('pending','ready','erasing','erased')`),
    check('files_bytes', sql`${t.bytes}>0 and ${t.bytes}<=26214400`),
    pgPolicy('files_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const fileReferences = pgTable(
  'file_references',
  {
    workspaceId: workspaceId(),
    fileId: uuid('file_id').notNull(),
    assertionId: uuid('assertion_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.fileId, t.assertionId] }),
    tenantFk('file_references_file_fk', [t.workspaceId, t.fileId], [files.workspaceId, files.id]),
    tenantFk(
      'file_references_assertion_fk',
      [t.workspaceId, t.assertionId],
      [fieldAssertions.workspaceId, fieldAssertions.id],
    ),
    index('file_references_assertion_idx').on(t.workspaceId, t.assertionId),
    pgPolicy('file_references_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
/** Must survive workspace cascades until every stored version is erased. Opaque keys only. */
export const fileDeletions = pgTable(
  'file_deletions',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    storageId: text('storage_id').notNull().default('local-v1'),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull().default('queued'),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    leaseUntil: timestamptz('lease_until'),
    fence: bigint('fence', { mode: 'number' }).notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    code: text('code'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('file_deletions_object_key_uq').on(t.objectKey),
    index('file_deletions_due_idx').on(t.status, t.availableAt),
    pgPolicy('file_deletions_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

// Stable provider identities outlive installations; evidence revisions never mutate in place.
export const sourceAccounts = pgTable(
  'source_accounts',
  {
    id: id(),
    workspaceId: workspaceId(),
    registrationId: uuid('registration_id').notNull(),
    provider: text('provider').notNull(),
    namespace: text('namespace').notNull(),
    identity: text('identity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('source_accounts_ws_id_uq').on(t.workspaceId, t.id),
    unique('source_accounts_identity_uq').on(
      t.workspaceId,
      t.registrationId,
      t.provider,
      t.namespace,
    ),
    pgPolicy('source_accounts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const sourceBindings = pgTable(
  'source_bindings',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    accountId: uuid('account_id').notNull(),
    generation: integer('generation').notNull(),
    verifiedAt: timestamptz('verified_at').notNull().defaultNow(),
  },
  (t) => [
    unique('source_bindings_account_scope_uq').on(t.workspaceId, t.installationId, t.accountId),
    foreignKey({
      name: 'source_bindings_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('source_bindings_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .nullsNotDistinct(),
    tenantFk(
      'source_bindings_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    tenantFk(
      'source_bindings_account_fk',
      [t.workspaceId, t.accountId],
      [sourceAccounts.workspaceId, sourceAccounts.id],
    ),
    index('source_bindings_account_idx').on(t.workspaceId, t.accountId),
    pgPolicy('source_bindings_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
// Only operation clocks and fixed bounds survive KV erasure; no provider cursor or payload.
export const sourceSyncState = pgTable(
  'source_sync_state',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id'),
    generation: integer('generation').notNull(),
    scanId: uuid('scan_id').notNull(),
    mode: text('mode').notNull(),
    lowerBound: timestamptz('lower_bound').notNull(),
    upperBound: timestamptz('upper_bound').notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    lastSuccessfulScanAt: timestamptz('last_successful_scan_at'),
  },
  (t) => [
    foreignKey({
      name: 'source_sync_state_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    unique('source_sync_state_scope_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .nullsNotDistinct(),
    tenantFk(
      'source_sync_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    check('source_sync_mode', sql`${t.mode} in ('created','updated')`),
    check('source_sync_bounds', sql`${t.lowerBound}<=${t.upperBound}`),
    pgPolicy('source_sync_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
/** Durable child identities; provider removal and local deletion have different restore rules. */
export const sourceTasks = pgTable(
  'source_tasks',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    accountId: uuid('account_id').notNull(),
    externalId: text('external_id').notNull(),
    itemId: uuid('item_id').notNull(),
    recordId: uuid('record_id').notNull(),
    sourceEventId: uuid('source_event_id').notNull(),
    state: text('state').notNull().default('synced'),
    contentDigest: text('content_digest'),
    actorName: text('actor_name'),
  },
  (t) => [
    unique('source_tasks_identity_uq').on(t.workspaceId, t.accountId, t.externalId),
    tenantFk(
      'source_tasks_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    tenantFk(
      'source_tasks_account_fk',
      [t.workspaceId, t.accountId],
      [sourceAccounts.workspaceId, sourceAccounts.id],
    ),
    tenantFk(
      'source_tasks_item_fk',
      [t.workspaceId, t.itemId],
      [sourceItems.workspaceId, sourceItems.id],
    ),
    tenantFk(
      'source_tasks_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    tenantFk(
      'source_tasks_event_fk',
      [t.workspaceId, t.sourceEventId],
      [records.workspaceId, records.id],
    ),
    index('source_tasks_install_idx').on(t.workspaceId, t.installationId),
    index('source_tasks_item_idx').on(t.workspaceId, t.itemId),
    index('source_tasks_record_idx').on(t.workspaceId, t.recordId),
    index('source_tasks_event_idx').on(t.workspaceId, t.sourceEventId),
    check('source_tasks_state', sql`${t.state} in ('synced','detached','local_deleted','removed')`),
    pgPolicy('source_tasks_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

export const sourceItems = pgTable(
  'source_items',
  {
    id: id(),
    workspaceId: workspaceId(),
    accountId: uuid('account_id').notNull(),
    externalId: text('external_id'),
    state: text('state').notNull().default('reserved'),
    providerRevision: text('provider_revision'),
    taskWriteRevision: integer('task_write_revision').notNull().default(0),
    preparedJobId: uuid('prepared_job_id'),
    preparedFence: bigint('prepared_fence', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('source_items_ws_id_uq').on(t.workspaceId, t.id),
    unique('source_items_identity_uq').on(t.workspaceId, t.accountId, t.externalId),
    tenantFk(
      'source_items_account_fk',
      [t.workspaceId, t.accountId],
      [sourceAccounts.workspaceId, sourceAccounts.id],
    ),
    check(
      'source_items_state',
      sql`${t.state} in ('reserved','live','unavailable','deleted','retracted','erased')`,
    ),
    check('source_items_erased_identity', sql`(${t.state}='erased')=(${t.externalId} is null)`),
    pgPolicy('source_items_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const sourceRevisions = pgTable(
  'source_revisions',
  {
    id: id(),
    workspaceId: workspaceId(),
    itemId: uuid('item_id').notNull(),
    eventId: uuid('event_id').notNull(),
    contentDigest: text('content_digest').notNull(),
    providerRevision: text('provider_revision'),
    isCurrent: boolean('is_current').notNull().default(true),
    previousEventId: uuid('previous_event_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('source_revisions_ws_id_uq').on(t.workspaceId, t.id),
    unique('source_revisions_event_uq').on(t.workspaceId, t.eventId),
    uniqueIndex('source_revisions_current_uq')
      .on(t.workspaceId, t.itemId)
      .where(sql`${t.isCurrent}`),
    index('source_revisions_item_idx').on(t.workspaceId, t.itemId),
    index('source_revisions_previous_idx').on(t.workspaceId, t.previousEventId),
    tenantFk(
      'source_revisions_item_fk',
      [t.workspaceId, t.itemId],
      [sourceItems.workspaceId, sourceItems.id],
    ),
    tenantFk(
      'source_revisions_event_fk',
      [t.workspaceId, t.eventId],
      [records.workspaceId, records.id],
    ),
    // Previous IDs are historical hints only: forgetting a revision removes its entire item.
    pgPolicy('source_revisions_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
/**
 * The full text behind an event, kept out of `records.data` so a long email or
 * transcript never truncates the event's summary (1.3). Any source can store
 * one: a Gmail message, a meeting transcript. Events that share a `thread_id`
 * read as one conversation, oldest first, and activity shows the newest one.
 * Immutable: a changed source logs a new event with a new body.
 */
export const eventBodies = pgTable(
  'event_bodies',
  {
    eventId: uuid('event_id').primaryKey(),
    workspaceId: workspaceId(),
    threadId: uuid('thread_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    /** The date the source itself reported, when it differs from occurred_at. */
    originalDate: timestamptz('original_date'),
    body: text('body').notNull(),
    search: tsvector('search').notNull(),
  },
  (t) => [
    unique('event_bodies_ws_id_uq').on(t.workspaceId, t.eventId),
    tenantFk(
      'event_bodies_event_fk',
      [t.workspaceId, t.eventId],
      [records.workspaceId, records.id],
    ),
    index('event_bodies_thread_idx')
      .on(t.workspaceId, t.threadId, t.occurredAt, t.eventId)
      .where(sql`${t.threadId} is not null`),
    index('event_bodies_search_gin').using('gin', t.workspaceId, t.search),
    pgPolicy('event_bodies_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** One copy of a Gmail message in a verified member mailbox. */
export const gmailDeliveries = pgTable(
  'gmail_deliveries',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    messageId: uuid('message_id').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    providerThreadId: text('provider_thread_id').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'gmail_deliveries_pk',
      columns: [t.workspaceId, t.connectionId, t.providerMessageId],
    }),
    foreignKey({
      name: 'gmail_deliveries_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    tenantFk(
      'gmail_deliveries_message_fk',
      [t.workspaceId, t.messageId],
      [eventBodies.workspaceId, eventBodies.eventId],
    ),
    index('gmail_deliveries_connection_idx').on(t.connectionId),
    index('gmail_deliveries_thread_idx').on(t.workspaceId, t.connectionId, t.providerThreadId),
    index('gmail_deliveries_message_idx').on(t.workspaceId, t.messageId),
    pgPolicy('gmail_deliveries_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** An exact Person email added while Gmail is installed, with the history limit at that write. */
export const gmailContactAdditions = pgTable(
  'gmail_contact_additions',
  {
    id: id(),
    workspaceId: workspaceId(),
    recordId: uuid('record_id').notNull(),
    email: text('email').notNull(),
    createdAt: timestamptz('created_at').notNull().default(sql`clock_timestamp()`),
    historyDays: integer('history_days').notNull(),
  },
  (t) => [
    unique('gmail_contact_additions_workspace_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'gmail_contact_additions_record_fk',
      [t.workspaceId, t.recordId],
      [records.workspaceId, records.id],
    ),
    index('gmail_contact_additions_at_idx').on(t.workspaceId, t.createdAt, t.id),
    index('gmail_contact_additions_record_idx').on(t.workspaceId, t.recordId),
    pgPolicy('gmail_contact_additions_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** Per-mailbox acknowledgements avoid skipping additions from concurrent Person writes. */
export const gmailContactScans = pgTable(
  'gmail_contact_scans',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    additionId: uuid('addition_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.connectionId, t.additionId] }),
    foreignKey({
      name: 'gmail_contact_scans_connection_fk',
      columns: [t.workspaceId, t.installationId, t.connectionId],
      foreignColumns: [
        extensionConnections.workspaceId,
        extensionConnections.installationId,
        extensionConnections.id,
      ],
    }).onDelete('cascade'),
    tenantFk(
      'gmail_contact_scans_addition_fk',
      [t.workspaceId, t.additionId],
      [gmailContactAdditions.workspaceId, gmailContactAdditions.id],
    ),
    index('gmail_contact_scans_connection_idx').on(t.connectionId),
    index('gmail_contact_scans_addition_idx').on(t.workspaceId, t.additionId),
    pgPolicy('gmail_contact_scans_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

export const sourceReceipts = pgTable(
  'source_receipts',
  {
    workspaceId: workspaceId(),
    itemId: uuid('item_id').notNull(),
    key: text('key').notNull(),
    contentDigest: text('content_digest').notNull(),
    response: jsonb('response').notNull(),
    projection: jsonb('projection'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.itemId, t.key] }),
    tenantFk(
      'source_receipts_item_fk',
      [t.workspaceId, t.itemId],
      [sourceItems.workspaceId, sourceItems.id],
    ),
    pgPolicy('source_receipts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** Minimal staged participant ownership makes pending source uploads erasable before an event exists. */
export const sourceParticipants = pgTable(
  'source_participants',
  {
    workspaceId: workspaceId(),
    itemId: uuid('item_id').notNull(),
    email: text('email').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.itemId, t.email] }),
    tenantFk(
      'source_participants_item_fk',
      [t.workspaceId, t.itemId],
      [sourceItems.workspaceId, sourceItems.id],
    ),
    index('source_participants_email_idx').on(t.workspaceId, t.email),
    pgPolicy('source_participants_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** Allocated only at transaction end; a cursor can never pass an uncommitted lower position. */
export const changeCounters = pgTable(
  'change_counters',
  {
    workspaceId: workspaceId().primaryKey(),
    position: bigint('position', { mode: 'number' }).notNull().default(0),
    retainedAfter: bigint('retained_after', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    pgPolicy('change_counters_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const recordChanges = pgTable(
  'record_changes',
  {
    workspaceId: workspaceId(),
    position: bigint('position', { mode: 'number' }).notNull(),
    /** Null only for a schema-level change, which names an object type and field keys. */
    recordId: uuid('record_id'),
    objectTypeId: uuid('object_type_id').notNull(),
    operation: text('operation').notNull(),
    fieldKeys: jsonb('field_keys').$type<string[]>().notNull(),
    relatedRecordIds: jsonb('related_record_ids').$type<string[]>().notNull().default([]),
    originInstallationId: uuid('origin_installation_id'),
    cause: jsonb('cause').$type<string[]>().notNull().default([]),
    /** Server-derived trigger hops; null means `cause.length` (see extension_jobs). */
    causeDepth: integer('cause_depth'),
    mergedIntoId: uuid('merged_into_id'),
    /** On every change a merge made: the record it merged away. A merge is not a routine trigger. */
    mergedFromId: uuid('merged_from_id'),
    createdAt: timestamptz('created_at').notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.position] }),
    index('record_changes_record_idx').on(t.workspaceId, t.recordId),
    index('record_changes_retention_idx').on(t.createdAt),
    check(
      'record_changes_operation',
      sql`${t.operation} in ('create','update','links','delete','merge','retract','supersede','review','forget','schema')`,
    ),
    check('record_changes_schema_record', sql`(${t.operation}='schema')=(${t.recordId} is null)`),
    pgPolicy('record_changes_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const changeDispatch = pgTable(
  'change_dispatch',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    generation: integer('generation').notNull(),
    position: bigint('position', { mode: 'number' }).notNull().default(0),
    triggerStarts: jsonb('trigger_starts').$type<Record<string, string>>().notNull().default({}),
    blockedCycles: integer('blocked_cycles').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.installationId] }),
    tenantFk(
      'change_dispatch_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    pgPolicy('change_dispatch_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

/** Opaque subscription routing. Authentication still requires its one candidate's secret. */
export const webhookBindings = pgTable(
  'webhook_bindings',
  {
    id: id(),
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    registrationId: uuid('registration_id').notNull(),
    generation: integer('generation').notNull(),
    releaseDigest: text('release_digest').notNull(),
    sourceAccountId: uuid('source_account_id'),
    state: text('state').notNull().default('pending'),
    subscriptionId: text('subscription_id'),
    route: text('route').notNull(),
    secretName: text('secret_name').notNull(),
    accountHintHash: text('account_hint_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('webhook_bindings_ws_id_uq').on(t.workspaceId, t.id),
    check('webhook_bindings_state_ck', sql`${t.state} in ('pending','active','retired')`),
    check(
      'webhook_bindings_source_ck',
      sql`${t.state}<>'active' or ${t.sourceAccountId} is not null`,
    ),
    uniqueIndex('webhook_bindings_install_route_uq')
      .on(t.workspaceId, t.installationId, t.route)
      .where(sql`${t.state}<>'retired'`),
    uniqueIndex('webhook_bindings_account_uq')
      .on(t.registrationId, t.route, t.accountHintHash)
      .where(sql`${t.state}='active' and ${t.accountHintHash} is not null`),
    index('webhook_bindings_install_idx').on(t.workspaceId, t.installationId),
    index('webhook_bindings_source_idx').on(t.workspaceId, t.sourceAccountId),
    index('webhook_bindings_retention_idx')
      .on(t.updatedAt, t.workspaceId)
      .where(sql`${t.state}='retired'`),
    tenantFk(
      'webhook_bindings_install_fk',
      [t.workspaceId, t.installationId],
      [extensionInstallations.workspaceId, extensionInstallations.id],
    ),
    tenantFk(
      'webhook_bindings_account_fk',
      [t.workspaceId, t.sourceAccountId],
      [sourceAccounts.workspaceId, sourceAccounts.id],
    ),
    pgPolicy('webhook_bindings_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const webhookReceipts = pgTable(
  'webhook_receipts',
  {
    workspaceId: workspaceId(),
    bindingId: uuid('binding_id').notNull(),
    deliveryHash: text('delivery_hash').notNull(),
    bodyDigest: text('body_digest').notNull(),
    sourceItemId: uuid('source_item_id').notNull(),
    jobId: uuid('job_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.bindingId, t.deliveryHash] }),
    tenantFk(
      'webhook_receipts_binding_fk',
      [t.workspaceId, t.bindingId],
      [webhookBindings.workspaceId, webhookBindings.id],
    ),
    tenantFk(
      'webhook_receipts_source_fk',
      [t.workspaceId, t.sourceItemId],
      [sourceItems.workspaceId, sourceItems.id],
    ),
    tenantFk(
      'webhook_receipts_job_fk',
      [t.workspaceId, t.jobId],
      [extensionJobs.workspaceId, extensionJobs.id],
    ),
    index('webhook_receipts_job_idx').on(t.workspaceId, t.jobId),
    index('webhook_receipts_workspace_expiry_idx').on(t.workspaceId, t.createdAt),
    index('webhook_receipts_expiry_idx').on(t.createdAt, t.workspaceId),
    index('webhook_receipts_source_idx').on(t.workspaceId, t.sourceItemId),
    pgPolicy('webhook_receipts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();
export const webhookRequestCounts = pgTable(
  'webhook_request_counts',
  {
    workspaceId: workspaceId(),
    bindingId: uuid('binding_id').notNull(),
    windowStart: timestamptz('window_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.bindingId] }),
    tenantFk(
      'webhook_counts_binding_fk',
      [t.workspaceId, t.bindingId],
      [webhookBindings.workspaceId, webhookBindings.id],
    ),
    pgPolicy('webhook_counts_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
      withCheck: sql`${t.workspaceId}=nullif(current_setting('app.workspace_id',true),'')::uuid`,
    }),
  ],
).enableRLS();

// The newest configure job owns the suggestion slot, even before its first save.
export const extensionSuggestions = pgTable(
  'extension_suggestions',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    releaseDigest: text('release_digest').notNull(),
    jobId: uuid('job_id').notNull(),
    reason: text('reason').notNull(),
    bindings: jsonb('bindings'),
    bindingReasons: jsonb('binding_reasons'),
    settings: jsonb('settings'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.installationId, t.releaseDigest] }),
    foreignKey({
      columns: [t.workspaceId, t.installationId],
      foreignColumns: [extensionInstallations.workspaceId, extensionInstallations.id],
    }).onDelete('cascade'),
    pgPolicy('extension_suggestions_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const extensionBindingProposals = pgTable(
  'extension_binding_proposals',
  {
    workspaceId: workspaceId(),
    releaseDigest: text('release_digest').notNull(),
    choices: jsonb('choices').notNull(),
    proposedBy: jsonb('proposed_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.releaseDigest] }),
    pgPolicy('extension_binding_proposals_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

// A target-release review cannot alter the active release's grant or credentials.
export const extensionAccessApprovals = pgTable(
  'extension_access_approvals',
  {
    workspaceId: workspaceId(),
    installationId: uuid('installation_id').notNull(),
    releaseDigest: text('release_digest').notNull(),
    generation: integer('generation').notNull(),
    settingsRevision: integer('settings_revision').notNull(),
    scopes: jsonb('scopes').notNull(),
    /** The release's uses, granted with its access (model calls spec 3.1). */
    uses: jsonb('uses').$type<string[]>().notNull().default([]),
    actor: text('actor').notNull(),
    secretRefs: jsonb('secret_refs').notNull().default({}),
    settings: jsonb('settings').notNull().default({}),
    approvedBy: jsonb('approved_by').$type<Actor>().notNull(),
    approvedAt: timestamptz('approved_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.installationId, t.releaseDigest] }),
    foreignKey({
      columns: [t.workspaceId, t.installationId],
      foreignColumns: [extensionInstallations.workspaceId, extensionInstallations.id],
    }).onDelete('cascade'),
    pgPolicy('extension_access_approvals_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

/**
 * One row per model request Anthropic answered through the model proxy (model
 * calls spec 3.4). Counts only, never content. Every ID comes from the model
 * token, never from the extension. No foreign key to the installation, so a
 * month's use survives an uninstall and reinstall; rows go with the workspace.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    /** Made by the proxy per request (a UUIDv7); a repeated report is a no-op. */
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').notNull(),
    /** Extension calls: the run that made it. Null for a routine's call. */
    installationId: uuid('installation_id'),
    registrationId: uuid('registration_id'),
    releaseDigest: text('release_digest'),
    functionId: uuid('function_id'),
    jobId: uuid('job_id'),
    attempt: integer('attempt').notNull(),
    /** Routine calls (routines spec §6.3): the routine and the run that made it. */
    routineId: uuid('routine_id'),
    routineRunId: uuid('routine_run_id'),
    /**
     * Workspace agent steps (agent spec §10.3): the session, its turn and the
     * step the runtime reported, and the person a chat works for. A repeated
     * report of one step is a no-op.
     */
    agentSessionId: uuid('agent_session_id'),
    agentTurnId: uuid('agent_turn_id'),
    agentStepId: text('agent_step_id'),
    userId: uuid('user_id'),
    /** The model named in the response, which can differ from the one requested. */
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull(),
    /** The response's whole usage object: counts and short labels a price needs. */
    usage: jsonb('usage').notNull(),
    providerRequestId: text('provider_request_id'),
    /** The stream ended before its final event, so the output count is too low. */
    partial: boolean('partial').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_usage_installation_idx').on(t.workspaceId, t.installationId, t.createdAt),
    index('ai_usage_created_idx').on(t.createdAt),
    check('ai_usage_kind', sql`${t.kind} in ('model', 'agent', 'routine')`),
    check(
      'ai_usage_caller',
      sql`(${t.kind} = 'routine' and ${t.routineRunId} is not null) or (${t.kind} = 'agent' and ${t.agentSessionId} is not null and ${t.agentStepId} is not null) or (${t.kind} = 'model' and ${t.installationId} is not null and ${t.registrationId} is not null and ${t.releaseDigest} is not null and ${t.functionId} is not null and ${t.jobId} is not null)`,
    ),
    uniqueIndex('ai_usage_agent_step_uq')
      .on(t.agentSessionId, t.agentStepId)
      .where(sql`${t.kind} = 'agent'`),
    index('ai_usage_routine_idx').on(t.workspaceId, t.routineId, t.createdAt),
    check(
      'ai_usage_tokens',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`,
    ),
    pgPolicy('ai_usage_workspace', {
      for: 'all',
      to: 'retainer_app',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

/** Provider attempts live independently of usage and can outlast their parent run. */
export const modelCalls = pgTable(
  'model_calls',
  {
    /** Made by the proxy before it calls the provider; shared with `ai_usage.id`. */
    id: uuid('id').notNull().default(sql`uuidv7()`),
    workspaceId: workspaceId(),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    attempt: integer('attempt').notNull(),
    routineId: uuid('routine_id'),
    releaseDigest: text('release_digest'),
    functionId: uuid('function_id'),
    provider: text('provider').notNull(),
    requestedModel: text('requested_model'),
    returnedModel: text('returned_model'),
    providerRequestId: text('provider_request_id'),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    httpStatus: integer('http_status'),
    code: text('code'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('model_calls_retention_idx').on(t.startedAt),
    index('model_calls_owner_idx').on(t.workspaceId, t.ownerKind, t.ownerId, t.startedAt),
    check('model_calls_owner_kind', sql`${t.ownerKind} in ('routine', 'extension')`),
    check(
      'model_calls_outcome',
      sql`${t.outcome} in ('started', 'completed', 'provider_error', 'transport_error', 'stream_interrupted')`,
    ),
    check(
      'model_calls_finish',
      sql`(${t.outcome} = 'started' and ${t.finishedAt} is null and ${t.durationMs} is null)
      or (${t.outcome} <> 'started' and ${t.finishedAt} is not null and ${t.durationMs} >= 0)`,
    ),
    pgPolicy('model_calls_workspace', {
      to: 'retainer_app',
      for: 'all',
      using: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** Optional captured content. The API runtime can insert, but cannot read it. */
export const modelCallPayloads = pgTable(
  'model_call_payloads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    callId: uuid('call_id').notNull(),
    requestBody: bytea('request_body').notNull(),
    responseBody: bytea('response_body').notNull(),
    requestTruncated: boolean('request_truncated').notNull(),
    responseTruncated: boolean('response_truncated').notNull(),
    responsePartial: boolean('response_partial').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.callId] }),
    tenantFk(
      'model_call_payloads_call_fk',
      [t.workspaceId, t.callId],
      [modelCalls.workspaceId, modelCalls.id],
    ),
    index('model_call_payloads_expiry_idx').on(t.expiresAt),
    check(
      'model_call_payloads_size',
      sql`octet_length(${t.requestBody}) <= 32768 and octet_length(${t.responseBody}) <= 32768`,
    ),
    pgPolicy('model_call_payloads_insert', {
      to: 'retainer_app',
      for: 'insert',
      withCheck: sql`${t.workspaceId} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Routines (docs/specs/routines.md §6.6). Not records: they are not in views
// or the change feed. Run history copies no CRM content outside
// `routine_run_results`, whose results `forget` clears.
// ---------------------------------------------------------------------------

const tenantPolicy = (name: string, column: AnyPgColumn) =>
  pgPolicy(name, {
    for: 'all',
    to: 'retainer_app',
    using: sql`${column} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
    withCheck: sql`${column} = nullif(current_setting('app.workspace_id', true), '')::uuid`,
  });

/** A routine's manifest and code, stored once by hash; versions and dry runs point at it. */
export const routineSources = pgTable(
  'routine_sources',
  {
    id: id(),
    workspaceId: workspaceId(),
    hash: text('hash').notNull(),
    /** Canonical: objects by universal ID, fields by key. */
    manifest: jsonb('manifest').notNull(),
    code: text('code').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('routine_sources_ws_id_uq').on(t.workspaceId, t.id),
    unique('routine_sources_hash_uq').on(t.workspaceId, t.hash),
    check('routine_sources_hash', sql`${t.hash} ~ '^[a-f0-9]{64}$'`),
    check('routine_sources_code_size', sql`octet_length(${t.code}) <= 65536`),
    tenantPolicy('routine_sources_workspace', t.workspaceId),
  ],
).enableRLS();

export const routines = pgTable(
  'routines',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** The person's plain-language text: the lasting record of intent (§5.3). */
    description: text('description').notNull(),
    stateChangedBy: jsonb('state_changed_by').$type<Actor>(),
    status: text('status').notNull().default('draft'),
    /** Why it paused, as a code: `paused`, `check_failed`, `tool_changed`, `failing`, `approver_left`, `runs_held`, `schedule_over_limit`, `schedule_too_large`. */
    pausedReason: text('paused_reason'),
    pausedAt: timestamptz('paused_at'),
    activeVersionId: uuid('active_version_id'),
    /** The change feed position this routine has matched up to (§6.1). */
    feedPosition: bigint('feed_position', { mode: 'number' }),
    /** The next schedule occurrence, for `schedule` triggers. */
    nextFireAt: timestamptz('next_fire_at'),
    /** Failed runs in a row; repeated failures pause the routine. */
    failures: integer('failures').notNull().default(0),
    createdBy: jsonb('created_by').$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('routines_ws_id_uq').on(t.workspaceId, t.id),
    index('routines_status_idx').on(t.workspaceId, t.status),
    index('routines_schedule_idx')
      .on(t.nextFireAt)
      .where(sql`${t.status} = 'active' and ${t.nextFireAt} is not null`),
    check(
      'routines_status',
      sql`${t.status} in ('draft', 'active', 'paused', 'needs_attention', 'archived')`,
    ),
    check('routines_name_length', sql`char_length(${t.name}) between 1 and 200`),
    check('routines_description_length', sql`char_length(${t.description}) between 1 and 10000`),
    tenantPolicy('routines_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * A proposal and, once an admin approves it, a version (§5.3). Approval
 * creates a new version each time; editing proposes a new one.
 */
export const routineVersions = pgTable(
  'routine_versions',
  {
    id: id(),
    workspaceId: workspaceId(),
    routineId: uuid('routine_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** Counts the routine's versions, from 1. */
    number: integer('number').notNull(),
    state: text('state').notNull().default('proposed'),
    /** The name and intent reviewed with this version. Older versions may lack both. */
    name: text('name'),
    description: text('description'),
    /** The builder's one-sentence summary; Retainer does not vouch for it. */
    summary: text('summary').notNull(),
    /** The builder's verdict and gaps (§5.2). */
    report: jsonb('report').notNull(),
    /** Only `agent` in the first version (§6.4). */
    rank: text('rank').notNull().default('agent'),
    /** The SDK types it was last checked against (§5.3). */
    typesFingerprint: text('types_fingerprint').notNull(),
    /** Each listed tool's contract when it was checked: a change pauses the routine. */
    toolContracts: jsonb('tool_contracts').notNull().default({}),
    builtBy: jsonb('built_by').$type<Actor>().notNull(),
    rejectedBy: jsonb('rejected_by').$type<Actor>(),
    approvedBy: jsonb('approved_by').$type<Actor>(),
    /** The approver's user ID, so their leaving or losing the admin role pauses it. */
    approverUserId: text('approver_user_id'),
    approvedAt: timestamptz('approved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('routine_versions_ws_id_uq').on(t.workspaceId, t.id),
    unique('routine_versions_number_uq').on(t.routineId, t.number),
    tenantFk(
      'routine_versions_routine_fk',
      [t.workspaceId, t.routineId],
      [routines.workspaceId, routines.id],
    ),
    tenantFk(
      'routine_versions_source_fk',
      [t.workspaceId, t.sourceId],
      [routineSources.workspaceId, routineSources.id],
    ),
    index('routine_versions_source_idx').on(t.workspaceId, t.sourceId),
    check(
      'routine_versions_state',
      sql`${t.state} in ('proposed', 'approved', 'superseded', 'rejected')`,
    ),
    check('routine_versions_rank', sql`${t.rank} = 'agent'`),
    tenantPolicy('routine_versions_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * One execution of a routine's code, and the sandbox jobs around it: a type
 * check, a dry run, a test run or the built-in builder (§5.1, §6.2). This is
 * also the runs' queue: a lease, a fence and attempts, as extension jobs have.
 */
export const routineRuns = pgTable(
  'routine_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    routineId: uuid('routine_id'),
    /** The version a run is pinned to; null for checks, dry runs and builds before a proposal. */
    versionId: uuid('version_id'),
    sourceId: uuid('source_id'),
    mode: text('mode').notNull(),
    /** `record`, `schedule`, `manual`, `test` or `preview`. */
    triggerKind: text('trigger_kind').notNull(),
    recordId: uuid('record_id'),
    /** Groups the dry runs of one preview. */
    previewId: uuid('preview_id'),
    /** Build input (the description), never record content. */
    input: jsonb('input'),
    /** A check's problems or a build's proposal ID: no record content. */
    output: jsonb('output'),
    status: text('status').notNull().default('queued'),
    code: text('code'),
    leaseOwner: text('lease_owner'),
    fence: bigint('fence', { mode: 'number' }).notNull().default(0),
    leaseUntil: timestamptz('lease_until'),
    attempt: integer('attempt').notNull().default(0),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    /** When the run counts as happening (`run.at`). */
    runAt: timestamptz('run_at').notNull().defaultNow(),
    /** Set when it starts: 24 hours later, or earlier from the manifest's expiry field. */
    expiresAt: timestamptz('expires_at'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    /** The change the run reacts to, for coalescing and history. */
    changePosition: bigint('change_position', { mode: 'number' }),
    cause: jsonb('cause').$type<string[]>().notNull().default([]),
    causeDepth: integer('cause_depth').notNull().default(0),
    /** Who started a manual run, test, dry run or build. */
    initiatedBy: jsonb('initiated_by').$type<Actor>(),
    /** The person behind it, re-checked before each effect of a test and for member tools. */
    initiatorUserId: text('initiator_user_id'),
    /** Model calls this run reserved (§6.3). */
    modelCalls: integer('model_calls').notNull().default(0),
    /** Reads this attempt made, by operation, against the per-operation cap (§4.6). */
    readCalls: jsonb('read_calls').$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('routine_runs_ws_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'routine_runs_routine_fk',
      [t.workspaceId, t.routineId],
      [routines.workspaceId, routines.id],
    ),
    tenantFk(
      'routine_runs_version_fk',
      [t.workspaceId, t.versionId],
      [routineVersions.workspaceId, routineVersions.id],
    ),
    tenantFk(
      'routine_runs_source_fk',
      [t.workspaceId, t.sourceId],
      [routineSources.workspaceId, routineSources.id],
    ),
    index('routine_runs_routine_idx').on(t.workspaceId, t.routineId, t.createdAt),
    index('routine_runs_due_idx')
      .on(t.availableAt)
      .where(sql`${t.status} in ('queued', 'running')`),
    index('routine_runs_record_idx')
      .on(t.routineId, t.recordId)
      .where(sql`${t.status} in ('queued', 'held', 'running', 'waiting')`),
    index('routine_runs_preview_idx').on(t.workspaceId, t.previewId),
    index('routine_runs_version_idx').on(t.workspaceId, t.versionId),
    index('routine_runs_source_idx').on(t.workspaceId, t.sourceId),
    index('routine_runs_retention_idx').on(t.finishedAt).where(sql`${t.finishedAt} is not null`),
    // One run at a time per routine and record (§6.2); a run waiting on an
    // agent task holds its place (agent spec §9.2).
    uniqueIndex('routine_runs_one_running_uq')
      .on(t.routineId, t.recordId)
      .where(
        sql`${t.status} in ('running', 'waiting') and ${t.mode} = 'run' and ${t.recordId} is not null`,
      ),
    index('routine_runs_waiting_idx').on(t.expiresAt).where(sql`${t.status} = 'waiting'`),
    check('routine_runs_mode', sql`${t.mode} in ('run', 'test', 'dry', 'check', 'build')`),
    check(
      'routine_runs_status',
      sql`${t.status} in ('queued', 'held', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'expired', 'stopped', 'diverged', 'budget_exhausted', 'erased', 'discarded')`,
    ),
    check(
      'routine_runs_trigger_kind',
      sql`${t.triggerKind} in ('record', 'schedule', 'manual', 'test', 'preview', 'check', 'build')`,
    ),
    check(
      'routine_runs_pinned',
      sql`${t.mode} not in ('run', 'test') or (${t.routineId} is not null and ${t.sourceId} is not null)`,
    ),
    tenantPolicy('routine_runs_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * Each effect of a run, by position (§6.2): a retry gets the recorded result
 * instead of repeating the effect. `result` may hold copied content; it is
 * cleared 7 days after the run ends and by `forget` (§6.6).
 */
export const routineRunResults = pgTable(
  'routine_run_results',
  {
    workspaceId: workspaceId(),
    runId: uuid('run_id').notNull(),
    position: integer('position').notNull(),
    operation: text('operation').notNull(),
    argsHash: text('args_hash').notNull(),
    /** `started`, `done`, `failed` or `reported` (a dry or test run's call). */
    state: text('state').notNull(),
    result: jsonb('result'),
    /** A failed effect's error code, or what a tool call reported. */
    code: text('code'),
    /** A retry found this position with different arguments (§6.2). */
    differs: boolean('differs').notNull().default(false),
    /** The tool job a `tool` effect started. */
    toolJobId: uuid('tool_job_id'),
    /** The agent task an `ai.agent` effect started (agent spec §9.2). */
    agentTaskId: uuid('agent_task_id'),
    /** An answered `ai.agent` effect the resumed run reached (agent spec §9.2). */
    delivered: boolean('delivered').notNull().default(false),
    /** The record a write wrote. */
    recordId: uuid('record_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.position] }),
    tenantFk(
      'routine_run_results_run_fk',
      [t.workspaceId, t.runId],
      [routineRuns.workspaceId, routineRuns.id],
    ),
    index('routine_run_results_workspace_idx').on(t.workspaceId),
    check(
      'routine_run_results_state',
      sql`${t.state} in ('started', 'done', 'failed', 'reported')`,
    ),
    tenantPolicy('routine_run_results_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * What a routine already did, so it does not do it again (§4.2, §6.1): a
 * `once` mark per record for `oncePerRecord` routines, and each schedule
 * tick it fired.
 */
export const routineFirings = pgTable(
  'routine_firings',
  {
    workspaceId: workspaceId(),
    routineId: uuid('routine_id').notNull(),
    kind: text('kind').notNull(),
    /** The record; the nil UUID for a schedule tick with no record. */
    recordId: uuid('record_id').notNull(),
    /** A schedule tick's time; the epoch for `once` marks. */
    dueAt: timestamptz('due_at').notNull(),
    runId: uuid('run_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.routineId, t.kind, t.recordId, t.dueAt] }),
    tenantFk(
      'routine_firings_routine_fk',
      [t.workspaceId, t.routineId],
      [routines.workspaceId, routines.id],
    ),
    index('routine_firings_record_idx').on(t.workspaceId, t.recordId),
    check('routine_firings_kind', sql`${t.kind} in ('once', 'schedule')`),
    tenantPolicy('routine_firings_workspace', t.workspaceId),
  ],
).enableRLS();

/** Routine model calls reserved per workspace and UTC day (§6.3). */
export const routineModelDays = pgTable(
  'routine_model_days',
  {
    workspaceId: workspaceId(),
    day: date('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.day] }),
    check('routine_model_days_count', sql`${t.count} >= 0`),
    tenantPolicy('routine_model_days_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * A workspace agent session (agent spec §5.1): a chat a person opens, or
 * later a task code hands the agent. Its tools and system blocks are pinned
 * when it is created (§3.5, §8.3); its history lives in Mastra's tables in
 * the `mastra` schema, keyed by this ID.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text('kind').notNull(),
    /** Who the session belongs to: `user:<id>` for a person, `key:<actor id>` in key mode. */
    owner: text('owner').notNull(),
    /** The person a chat works for, whose `me` memory it reaches. Null in key mode. */
    personId: uuid('person_id'),
    title: text('title').notNull().default(''),
    status: text('status').notNull().default('open'),
    /** The pinned tool definitions, in order, as the runtime builds them. */
    tools: jsonb('tools').notNull(),
    /** Pinned extension tool names to the installation and tool they call. */
    extensionTools: jsonb('extension_tools')
      .$type<Record<string, { registrationId: string; tool: string }>>()
      .notNull()
      .default({}),
    /** The system prompt blocks, pinned so the prompt cache and thinking stay valid. */
    systemBlocks: jsonb('system_blocks').$type<string[]>().notNull(),
    /** The workspace date (YYYY-MM-DD) the last turn told the agent. */
    lastDate: text('last_date'),
    /** The claim generation: each claim takes the next one (§6.3). */
    generation: integer('generation').notNull().default(0),
    limits: jsonb('limits').$type<Record<string, number>>().notNull(),
    createdAt: createdAt(),
    lastActiveAt: timestamptz('last_active_at').notNull().defaultNow(),
  },
  (t) => [
    unique('agent_sessions_ws_id_uq').on(t.workspaceId, t.id),
    index('agent_sessions_owner_idx').on(t.workspaceId, t.owner, t.lastActiveAt),
    check('agent_sessions_kind', sql`${t.kind} in ('chat', 'task')`),
    check('agent_sessions_status', sql`${t.status} in ('open', 'deleted')`),
    tenantPolicy('agent_sessions_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * One claimed turn of a session (§6.3): its lease, its credential's hash and
 * what it used. IDs and counts only, never content.
 */
export const agentTurns = pgTable(
  'agent_turns',
  {
    id: id(),
    workspaceId: workspaceId(),
    sessionId: uuid('session_id').notNull(),
    generation: integer('generation').notNull(),
    status: text('status').notNull().default('running'),
    /** The Mastra run ID the claim issued, so the erasure can find the run's rows. */
    runId: uuid('run_id').notNull(),
    /**
     * The ID the claim issued for the person's message, which the runtime saves it
     * under (§6.2), so the chat read can place this turn's ending after its messages.
     */
    messageId: uuid('message_id'),
    /** SHA-256 of the turn token's secret. */
    tokenHash: text('token_hash').notNull(),
    /** The credential that minted the turn, re-checked on every call (§7.3). */
    access: jsonb('access').notNull(),
    claimedAt: timestamptz('claimed_at').notNull().defaultNow(),
    deadline: timestamptz('deadline').notNull(),
    /** The runtime closed its side: it saves nothing more (§6.3). */
    stoppedAt: timestamptz('stopped_at'),
    finishedAt: timestamptz('finished_at'),
    /** The hosted writer lease the claim took for the agent function's build (§10.2). */
    leaseId: uuid('lease_id'),
    leaseBuild: text('lease_build'),
    steps: integer('steps').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    webSearches: integer('web_searches').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    unique('agent_turns_ws_id_uq').on(t.workspaceId, t.id),
    unique('agent_turns_generation_uq').on(t.sessionId, t.generation),
    tenantFk(
      'agent_turns_session_fk',
      [t.workspaceId, t.sessionId],
      [agentSessions.workspaceId, agentSessions.id],
    ),
    index('agent_turns_workspace_idx').on(t.workspaceId),
    index('agent_turns_run_idx').on(t.runId),
    index('agent_turns_open_idx')
      .on(t.deadline)
      .where(sql`${t.status} = 'running' or ${t.stoppedAt} is null`),
    check(
      'agent_turns_status',
      sql`${t.status} in ('running', 'completed', 'refused', 'incomplete', 'context_limit_reached', 'model_unavailable', 'history_rejected', 'limit_reached', 'cancelled', 'timed_out', 'failed')`,
    ),
    tenantPolicy('agent_turns_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * A client's credential for a chat's stream (§7.3): it can start a turn on
 * one chat and nothing else. Only its hash is kept; it lasts 15 minutes.
 */
export const agentStreamTokens = pgTable(
  'agent_stream_tokens',
  {
    id: id(),
    workspaceId: workspaceId(),
    sessionId: uuid('session_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** The credential it was minted from (a person's session, the CLI login or a key). */
    access: jsonb('access').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk(
      'agent_stream_tokens_session_fk',
      [t.workspaceId, t.sessionId],
      [agentSessions.workspaceId, agentSessions.id],
    ),
    index('agent_stream_tokens_session_idx').on(t.workspaceId, t.sessionId),
    index('agent_stream_tokens_expiry_idx').on(t.expiresAt),
    tenantPolicy('agent_stream_tokens_workspace', t.workspaceId),
  ],
).enableRLS();

/** Agent steps per UTC day, for the workspace (`workspace`) and each owner (§10.1). */
export const agentDays = pgTable(
  'agent_days',
  {
    workspaceId: workspaceId(),
    day: date('day').notNull(),
    subject: text('subject').notNull(),
    steps: integer('steps').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.day, t.subject] }),
    check('agent_days_steps', sql`${t.steps} >= 0`),
    tenantPolicy('agent_days_workspace', t.workspaceId),
  ],
).enableRLS();

/**
 * An agent task (agent spec §9): the job side of a `task` session. Code
 * hands the agent instructions (pinned as the session's second system
 * block), input and an answer shape; its caller waits, parked, for the
 * answer. The table is also the tasks' queue: one job per delivery, a job
 * token's hash, attempts. `input` and `answer` may hold CRM content: the
 * input goes once the task ends, the answer once it reaches its caller.
 */
export const agentTasks = pgTable(
  'agent_tasks',
  {
    sessionId: uuid('session_id').primaryKey(),
    workspaceId: workspaceId(),
    /** Idempotency: `routine:<run>:<position>`, or `extension:<job>`. */
    taskKey: text('task_key').notNull(),
    callerKind: text('caller_kind').notNull(),
    /** A routine caller: the run that waits, its routine and the effect's position. */
    routineRunId: uuid('routine_run_id'),
    routineId: uuid('routine_id'),
    position: integer('position'),
    /** An extension caller: the invocation's job, and its installation. */
    extensionJobId: uuid('extension_job_id'),
    installationId: uuid('installation_id'),
    /** The caller's mode: `run` and `test` write; `dry` reports writes and calls no tool. */
    mode: text('mode').notNull(),
    /** `staged` (an extension's, until its invocation waits), `queued`, `running`, `completed`, `failed`, `cancelled`. */
    state: text('state').notNull(),
    /** The tool groups granted (§9.4), as the caller asked for them. */
    toolGroups: jsonb('tool_groups').$type<string[]>().notNull(),
    outputSchema: jsonb('output_schema').notNull(),
    input: jsonb('input'),
    answer: jsonb('answer'),
    code: text('code'),
    /** The parent's cause chain and hops, which the task's writes and tool jobs keep (§7.2). */
    cause: jsonb('cause').$type<string[]>().notNull().default([]),
    causeDepth: integer('cause_depth').notNull().default(0),
    /** Deliveries of the task's job (§9.3); the queue's retry limit bounds them. */
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    /** Before the parent's expiry, less a margin: no answer arrives for a run already gone (§9.2). */
    expiresAt: timestamptz('expires_at').notNull(),
    /** SHA-256 of the current delivery's job token, which the runtime trades for a turn. */
    jobTokenHash: text('job_token_hash'),
    /** When the current delivery may be handed out again if its runtime never claimed or closed. */
    leaseUntil: timestamptz('lease_until'),
    /** The schema repair turn was used (§9.3). */
    repaired: boolean('repaired').notNull().default(false),
    createdAt: createdAt(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    unique('agent_tasks_ws_session_uq').on(t.workspaceId, t.sessionId),
    unique('agent_tasks_key_uq').on(t.workspaceId, t.taskKey),
    foreignKey({
      name: 'agent_tasks_session_fk',
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [agentSessions.workspaceId, agentSessions.id],
    }).onDelete('cascade'),
    index('agent_tasks_due_idx').on(t.availableAt).where(sql`${t.state} in ('queued', 'running')`),
    index('agent_tasks_run_idx').on(t.workspaceId, t.routineRunId),
    index('agent_tasks_job_idx').on(t.workspaceId, t.extensionJobId),
    check('agent_tasks_caller_kind', sql`${t.callerKind} in ('routine', 'extension')`),
    check(
      'agent_tasks_caller',
      sql`(${t.callerKind} = 'routine' and ${t.routineRunId} is not null and ${t.position} is not null) or (${t.callerKind} = 'extension' and ${t.extensionJobId} is not null and ${t.installationId} is not null)`,
    ),
    check('agent_tasks_mode', sql`${t.mode} in ('run', 'test', 'dry')`),
    check(
      'agent_tasks_state',
      sql`${t.state} in ('staged', 'queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    tenantPolicy('agent_tasks_workspace', t.workspaceId),
  ],
).enableRLS();
