import { describe, expect, it } from 'vitest';
import { signInError, withoutSignInError } from './format.js';

describe('signInError', () => {
  it('says nothing without an error', () => {
    expect(signInError(null)).toBe('');
  });

  it('tells someone who lost a simultaneous first sign-in to sign in again', () => {
    expect(signInError('unable_to_create_user')).toMatch(/created in another tab or window/);
    expect(signInError('unable_to_create_user')).not.toMatch(/verified/);
  });

  it('names an address Google has not verified, whatever the code’s case', () => {
    expect(signInError('email_not_verified')).toMatch(/not verified/);
    expect(signInError('EMAIL_NOT_VERIFIED')).toMatch(/not verified/);
  });

  it('falls back to a plain retry', () => {
    expect(signInError('state_not_found')).toBe('Signing in did not work. Try again.');
  });
});

describe('withoutSignInError', () => {
  it("drops Google's error and keeps an OAuth request's parameters", () => {
    expect(withoutSignInError('?client_id=c&sig=s&error=access_denied&error_description=no')).toBe(
      '?client_id=c&sig=s',
    );
    expect(withoutSignInError('?error=access_denied')).toBe('');
  });
});
