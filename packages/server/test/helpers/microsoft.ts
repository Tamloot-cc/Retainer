import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PERSONAL_ACCOUNTS_TENANT } from '../../src/accounts/microsoft.js';

/**
 * A local stand-in for Microsoft's sign-in service (accounts spec 8), so no
 * test needs the internet. Better Auth's real Microsoft provider talks to it
 * as it would to login.microsoftonline.com: it fetches the signing keys,
 * sends the browser to authorize, and trades the code for a signed ID token.
 */

export const MICROSOFT_CLIENT_ID = 'test-microsoft-client';
export const MICROSOFT_CLIENT_SECRET = 'test-microsoft-secret';

/** The settings that turn Microsoft sign-in on, for this fake's client. */
export const MICROSOFT_SETTINGS = {
  RETAINER_MICROSOFT_CLIENT_ID: MICROSOFT_CLIENT_ID,
  RETAINER_MICROSOFT_CLIENT_SECRET: MICROSOFT_CLIENT_SECRET,
};

/** A work or school tenant, as opposed to personal accounts' tenant. */
export const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

/** The claims of a Microsoft ID token that Retainer reads. */
export type MicrosoftAccount = {
  oid: string;
  tid: string;
  email?: string;
  name?: string;
  /** Present only when the app asks for it and the tenant owns the domain. */
  xms_edov?: boolean | string;
  /** Claims that say nothing about who owns the domain (microsoft.ts). */
  email_verified?: boolean;
  verified_primary_email?: string[];
};

export type FakeMicrosoft = {
  /** Pass to the provider as its authority. */
  authority: string;
  /** A signed ID token for the account, as Microsoft would issue it. */
  idToken: (account: MicrosoftAccount) => Promise<string>;
  /** The account the next trip through authorize signs in as. */
  signInNextAs: (account: MicrosoftAccount) => void;
  /** Hands out a code for the account, as authorize does. */
  codeFor: (account: MicrosoftAccount) => string;
  close: () => Promise<void>;
};

/** A personal Microsoft account (Outlook.com, Hotmail, Live). */
export const personalAccount = (email: string, name = 'Personal Person'): MicrosoftAccount => ({
  oid: `00000000-0000-0000-${randomUUID().slice(-17)}`,
  tid: PERSONAL_ACCOUNTS_TENANT,
  email,
  name,
});

/**
 * A work account. `verified` adds `xms_edov`, the tenant's proof it owns the
 * domain. Without it the account still carries `email_verified` and
 * `verified_primary_email` for its address, which Better Auth on its own
 * would take as verified; Retainer must not.
 */
export const workAccount = (
  email: string,
  { verified, name = 'Work Person' }: { verified: boolean; name?: string },
): MicrosoftAccount => ({
  oid: randomUUID(),
  tid: WORK_TENANT,
  email,
  name,
  ...(verified ? { xms_edov: true } : { email_verified: true, verified_primary_email: [email] }),
});

export async function startFakeMicrosoft(): Promise<FakeMicrosoft> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = `fake-${randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, MicrosoftAccount>();
  let next: MicrosoftAccount | undefined;
  let authority = '';

  const idToken = (account: MicrosoftAccount) =>
    new SignJWT({ ver: '2.0', preferred_username: account.email, ...account })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(`${authority}/${account.tid}/v2.0`)
      .setAudience(MICROSOFT_CLIENT_ID)
      .setSubject(`pairwise-${account.oid}`)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  const codeFor = (account: MicrosoftAccount) => {
    const code = randomUUID();
    codes.set(code, account);
    return code;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', authority);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/common/discovery/v2.0/keys') {
      return send(200, { keys: [jwk] });
    }
    if (req.method === 'GET' && url.pathname === '/common/oauth2/v2.0/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      if (!next || !redirect) return send(400, { error: 'invalid_request' });
      const back = new URL(redirect);
      back.searchParams.set('code', codeFor(next));
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      next = undefined;
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/common/oauth2/v2.0/token') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const code = form.get('code') ?? '';
        const account = codes.get(code);
        // A code works once, as Microsoft's do.
        codes.delete(code);
        if (!account || form.get('client_secret') !== MICROSOFT_CLIENT_SECRET) {
          return send(400, { error: 'invalid_grant' });
        }
        void idToken(account).then((token) =>
          send(200, {
            token_type: 'Bearer',
            scope: 'openid profile email',
            expires_in: 3600,
            access_token: `access-${randomUUID()}`,
            id_token: token,
          }),
        );
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  authority = `http://127.0.0.1:${address.port}`;

  return {
    authority,
    idToken,
    signInNextAs: (account) => {
      next = account;
    },
    codeFor,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
