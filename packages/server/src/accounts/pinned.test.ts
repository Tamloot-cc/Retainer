import { describe, expect, it } from 'vitest';
import { pinnedMcpAddress, pinnedOAuthSettings, pinnedWorkspaceOf } from '../auth/oauth-token.js';
import { pinnedRequest, pinnedWorkspaceOfQuery } from './pinned.js';

const ORIGIN = 'https://retainer.example';
const ID = '0b8e3f9c-6d3a-4f5e-9a1b-2c3d4e5f6a7b';

describe('pinned MCP addresses', () => {
  it('builds the address and its OAuth settings from the origin', () => {
    expect(pinnedMcpAddress(`${ORIGIN}/ignored/path`, ID)).toBe(`${ORIGIN}/mcp/w/${ID}`);
    expect(pinnedOAuthSettings(ORIGIN, ID)).toEqual({
      issuer: `${ORIGIN}/account/auth`,
      resource: `${ORIGIN}/mcp/w/${ID}`,
      resourceMetadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp/w/${ID}`,
    });
  });

  it('reads the workspace only from an exact address on this origin', () => {
    expect(pinnedWorkspaceOf(`${ORIGIN}/mcp/w/${ID}`, ORIGIN)).toBe(ID);
    for (const other of [
      `${ORIGIN}/mcp`,
      `${ORIGIN}/v1`,
      `${ORIGIN}/mcp/w/${ID}/`,
      `${ORIGIN}/mcp/w/${ID.toUpperCase()}`,
      `${ORIGIN}/mcp/w/not-a-workspace`,
      `https://elsewhere.example/mcp/w/${ID}`,
      `${ORIGIN}/mcp/w/${ID}?x=1`,
    ])
      expect(pinnedWorkspaceOf(other, ORIGIN)).toBeUndefined();
  });

  it('takes a pinned request only when it names exactly one resource and one client', () => {
    const query = (entries: [string, string][]) => new URLSearchParams(entries);
    const resource = `${ORIGIN}/mcp/w/${ID}`;
    expect(
      pinnedRequest(
        query([
          ['resource', resource],
          ['client_id', 'app'],
        ]),
        ORIGIN,
      ),
    ).toEqual({ workspaceId: ID, resource, clientId: 'app' });
    expect(
      pinnedRequest(
        query([
          ['resource', resource],
          ['resource', `${ORIGIN}/mcp`],
          ['client_id', 'app'],
        ]),
        ORIGIN,
      ),
    ).toBeNull();
    expect(pinnedRequest(query([['resource', resource]]), ORIGIN)).toBeNull();
    expect(
      pinnedRequest(
        query([
          ['resource', `${ORIGIN}/mcp`],
          ['client_id', 'app'],
        ]),
        ORIGIN,
      ),
    ).toBeNull();
  });

  it("finds a consent query's pinned workspace among its resources", () => {
    expect(
      pinnedWorkspaceOfQuery(`resource=${encodeURIComponent(`${ORIGIN}/mcp/w/${ID}`)}`, ORIGIN),
    ).toBe(ID);
    expect(
      pinnedWorkspaceOfQuery(`resource=${encodeURIComponent(`${ORIGIN}/mcp`)}`, ORIGIN),
    ).toBeUndefined();
    expect(pinnedWorkspaceOfQuery('client_id=app', ORIGIN)).toBeUndefined();
  });
});
