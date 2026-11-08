import { describe, expect, it } from 'vitest';
import {
  microsoftAccountId,
  microsoftEmailVerified,
  microsoftProvider,
  PERSONAL_ACCOUNTS_TENANT,
} from './microsoft.js';

// Which Microsoft addresses Retainer trusts (accounts spec 4.4, 9.1).

const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

describe('a Microsoft address counts as verified', () => {
  it('for a personal account, which Microsoft verifies itself', () => {
    expect(microsoftEmailVerified({ tid: PERSONAL_ACCOUNTS_TENANT, email: 'a@outlook.com' })).toBe(
      true,
    );
  });

  it('for a work account only when the tenant proved it owns the domain', () => {
    expect(microsoftEmailVerified({ tid: WORK_TENANT, email: 'a@contoso.com' })).toBe(false);
    for (const proof of [true, 'true', 1, '1']) {
      expect(
        microsoftEmailVerified({ tid: WORK_TENANT, email: 'a@contoso.com', xms_edov: proof }),
      ).toBe(true);
    }
    for (const notProof of [false, 'false', 0, '0', '', null]) {
      expect(
        microsoftEmailVerified({ tid: WORK_TENANT, email: 'a@contoso.com', xms_edov: notProof }),
      ).toBe(false);
    }
  });

  it('never from claims a tenant can influence or Microsoft does not send', () => {
    const claims = {
      tid: WORK_TENANT,
      email: 'ceo@victim.example',
      email_verified: true,
      verified_primary_email: ['ceo@victim.example'],
      verified_secondary_email: ['ceo@victim.example'],
    };
    expect(microsoftEmailVerified(claims)).toBe(false);
  });

  it('never without an address', () => {
    expect(microsoftEmailVerified({ tid: PERSONAL_ACCOUNTS_TENANT })).toBe(false);
    expect(microsoftEmailVerified({ tid: WORK_TENANT, email: '', xms_edov: true })).toBe(false);
  });

  it('is what the provider reports, over Better Auth’s own reading', async () => {
    const provider = microsoftProvider({ clientId: 'id', clientSecret: 'secret' });
    const mapped = await provider.mapProfileToUser?.({
      tid: WORK_TENANT,
      oid: 'o',
      email: 'ceo@victim.example',
      verified_primary_email: ['ceo@victim.example'],
    } as never);
    expect(mapped).toEqual({ emailVerified: false });
  });
});

describe('a Microsoft account’s key', () => {
  it('is its tenant and object ID', () => {
    expect(microsoftAccountId({ tid: WORK_TENANT, oid: 'abc' })).toBe(`${WORK_TENANT}:abc`);
  });

  it('refuses a token without them', () => {
    expect(() => microsoftAccountId({ oid: 'abc' })).toThrow();
    expect(() => microsoftAccountId({ tid: WORK_TENANT, oid: '' })).toThrow();
  });
});

describe('the Microsoft provider', () => {
  it('serves every account type and asks only who the person is', () => {
    const provider = microsoftProvider({ clientId: 'id', clientSecret: 'secret' });
    expect(provider).toMatchObject({
      tenantId: 'common',
      authority: 'https://login.microsoftonline.com',
      disableDefaultScope: true,
      scope: ['openid', 'profile', 'email'],
      disableProfilePhoto: true,
    });
  });
});
