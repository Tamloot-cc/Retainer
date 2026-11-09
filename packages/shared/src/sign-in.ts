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

/** The ways a person can sign in: a provider, or a passkey they added. */
export type SignInMethod = SignInProvider | 'passkey';

/**
 * The cookie that remembers how this browser last signed in, so the sign-in
 * page can mark that button. Readable by the page, unlike the session cookie,
 * and it outlives sign-out; it holds only the method's name.
 */
export const LAST_SIGN_IN_COOKIE = 'retainer.last_sign_in';
