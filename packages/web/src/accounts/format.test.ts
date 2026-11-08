import { describe, expect, it } from 'vitest';
import { providerNames, signInError, withoutSignInError } from './format.js';

describe('signInError', () => {
  it('says nothing without an error', () => {
    expect(signInError(null)).toBe('');
  });

  it('tells someone who lost a simultaneous first sign-in to sign in again', () => {
    for (const code of ['unable_to_create_user', 'unable_to_link_account']) {
      expect(signInError(code)).toMatch(/just set up in another tab or window. Sign in again/);
      expect(signInError(code)).not.toMatch(/verified/);
    }
  });

  it('names an address the provider has not verified, whatever the code’s case', () => {
    for (const code of ['email_not_verified', 'EMAIL_NOT_VERIFIED', 'email_not_found']) {
      expect(signInError(code)).toMatch(/no verified email address/);
      expect(signInError(code)).toMatch(/IT admin can verify your email domain with Microsoft/);
    }
  });

  it('sends someone whose address is already in use back the way they came', () => {
    expect(signInError('account_not_linked')).toMatch(/Sign in the way you did before/);
  });

  it('falls back to a plain retry', () => {
    expect(signInError('state_not_found')).toBe('Signing in did not work. Try again.');
  });
});

describe('providerNames', () => {
  it('names the providers that are on', () => {
    expect(providerNames(['google'])).toBe('Google');
    expect(providerNames(['microsoft'])).toBe('Microsoft');
    expect(providerNames(['google', 'microsoft'])).toBe('Google or Microsoft');
  });
});

describe('withoutSignInError', () => {
  it("drops the provider's error and keeps an OAuth request's parameters", () => {
    expect(withoutSignInError('?client_id=c&sig=s&error=access_denied&error_description=no')).toBe(
      '?client_id=c&sig=s',
    );
    expect(withoutSignInError('?error=access_denied')).toBe('');
  });
});
