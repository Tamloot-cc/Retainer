import type { BetterAuthPlugin } from 'better-auth';
import type { MicrosoftOptions } from 'better-auth/social-providers';
import type { OAuthClient } from '../config.js';

/**
 * Microsoft sign-in (accounts spec 4.4, 9.1): work and school accounts from
 * any Microsoft Entra tenant, and personal Microsoft accounts.
 *
 * A Microsoft account is keyed on its tenant and object ID (`tid:oid`), as
 * Microsoft recommends: both are Microsoft's own, fixed for the account, and
 * no tenant admin can change them. The email address is only trusted where
 * Microsoft vouches for it, because an Entra tenant's admin can put any
 * address on their own users.
 */

/** The tenant every personal Microsoft account signs in through. */
export const PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Microsoft's sign-in service. Tests point the provider at a local fake instead. */
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com';

/** The ID token claims the rule reads. */
type Claims = { tid?: unknown; email?: unknown; xms_edov?: unknown };

/**
 * Whether Microsoft verified the token's `email`, which Retainer then trusts
 * as much as a Google address: to create a person, to join an existing
 * person with that address, and to accept invitations to it.
 *
 * - Personal accounts: yes. Microsoft verifies their addresses itself.
 * - Work and school accounts: only with `xms_edov`, the optional claim that
 *   says the tenant has proven it owns the address's domain. Without it the
 *   address is whatever the tenant's admin typed in.
 *
 * Nothing else counts. `email_verified` and `verified_primary_email`, which
 * Better Auth would otherwise read, are ignored: Microsoft does not send the
 * first, and neither says the tenant owns the domain.
 */
export function microsoftEmailVerified(claims: Claims): boolean {
  if (typeof claims.email !== 'string' || claims.email === '') return false;
  if (claims.tid === PERSONAL_ACCOUNTS_TENANT) return true;
  return [true, 'true', 1, '1'].includes(claims.xms_edov as never);
}

/** Better Auth's Microsoft provider, set up as described above. */
export function microsoftProvider(
  client: OAuthClient,
  authority: string = MICROSOFT_AUTHORITY,
): MicrosoftOptions {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    // Work, school and personal accounts alike.
    tenantId: 'common',
    authority,
    prompt: 'select_account',
    // Only who the person is: no Microsoft Graph permission, which some
    // organizations let only an admin approve, and no refresh token.
    disableDefaultScope: true,
    scope: ['openid', 'profile', 'email'],
    // The photo comes from Microsoft Graph, which would need another
    // permission and another host to reach. Retainer shows no photos.
    disableProfilePhoto: true,
    // Spread over Better Auth's own reading of the token, so this rule is
    // the only one that decides.
    mapProfileToUser: (profile) => ({ emailVerified: microsoftEmailVerified(profile) }),
  };
}

/** The account's key: its tenant and object ID, never its email. */
export function microsoftAccountId(claims: { tid?: unknown; oid?: unknown }): string {
  const { tid, oid } = claims;
  if (typeof tid !== 'string' || tid === '' || typeof oid !== 'string' || oid === '') {
    throw new Error('a Microsoft ID token without its tenant and object IDs');
  }
  return `${tid}:${oid}`;
}

/**
 * Keys Microsoft accounts on `tid:oid` rather than the provider's own choice,
 * the object ID alone. Better Auth builds its providers before plugins start,
 * so this sets the one it built. A test checks the stored key, so an upgrade
 * that stops honoring it fails there.
 */
export function microsoftAccountKey(): BetterAuthPlugin {
  return {
    id: 'retainer-microsoft-account-key',
    init(context) {
      const provider = context.socialProviders.find((p) => p.id === 'microsoft');
      if (provider) provider.accountSubject = ({ profile }) => microsoftAccountId(profile);
    },
  };
}
