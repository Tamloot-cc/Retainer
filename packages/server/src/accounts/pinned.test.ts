import { describe, expect, it } from 'vitest';
import { pinnedOAuthSettings } from '../auth/oauth-token.js';
import { pinnedRequest } from './pinned.js';

const ORIGIN = 'https://retainer.example';
const ID = '0b8e3f9c-6d3a-4f5e-9a1b-2c3d4e5f6a7b';
const RESOURCE = `${ORIGIN}/mcp/w/${ID}`;

describe('pinned MCP addresses', () => {
  it('make OAuth settings of their own', () => {
    expect(pinnedOAuthSettings(ORIGIN, ID)).toEqual({
      issuer: `${ORIGIN}/account/auth`,
      resource: RESOURCE,
      resourceMetadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp/w/${ID}`,
    });
  });

  it('are linked only for an authorization naming exactly that resource and a client', () => {
    expect(pinnedRequest([RESOURCE], 'app', ORIGIN)).toEqual({
      workspaceId: ID,
      resource: RESOURCE,
      clientId: 'app',
    });
    expect(pinnedRequest([RESOURCE, `${ORIGIN}/mcp`], 'app', ORIGIN)).toBeNull();
    expect(pinnedRequest([RESOURCE], undefined, ORIGIN)).toBeNull();
    expect(pinnedRequest([`${ORIGIN}/mcp`], 'app', ORIGIN)).toBeNull();
    expect(pinnedRequest([], 'app', ORIGIN)).toBeNull();
  });
});
