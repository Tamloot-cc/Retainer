import type {
  Actor,
  CoreRole,
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
  (t) => [index('oauth_clients_user_idx').on(t.userId)],
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
    /** Set when a template (including `blank`) is first applied. */
    initializedAt: timestamp('initialized_at', { withTimezone: true }),
    /**
     * Digest of the built-in definitions (base, protection, applied templates)
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
    settings: jsonb('settings').notNull().default({}),
    settingsRevision: integer('settings_revision').notNull().default(1),
    /**
     * The approved output mapping (extensions/mapping.ts): each bound output's
     * target by universal ID. Changed only through a reviewed plan.
     */
    mapping: jsonb('mapping').notNull().default({ outputs: {} }),
    mappingRevision: integer('mapping_revision').notNull().default(0),
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
      sql`${t.state} in ('installing', 'active', 'setup_failed', 'disabled', 'upgrading', 'uninstalling', 'uninstalled')`,
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
    workspaceId: workspaceId(),
    kind: text('kind').notNull(),
    credentialId: uuid('credential_id'),
  },
  (t) => [
    unique('oauth_grant_references_ws_id_uq').on(t.workspaceId, t.id),
    tenantFk(
      'oauth_grant_references_credential_fk',
      [t.workspaceId, t.credentialId],
      [extensionCredentials.workspaceId, extensionCredentials.id],
    ),
    index('oauth_grant_references_credential_idx').on(t.workspaceId, t.credentialId),
    check(
      'oauth_grant_references_kind',
      sql`(${t.kind}='person' and ${t.id}=${t.workspaceId} and ${t.credentialId} is null)
      or (${t.kind}='installation' and ${t.credentialId} is not null and ${t.id}=${t.credentialId})`,
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
    lastClaimedAt: timestamptz('last_claimed_at'),
    createdAt: createdAt(),
    connectedAt: timestamptz('connected_at'),
    disconnectedAt: timestamptz('disconnected_at'),
  },
  (t) => [
    unique('extension_connections_scope_uq').on(t.workspaceId, t.installationId, t.id),
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
    uniqueIndex('extension_jobs_one_running_uq')
      .on(t.workspaceId, t.installationId)
      .where(sql`${t.status} = 'running' and ${t.connectionId} is null`),
    uniqueIndex('extension_jobs_one_running_connection_uq')
      .on(t.workspaceId, t.installationId, t.connectionId)
      .where(sql`${t.status} = 'running' and ${t.connectionId} is not null`),
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
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
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
export const sourceReceipts = pgTable(
  'source_receipts',
  {
    workspaceId: workspaceId(),
    itemId: uuid('item_id').notNull(),
    key: text('key').notNull(),
    contentDigest: text('content_digest').notNull(),
    response: jsonb('response').notNull(),
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
