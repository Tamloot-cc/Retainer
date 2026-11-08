import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { connect, fetchClientMetadata, mcpCall } from '../helpers/oauth.js';

// Workspace and personal memory over REST and MCP (personal memory spec 4.4,
// 6): key mode, accounts mode with sessions, agent keys that work for a
// person, and apps connected over OAuth.

const db = useTestDatabase();

describe('key mode (M10)', () => {
  let t: TestApp;
  let key: string;

  beforeAll(async () => {
    t = startTestApp(db);
    ({
      keys: { agent: key },
    } = await t.setupWorkspace(
      { name: 'Key mode', template: 'sales' },
      { agent: { actor: { type: 'agent', id: 'bot' }, scopes: ['read', 'write'] } },
    ));
  });

  it('has workspace memory only: me is 422 no_person', async () => {
    const written = await t.request('/v1/records/workspace/facts', {
      key,
      body: { text: 'Never call before 10am.' },
    });
    expect(written.status).toBe(201);
    expect(written.body.fact).toMatchObject({ profile: 'workspace' });
    const context = await t.request('/v1/records/workspace/context', { key });
    expect(context.body).toMatchObject({
      profile: 'workspace',
      facts: [expect.objectContaining({ content: 'Never call before 10am.' })],
    });

    for (const [path, body] of [
      ['/v1/records/me/facts', { text: 'x' }],
      ['/v1/records/me/context', undefined],
      ['/v1/records/me/timeline', undefined],
    ] as const) {
      const res = await t.request(path, { key, ...(body ? { body } : {}) });
      expect(res.status, path).toBe(422);
      expect(res.body.error.code, path).toBe('no_person');
    }
    expect((await t.request('/v1/me', { key })).body.person).toBe(false);
  });

  it('answers profile_not_supported on every other record route', async () => {
    for (const [method, path] of [
      ['GET', '/v1/records/me'],
      ['GET', '/v1/records/workspace'],
      ['DELETE', '/v1/records/workspace'],
      ['GET', '/v1/records/me/comments'],
      ['POST', '/v1/records/workspace/merge'],
    ] as const) {
      const res = await t.request(path, {
        key,
        method,
        ...(method === 'POST' ? { body: { recordId: crypto.randomUUID() } } : {}),
      });
      expect(res.status, path).toBe(422);
      expect(res.body.error.code, path).toBe('profile_not_supported');
    }
    // Clear all is a signed-in person's, never a key's.
    const cleared = await t.request('/v1/records/me/forget', { key, method: 'POST' });
    expect(cleared.status).toBe(403);
  });

  it('serves the memory tools over MCP, with the memory guide', async () => {
    const client = await t.mcpClient(key);
    try {
      const described = await client.call('describe_schema');
      expect(
        described.body.builtIns.find((b: { name: string }) => b.name === 'memory'),
      ).toMatchObject({ profiles: ['workspace'] });
      const remembered = await client.call('remember', {
        record: 'workspace',
        text: 'We are Acme; @acme.com addresses are colleagues.',
      });
      expect(remembered.isError).toBe(false);
      const me = await client.call('get_context', { record: 'me' });
      expect(me).toMatchObject({ isError: true, body: { error: { code: 'no_person' } } });
      const record = await client.call('get_record', { id: 'workspace' });
      expect(record).toMatchObject({
        isError: true,
        body: { error: { code: 'profile_not_supported' } },
      });
      const guide = await client.call('get_guide', { name: 'memory' });
      expect(guide.body).toContain('Never put customer knowledge in me');
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toContain('memory');
    } finally {
      await client.close();
    }
  });
});

describe('accounts mode', () => {
  let app: AccountsTestApp;
  type Signed = { cookie: string; userId: string; email: string };
  let owner: Signed;
  let dana: Signed;
  let eli: Signed;
  let viewer: Signed;
  let workspaceId: string;

  const person = async (name: string): Promise<Signed> => {
    const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@memory.test`;
    return { ...(await app.signIn({ email, name })), email };
  };
  const v1 = (who: Signed, path: string, method = 'GET', body?: unknown) =>
    app.v1(path, { cookie: who.cookie, workspace: workspaceId, method, body });
  /** An API request with a bearer key. */
  const withKey = (key: string, path: string, method = 'GET', body?: unknown) =>
    app.api.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** A key made in the web app, by a workspace admin. */
  const createKey = async (who: Signed, worksForMe: boolean) => {
    const res = await app.account(`/account/workspaces/${workspaceId}/keys`, {
      cookie: who.cookie,
      method: 'POST',
      body: {
        name: `Agent ${Math.random().toString(16).slice(2, 6)}`,
        access: 'write',
        worksForMe,
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { key: string }).key;
  };

  beforeAll(async () => {
    app = startAccountsApp(db, { fetchClientMetadata });
    owner = await person('Owner');
    dana = await person('Dana');
    eli = await person('Eli');
    viewer = await person('Viewer');
    const organizationId = (await createOrganization(db.owner, { name: 'Memory Co' })).id;
    workspaceId = (
      await createWorkspace(db.owner, {
        name: 'Memory',
        slug: `memory-${Math.random().toString(16).slice(2, 10)}`,
        template: 'sales',
        organization: organizationId,
      })
    ).id;
    await setOrganizationMember(db.owner, {
      organization: organizationId,
      email: owner.email,
      role: 'owner',
    });
    for (const [who, role] of [
      [dana, 'admin'],
      [eli, 'editor'],
      [viewer, 'viewer'],
    ] as const) {
      await setOrganizationMember(db.owner, {
        organization: organizationId,
        email: who.email,
        role: 'member',
      });
      await setWorkspaceMember(db.owner, { workspace: workspaceId, email: who.email, role });
    }
  });

  it('gives a key made with "This agent works for me" its creator’s memory', async () => {
    const key = await createKey(dana, true);
    const plain = await createKey(dana, false);
    expect(((await (await withKey(key, '/v1/me')).json()) as { person: boolean }).person).toBe(
      true,
    );
    expect(((await (await withKey(plain, '/v1/me')).json()) as { person: boolean }).person).toBe(
      false,
    );
    const written = await withKey(key, '/v1/records/me/facts', 'POST', {
      text: 'Dana prefers WhatsApp',
    });
    expect(written.status).toBe(201);
    // Dana signed in sees it; Eli does not; a plain key has no me.
    const mine = await (await v1(dana, '/v1/records/me/facts')).json();
    expect(mine).toMatchObject({ profile: 'me', facts: [{ content: 'Dana prefers WhatsApp' }] });
    const theirs = await (await v1(eli, '/v1/records/me/facts')).json();
    expect(theirs).toMatchObject({ profile: 'me', facts: [] });
    expect((await withKey(plain, '/v1/records/me/context')).status).toBe(422);

    const listed = await app.account(`/account/workspaces/${workspaceId}/keys`, {
      cookie: dana.cookie,
    });
    const keys = ((await listed.json()) as { keys: { prefix: string; worksFor: unknown }[] }).keys;
    expect(keys.find((k) => key.startsWith(k.prefix))?.worksFor).toEqual({
      id: dana.userId,
      name: 'Dana',
    });
  });

  it('gives an app connected over OAuth the memory of the person who connected it', async () => {
    const tokens = await connect(app.accounts, { cookie: eli.cookie, workspaceId });
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpCall(app.api, tokens.access_token, 'tools/call', {
        name,
        arguments: args,
      });
      const text = await res.text();
      const data = text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5);
      return JSON.parse(data ?? text).result as { isError?: boolean; content: { text: string }[] };
    };
    const written = await call('remember', { record: 'me', text: 'Eli writes in Hebrew' });
    expect(written.isError).not.toBe(true);
    const read = await call('get_context', { record: 'me' });
    expect(JSON.parse(read.content[0]?.text ?? '{}')).toMatchObject({
      profile: 'me',
      label: 'Eli',
      facts: [{ content: 'Eli writes in Hebrew' }],
    });
    const signedIn = (await (await v1(eli, '/v1/records/me/facts')).json()) as {
      facts: { content: string }[];
    };
    expect(signedIn.facts.map((f: { content: string }) => f.content)).toContain(
      'Eli writes in Hebrew',
    );
  });

  it('lets a person remove their own facts and clear their memory, whatever their role', async () => {
    const key = await createKey(dana, false);
    const shared = (await (
      await withKey(key, '/v1/records/workspace/facts', 'POST', { text: 'Office closes at 6' })
    ).json()) as { fact: { id: string } };
    // The viewer's agent wrote to their memory while they were an editor.
    const role = (r: 'viewer' | 'editor') =>
      setWorkspaceMember(db.owner, { workspace: workspaceId, email: viewer.email, role: r });
    await role('editor');
    const tokens = await connect(app.accounts, { cookie: viewer.cookie, workspaceId });
    // The response streams: read it whole, so the write has finished.
    const remember = async (text: string) => {
      const res = await mcpCall(app.api, tokens.access_token, 'tools/call', {
        name: 'remember',
        arguments: { record: 'me', text },
      });
      return { status: res.status, text: await res.text() };
    };
    expect(await remember('Viewer likes mornings')).toMatchObject({ status: 200 });
    expect(await remember('Viewer likes tea')).toMatchObject({ status: 200 });
    await role('viewer');
    const facts = (await (await v1(viewer, '/v1/records/me/facts')).json()) as {
      facts: { id: string }[];
    };
    const own = facts.facts[0]?.id as string;

    // A viewer cannot remove a shared fact, but can remove their own.
    expect((await v1(viewer, `/v1/facts/${shared.fact.id}`, 'DELETE')).status).toBe(403);
    expect((await v1(viewer, `/v1/facts/${own}`, 'DELETE')).status).toBe(200);
    expect(
      ((await (await v1(viewer, '/v1/records/me/facts')).json()) as { facts: unknown[] }).facts,
    ).toHaveLength(1);
    // And clear it all: the retracted fact is deleted too.
    const cleared = await v1(viewer, '/v1/records/me/forget', 'POST');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ cleared: true, counts: { facts: 2 } });
    expect(
      ((await (await v1(viewer, '/v1/records/me/facts')).json()) as { facts: unknown[] }).facts,
    ).toEqual([]);
    // Workspace memory cannot be forgotten that way.
    expect((await v1(dana, '/v1/records/workspace/forget', 'POST')).status).toBe(422);
    // An OAuth agent cannot clear memory: its tools have no forget either.
    const tools = await mcpCall(app.api, tokens.access_token, 'tools/list');
    expect(await tools.text()).not.toContain('"forget');
  });

  it('shows a shared event’s claims without anyone else’s personal facts', async () => {
    const key = await createKey(dana, true);
    const logged = (await (
      await withKey(key, '/v1/events', 'POST', {
        type: 'conversation',
        channel: 'zoom',
        externalId: `claims-${Math.random()}`,
        occurredAt: '2026-10-29T14:00:00Z',
        title: 'Kickoff',
      })
    ).json()) as { id: string };
    await withKey(key, '/v1/records/me/facts', 'POST', {
      text: 'Dana felt the kickoff went long',
      source: logged.id,
      quote: 'that ran long',
    });
    const ofDana = (await (await v1(dana, `/v1/events/${logged.id}/claims`)).json()) as {
      facts: { profile?: string; content: string }[];
    };
    expect(ofDana.facts).toEqual([
      expect.objectContaining({ profile: 'me', content: 'Dana felt the kickoff went long' }),
    ]);
    for (const other of [eli, owner, viewer]) {
      const seen = await (await v1(other, `/v1/events/${logged.id}/claims`)).text();
      expect(seen).not.toContain('went long');
      expect(seen).not.toContain('ran long');
    }
  });
});
