import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { updatingFetch } from './maintenance.js';

/** Signing in with Google, Microsoft or a passkey, and managing passkeys (accounts spec 4.2). */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/account/auth',
  fetchOptions: { customFetchImpl: updatingFetch },
  plugins: [passkeyClient()],
});
