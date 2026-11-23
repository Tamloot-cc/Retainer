import { describe, expect, it } from 'vitest';
import { pinnedMcpAddress, pinnedWorkspaceOf, pinnedWorkspaceOfResources } from './mcp-address.js';

const ORIGIN = 'https://retainer.example';
const ID = '0b8e3f9c-6d3a-4f5e-9a1b-2c3d4e5f6a7b';

describe('pinned MCP addresses', () => {
  it("builds the address on the origin's origin", () => {
    expect(pinnedMcpAddress(`${ORIGIN}/ignored/path`, ID)).toBe(`${ORIGIN}/mcp/w/${ID}`);
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

  it('finds the first pinned address among several resources', () => {
    expect(pinnedWorkspaceOfResources([`${ORIGIN}/mcp`, `${ORIGIN}/mcp/w/${ID}`], ORIGIN)).toBe(ID);
    expect(pinnedWorkspaceOfResources([`${ORIGIN}/mcp`], ORIGIN)).toBeUndefined();
    expect(pinnedWorkspaceOfResources([], ORIGIN)).toBeUndefined();
  });
});
