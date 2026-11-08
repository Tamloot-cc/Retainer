/**
 * The ways a person first signs in, in accounts mode (accounts spec 4.4), in
 * the order the sign-in page shows them. Passkeys come after.
 */
export const SIGN_IN_PROVIDERS = ['google', 'microsoft'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/** What the sign-in page calls each provider. */
export const SIGN_IN_PROVIDER_NAMES: Record<SignInProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};
