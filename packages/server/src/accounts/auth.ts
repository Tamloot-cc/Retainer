import { AsyncLocalStorage } from 'node:async_hooks';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import { OAUTH_SCOPES } from '@retainer/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { jwt } from 'better-auth/plugins/jwt';
import type { GoogleOptions } from 'better-auth/social-providers';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ACCOUNT_COOKIE_PREFIX } from '../auth/account-session.js';
import { AUTH_BASE_PATH, oauthSettings, WORKSPACE_CLAIM } from '../auth/oauth-token.js';
import { type AccountsConfig, type SignInProvider, signInProviders } from '../config.js';
import type { Sql } from '../db/client.js';
import { isUuid } from '../db/ids.js';
import {
  authAccounts,
  authRateLimits,
  authVerifications,
  jwks,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  passkeys,
  sessions,
  users,
} from '../db/schema.js';
import { microsoftAccountKey, microsoftProvider } from './microsoft.js';

/**
 * Better Auth (accounts spec A2, 4.4, 4.11, 4.12). Only this module imports
 * it, and only the code that serves /account loads this module: the API
 * never does (`pnpm lint` checks it).
 *
 * People sign in with Google or Microsoft, or with a passkey they added after
 * a first sign-in with one of them. There are no passwords and no email
 * sign-in.
 *
 * A person is the provider account they first signed in with, matched by the
 * provider's own ID, never by email. A second provider joins the same person
 * only when it verified the person's email address (`accountLinking` below),
 * so an address a provider never verified can neither create a person nor
 * reach someone else's account or invitations.
 */

/**
 * The header the client's address arrives in, set by Retainer's own entry
 * code from the connection or API Gateway's source IP, never by the client
 * (routes.ts strips any it sends). Better Auth keys sign-in rate limits on it.
 */
export const CLIENT_IP_HEADER = 'x-retainer-client-ip';

export const SESSION_DAYS = 30;

/** Better Auth's models, mapped onto Retainer's tables (db/schema.ts). */
const MODELS = {
  users,
  sessions,
  auth_accounts: authAccounts,
  auth_verifications: authVerifications,
  passkeys,
  auth_rate_limits: authRateLimits,
  jwks,
  oauth_clients: oauthClients,
  oauth_resources: oauthResources,
  oauth_client_resources: oauthClientResources,
  oauth_refresh_tokens: oauthRefreshTokens,
  oauth_access_tokens: oauthAccessTokens,
  oauth_consents: oauthConsents,
  oauth_client_assertions: oauthClientAssertions,
};

/** Where the web app's OAuth pages are (accounts spec 4.7, 5). */
export const OAUTH_SIGN_IN_PAGE = '/app/oauth/sign-in';
export const OAUTH_CONSENT_PAGE = '/app/oauth/consent';

/**
 * The workspace the person picked on the consent page, for the one request
 * that records their consent (`Auth.consent`). Better Auth asks for the
 * consent's reference with only the person and their session, so the choice
 * travels with the request rather than being stored on the session, where
 * two consents in two tabs would race.
 */
const pickedWorkspace = new AsyncLocalStorage<string>();

/**
 * Matches no workspace. Outside a consent request, Better Auth looks up an
 * existing consent with this reference and finds none, so every
 * authorization goes through the consent page and its picker.
 */
const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';

/** Tests stand in for Google here; production uses Google's own checks. */
export type GoogleOverrides = Pick<GoogleOptions, 'verifyIdToken' | 'getUserInfo'>;

export type AuthOptions = {
  /** A connection as the control role. */
  sql: Sql;
  config: AccountsConfig;
  /** Where people reach Retainer, e.g. https://retainer.example. */
  publicOrigin: string;
  google?: GoogleOverrides;
  /** Tests run a local fake of Microsoft's sign-in service here. */
  microsoftAuthority?: string;
  /** Off only in tests, which sign in many times from one address. */
  rateLimit?: boolean;
  /**
   * Fetches client metadata documents. Production resolves the host once,
   * refuses private addresses and pins the address (@better-auth/cimd/node);
   * tests, which have no internet, serve documents themselves.
   */
  fetchClientMetadata?: typeof fetchClientMetadataResource;
};

/** A signed-in person, as Better Auth reads their session. */
export type AccountSession = {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    disabledAt?: Date | null | undefined;
  };
  session: { id: string; expiresAt: Date };
};

/** What the rest of `accounts` uses of Better Auth. */
export type Auth = {
  /** Better Auth's own routes, under /account/auth. */
  handler: (request: Request) => Promise<Response>;
  /** The session a request's cookie carries, or null. Writes nothing. */
  getSession: (headers: Headers) => Promise<AccountSession | null>;
  /**
   * Records the person's consent to an app for one workspace, and returns
   * Better Auth's answer: where to send the browser next. The caller has
   * checked that the person can reach the workspace.
   */
  consent: (request: Request, workspaceId: string) => Promise<Response>;
  /** RFC 8414 metadata for the authorization server. */
  authServerMetadata: (request: Request) => Promise<Response>;
  /** The providers people can sign in with here, for the sign-in page. */
  providers: SignInProvider[];
};

export function createAuth(options: AuthOptions): Auth {
  const auth = betterAuthFor(options);
  return {
    handler: (request) => handle(auth, request),
    getSession: async (headers) => {
      const found = await auth.api.getSession({ headers });
      return found ? { user: found.user, session: found.session } : null;
    },
    consent: (request, workspaceId) =>
      pickedWorkspace.run(workspaceId, () => auth.handler(request)),
    authServerMetadata: oauthProviderAuthServerMetadata(auth),
    providers: signInProviders(options.config),
  };
}

/** Where a page signs in with Google, with an ID token or by starting the redirect. */
const SOCIAL_SIGN_IN = `${AUTH_BASE_PATH}/sign-in/social`;

/**
 * Better Auth's answers when creating a person, or linking a provider account
 * to one, fails. The hooks below refuse with codes of their own, so these
 * mean the database refused the new row.
 */
const LOST_RACE = new Set(['unable to create user', 'unable to link account']);

/**
 * Two first sign-ins for one Google or Microsoft account at the same moment
 * (a double click, two tabs) both find no person and both create one, or both
 * link the account to the person with its address. The database keeps one,
 * and Better Auth answers the other "unable to create user" or "unable to
 * link account" (accounts spec 9.2). A sign-in with an ID token runs again:
 * the next run finds what the other made and signs in as that person. A sign-in through the provider's redirect cannot, because its code
 * works only once; its tab returns to the sign-in page with the error, and
 * the page says the account is ready and to sign in again.
 */
async function handle(auth: ReturnType<typeof betterAuthFor>, request: Request) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== SOCIAL_SIGN_IN) return auth.handler(request);
  // Each lost race means another sign-in committed a step: making the person,
  // then linking their account. Two retries cover both.
  let attempt = request;
  for (let retries = MAX_RETRIES; ; retries--) {
    const again = retries > 0 ? attempt.clone() : null;
    const response = await auth.handler(attempt);
    if (!again || response.status !== 401) return response;
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { message?: string } | null;
    if (!body?.message || !LOST_RACE.has(body.message)) return response;
    attempt = again;
  }
}

const MAX_RETRIES = 2;

function betterAuthFor(options: AuthOptions) {
  const { config, publicOrigin, sql } = options;
  const origin = new URL(publicOrigin);
  const oauth = oauthSettings(publicOrigin);
  return betterAuth({
    appName: 'Retainer',
    baseURL: publicOrigin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    trustedOrigins: [origin.origin],
    // Better Auth's multi-step writes, such as a new person and their Google
    // link, commit together: a sign-in in between would otherwise find the
    // person without the link and be refused.
    database: drizzleAdapter(drizzle(sql), { provider: 'pg', schema: MODELS, transaction: true }),
    user: {
      modelName: 'users',
      additionalFields: {
        disabledAt: { type: 'date', required: false, input: false },
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      // Reading a session writes nothing; the web app refreshes it with a
      // POST when it loads (4.4).
      deferSessionRefresh: true,
      // A cached cookie would keep a revoked session alive until it expires.
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_accounts',
      accountLinking: {
        // A sign-in whose account no one has yet, with the address of an
        // existing person, joins that person only if the provider verified
        // the address (Microsoft: microsoft.ts) and the person's address is
        // verified too. No provider is trusted without that. Otherwise it is
        // refused as `account_not_linked`; a separate person cannot be made,
        // since that address must keep leading to the one it belongs to.
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        // The person keeps the name and address they started with.
        updateUserInfoOnLink: false,
      },
    },
    verification: { modelName: 'auth_verifications' },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.google
        ? {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
              prompt: 'select_account',
              ...options.google,
            },
          }
        : {}),
      ...(config.microsoft
        ? { microsoft: microsoftProvider(config.microsoft, options.microsoftAuthority) }
        : {}),
    },
    rateLimit: {
      enabled: options.rateLimit ?? true,
      // Counted in Postgres, so every function instance shares the limit.
      storage: 'database',
      modelName: 'auth_rate_limits',
    },
    advanced: {
      cookiePrefix: ACCOUNT_COOKIE_PREFIX,
      database: { generateId: 'uuid' },
      // Strict on the session cookie alone: Google's callback is a redirect
      // from another site, so the OAuth state cookie stays Lax (4.6).
      cookies: { session_token: { attributes: { sameSite: 'strict' } } },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    databaseHooks: {
      user: {
        create: {
          // Invitations compare against the address, so it must be one the
          // provider verified. Addresses are kept lowercase.
          before: async (user) => {
            if (!user.emailVerified) {
              throw new APIError('UNAUTHORIZED', {
                code: 'email_not_verified',
                message: 'The account you signed in with has not verified this email address.',
              });
            }
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
        },
      },
      account: {
        create: {
          // One Google and one Microsoft account per person, as the database
          // also requires: another account from the same provider with the
          // person's address is refused, not merged in. Read through the
          // adapter, which joins a transaction the account is created in.
          before: async (account, ctx) => {
            const existing = ctx
              ? await ctx.context.internalAdapter.findAccounts(account.userId)
              : await sql<{ providerId: string }[]>`
                  select provider_id as "providerId" from auth_accounts
                  where user_id = ${account.userId}`;
            if (existing.some((other) => other.providerId === account.providerId)) {
              throw new APIError('UNAUTHORIZED', {
                code: 'account_not_linked',
                message: 'This email address already belongs to a person who signs in another way.',
              });
            }
            return { data: account };
          },
        },
      },
      session: {
        create: {
          // Read through Better Auth's adapter, which joins the transaction a
          // session may be created in (a passkey registration's). A query on
          // the pool itself would wait for that transaction's connection.
          before: async (session, ctx) => {
            const disabled = ctx
              ? Boolean(
                  (
                    (await ctx.context.internalAdapter.findUserById(session.userId)) as {
                      disabledAt?: Date | null;
                    } | null
                  )?.disabledAt,
                )
              : (
                  await sql<{ disabled: boolean }[]>`
                    select disabled_at is not null as disabled from users where id = ${session.userId}`
                )[0]?.disabled;
            if (disabled) return false;
            return { data: session };
          },
        },
      },
    },
    plugins: [
      microsoftAccountKey(),
      passkey({
        // Passkeys belong to one domain forever (4.11): the public origin's.
        rpID: origin.hostname,
        rpName: 'Retainer',
        origin: origin.origin,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        schema: { passkey: { modelName: 'passkeys' } },
      }),
      // Signs MCP access tokens: EdDSA keys, stored with the private half
      // encrypted. The API verifies with the public half (4.7).
      jwt({
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        // Sessions are cookies; no JWT goes out with them.
        disableSettingJwtHeader: true,
        schema: { jwks: { modelName: 'jwks' } },
      }),
      mcp({
        resource: oauth.resource,
        loginPage: OAUTH_SIGN_IN_PAGE,
        consentPage: OAUTH_CONSENT_PAGE,
        // What an agent's key can have, never admin; offline_access gets a
        // refresh token. The person's role caps them on every request.
        scopes: [...OAUTH_SCOPES, 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 60 * 60,
        // Clients without a metadata document register themselves, rate
        // limited; native clients may use loopback redirects.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: 'infer',
        postLogin: {
          // Never redirects: the workspace is picked on the consent page.
          page: OAUTH_CONSENT_PAGE,
          shouldRedirect: () => false,
          consentReferenceId: () => pickedWorkspace.getStore() ?? NO_WORKSPACE,
        },
        customAccessTokenClaims: ({ referenceId }) => {
          // Every grant names a workspace; refuse to sign one that does not.
          if (!referenceId || !isUuid(referenceId) || referenceId === NO_WORKSPACE) {
            throw new Error('refusing to issue an access token without a workspace');
          }
          return { [WORKSPACE_CLAIM]: referenceId };
        },
        schema: {
          oauthClient: { modelName: 'oauth_clients' },
          oauthResource: { modelName: 'oauth_resources' },
          oauthClientResource: { modelName: 'oauth_client_resources' },
          oauthRefreshToken: { modelName: 'oauth_refresh_tokens' },
          oauthAccessToken: { modelName: 'oauth_access_tokens' },
          oauthConsent: { modelName: 'oauth_consents' },
          oauthClientAssertion: { modelName: 'oauth_client_assertions' },
        },
      }),
      // Claude identifies itself with a client metadata document, fetched
      // from the internet: only the control function has a route out (4.6).
      cimd({
        fetchClientMetadataResource: options.fetchClientMetadata ?? fetchClientMetadataResource,
      }),
    ],
  });
}
