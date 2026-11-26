import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isRuntimeCredential,
  mintToken,
  parseToken,
  STREAM_TOKEN_PREFIX,
  secretMatches,
  TURN_TOKEN_PREFIX,
} from './tokens.js';

describe('agent tokens', () => {
  const workspace = randomUUID();
  const id = randomUUID();

  it('mints a token whose secret only its hash matches', () => {
    const { token, hash } = mintToken(TURN_TOKEN_PREFIX, workspace, id);
    const parsed = parseToken(TURN_TOKEN_PREFIX, token);
    expect(parsed).toMatchObject({ workspaceId: workspace, id });
    expect(secretMatches(hash, parsed?.secret ?? '')).toBe(true);
    const other = mintToken(TURN_TOKEN_PREFIX, workspace, id);
    expect(secretMatches(other.hash, parsed?.secret ?? '')).toBe(false);
    expect(hash).not.toContain(parsed?.secret);
  });

  it('keeps stream and turn tokens apart', () => {
    const stream = mintToken(STREAM_TOKEN_PREFIX, workspace, id).token;
    expect(parseToken(TURN_TOKEN_PREFIX, stream)).toBeUndefined();
    expect(parseToken(STREAM_TOKEN_PREFIX, stream)).toBeDefined();
  });

  it('refuses malformed tokens', () => {
    const { token } = mintToken(TURN_TOKEN_PREFIX, workspace, id);
    for (const bad of [
      '',
      TURN_TOKEN_PREFIX,
      `${token}.extra`,
      token.replace(workspace, 'not-a-uuid'),
      token.slice(0, -1),
      `rk_${token}`,
    ])
      expect(parseToken(TURN_TOKEN_PREFIX, bad), bad).toBeUndefined();
  });

  it('checks the runtime credential', () => {
    const secret = 'x'.repeat(40);
    expect(isRuntimeCredential(secret, secret)).toBe(true);
    expect(isRuntimeCredential(secret, `${secret}y`)).toBe(false);
    expect(isRuntimeCredential(undefined, secret)).toBe(false);
    expect(isRuntimeCredential(secret, undefined)).toBe(false);
  });
});
