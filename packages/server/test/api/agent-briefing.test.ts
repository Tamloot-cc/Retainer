import type { AgentBriefing } from '@retainer/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_NAMES, GUIDES } from '../../src/mcp/guides.js';
import { INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { type McpTestClient, startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { testRunTokens } from '../helpers/model.js';

const db = useTestDatabase();
const clients: McpTestClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

/** The tools an MCP client lists, by name, with their descriptions and input schemas. */
async function listed(client: McpTestClient) {
  const { tools } = await client.listTools();
  return tools
    .map(({ name, description, inputSchema }) => ({
      name,
      description: description ?? '',
      inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const sorted = (tools: AgentBriefing['tools']) =>
  [...tools].sort((a, b) => a.name.localeCompare(b.name));

describe('GET /v1/agent-briefing', () => {
  let app: ReturnType<typeof startTestApp>;
  let keys: Record<'agent' | 'reader' | 'blind', string>;
  beforeAll(async () => {
    app = startTestApp(db);
    ({ keys } = await app.setupWorkspace(
      { name: 'Briefing' },
      {
        agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write', 'schema:write'] },
        reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
        blind: { actor: { type: 'agent', id: 'blind' }, scopes: ['write'] },
      },
    ));
  });

  it('returns the tools tools/list gives the same caller, the instructions and every guide', async () => {
    for (const key of [keys.agent, keys.reader]) {
      const client = await app.mcpClient(key);
      clients.push(client);
      const response = await app.request<AgentBriefing>('/v1/agent-briefing', { key });
      expect(response.status).toBe(200);
      expect(sorted(response.body.tools)).toEqual(await listed(client));
      expect(response.body.instructions).toBe(client.getInstructions());
      expect(response.body.instructions).toBe(INSTRUCTIONS);
    }
    const { body } = await app.request<AgentBriefing>('/v1/agent-briefing', { key: keys.agent });
    expect(body.guides).toEqual(
      GUIDE_NAMES.map((name) => ({
        name,
        description: GUIDES[name].description,
        markdown: GUIDES[name].text,
      })),
    );
    // Each guide is what get_guide serves.
    const client = clients[0] as McpTestClient;
    for (const guide of body.guides) {
      const served = await client.callTool({ name: 'get_guide', arguments: { name: guide.name } });
      const text = (served.content as { type: string; text: string }[])
        .map((part) => part.text)
        .join('');
      expect(text).toContain(guide.markdown.slice(0, 200));
    }
  });

  it('leaves out the Routines tools when this deployment does not run routines', async () => {
    const { body } = await app.request<AgentBriefing>('/v1/agent-briefing', { key: keys.agent });
    expect(body.tools.some((tool) => tool.name === 'propose_routine')).toBe(false);
  });

  it('refuses a caller without read', async () => {
    const response = await app.request('/v1/agent-briefing', { key: keys.blind });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { details: { required: 'read' } } });
  });
});

describe('GET /v1/agent-briefing with routines on', () => {
  it('lists the Routines tools exactly as /mcp does', async () => {
    const { tokens } = await testRunTokens();
    const app = startTestApp(db, {
      runTokens: tokens,
      routines: { available: true, modelAvailable: false },
    });
    const { keys } = await app.setupWorkspace(
      { name: 'Briefing routines' },
      { agent: { actor: { type: 'agent', id: 'builder' }, scopes: ['read', 'write'] } },
    );
    const client = await app.mcpClient(keys.agent);
    clients.push(client);
    const { body } = await app.request<AgentBriefing>('/v1/agent-briefing', { key: keys.agent });
    expect(body.tools.some((tool) => tool.name === 'propose_routine')).toBe(true);
    expect(sorted(body.tools)).toEqual(await listed(client));
  });
});
