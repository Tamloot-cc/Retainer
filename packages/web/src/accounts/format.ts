import {
  KEY_ACCESS,
  type KeyAccess,
  keyAccessOf,
  ORGANIZATION_ROLE_DESCRIPTIONS,
  ORGANIZATION_ROLES,
  type OrganizationRole,
  type Scope,
  SIGN_IN_PROVIDER_NAMES,
  type SignInProvider,
  WORKSPACE_ROLE_DESCRIPTIONS,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@retainer/shared';

/** Plain words for roles, keys and dates on the accounts screens (accounts spec 5.1). */

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export const shortDate = (value: string | Date) =>
  new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const description = (role: WorkspaceRole | OrganizationRole, kind: 'workspace' | 'organization') =>
  kind === 'workspace'
    ? WORKSPACE_ROLE_DESCRIPTIONS[role as WorkspaceRole]
    : ORGANIZATION_ROLE_DESCRIPTIONS[role as OrganizationRole];

/** "Editor: can also add and change records, comment and review". */
export const roleWords = (
  role: WorkspaceRole | OrganizationRole,
  kind: 'workspace' | 'organization' = 'workspace',
) => `${capital(role)}: ${lower(description(role, kind))}`;

/** Every role of a kind explained, one sentence each, for under a table. */
export const roleLegend = (kind: 'workspace' | 'organization') =>
  (kind === 'workspace' ? WORKSPACE_ROLES : [...ORGANIZATION_ROLES])
    .map((role) => `${roleWords(role, kind)}.`)
    .join(' ');

export const WORKSPACE_ROLE_OPTIONS = WORKSPACE_ROLES.map((role) => ({
  value: role,
  label: capital(role),
  hint: WORKSPACE_ROLE_DESCRIPTIONS[role],
}));

/** Organization roles to choose from; only owners make owners. */
export const organizationRoleOptions = (canMakeOwners: boolean) =>
  [...ORGANIZATION_ROLES]
    .reverse()
    .filter((role) => canMakeOwners || role !== 'owner')
    .map((role) => ({
      value: role,
      label: capital(role),
      hint: ORGANIZATION_ROLE_DESCRIPTIONS[role],
    }));

const KEY_ACCESS_WORDS: Record<KeyAccess, string> = {
  read: 'Read only',
  write: 'Read and write',
  schema: 'Read, write and change structure',
};

export const KEY_ACCESS_OPTIONS = (Object.keys(KEY_ACCESS) as KeyAccess[]).map((value) => ({
  value,
  label: KEY_ACCESS_WORDS[value],
}));

export const keyAccessWords = (scopes: readonly Scope[]) => KEY_ACCESS_WORDS[keyAccessOf(scopes)];

/** What an app connected over sign-in may do, in plain words (accounts spec 5). */
export const APP_SCOPE_WORDS: Partial<Record<Scope, string>> = {
  read: 'See everything in the workspace',
  write: 'Add and change records, events and notes',
  'schema:write': "Add objects and fields to the workspace's structure",
};

/** "Google", "Microsoft" or "Google or Microsoft", for sentences on the sign-in page. */
export function providerNames(providers: readonly SignInProvider[]): string {
  return providers.length
    ? providers.map((p) => SIGN_IN_PROVIDER_NAMES[p]).join(' or ')
    : 'Google or Microsoft';
}

/**
 * Plain words for the error Google's or Microsoft's sign-in sends back to the
 * page in `?error=` (accounts spec 4.4, 9.2).
 *
 * - `email_not_verified`, `email_not_found`: Retainer only uses an address
 *   the provider verified. A work Microsoft account's address counts only
 *   once its organization has proven to Microsoft that it owns the domain.
 * - `account_not_linked`: someone already signs in with this address another
 *   way, and this account did not verify the address, or is a second account
 *   from the same provider.
 * - `unable_to_create_user`, `unable_to_link_account`: two first sign-ins
 *   met (another tab, a double click). The other one finished, so signing in
 *   again works.
 */
export function signInError(code: string | null): string {
  if (!code) return '';
  switch (code.toLowerCase()) {
    case 'email_not_verified':
    case 'email_not_found':
      return (
        'That account has no verified email address, so it cannot be used to sign in. ' +
        'With a work or school Microsoft account, your IT admin can verify your email ' +
        'domain with Microsoft; until then, sign in another way.'
      );
    case 'account_not_linked':
      return (
        'Someone already signs in to Retainer with this email address another way, and this ' +
        'account cannot be added to theirs. Sign in the way you did before.'
      );
    case 'unable_to_create_user':
    case 'unable_to_link_account':
      return 'Your account was just set up in another tab or window. Sign in again.';
    default:
      return 'Signing in did not work. Try again.';
  }
}

/**
 * A query string without the `error` Google's sign-in adds when it fails,
 * so a failed sign-in can be retried and an OAuth request resumed with the
 * parameters it started with.
 */
export function withoutSignInError(search: string): string {
  const query = new URLSearchParams(search);
  query.delete('error');
  query.delete('error_description');
  const rest = query.toString();
  return rest ? `?${rest}` : '';
}
