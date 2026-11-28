import { hostedClientId } from '@retainer/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  type Account,
  account as accountApi,
  type Workspace,
  workspaceHref,
} from '../api/account.js';
import { api } from '../api/client.js';
import { describeOperation } from '../routes/schema/schema-model.js';
import { Button, copyText, Input, Label, Muted, Notice, Stack } from '../ui/index.js';
import { type AccountState, managed } from './context.js';
import { AccountFrame, InvitationRow } from './screens.js';
import { WorkspaceTemplateField } from './workspace-template.js';

function canCreateWorkspace(account: Account) {
  return account.organizations.length === 0 || managed(account).length > 0;
}

/** The same no-workspace step can return to the app or the current OAuth request. */
export function NeedWorkspace({
  account,
  oauthQuery,
  onWorkspace,
}: {
  account: Account;
  oauthQuery?: string;
  onWorkspace: (workspace: Workspace) => void;
}) {
  const canCreate = canCreateWorkspace(account);
  const invited = account.invitations.length > 0;
  const [skipInvitation, setSkipInvitation] = useState(false);
  const provision = useMutation({
    mutationFn: (template?: string) =>
      accountApi.ensureWorkspace({ skipInvitation, oauthQuery, template }),
    onSuccess: ({ workspace }) => {
      if (workspace) onWorkspace(workspace);
    },
  });
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const template = String(new FormData(event.currentTarget).get('template') ?? '');
    provision.mutate(template || undefined);
  }

  return (
    <Stack>
      {invited ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">You've been invited</h2>
          {account.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              id={invitation.id}
              returnTo={window.location.pathname + window.location.search}
            >
              {invitation.invitedBy ? `${invitation.invitedBy} invited you to ` : 'Join '}
              <strong>{invitation.organization}</strong>
            </InvitationRow>
          ))}
          {canCreate && !skipInvitation ? (
            <div>
              <Button onClick={() => setSkipInvitation(true)}>Create my own workspace</Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {!canCreate ? (
        <Notice>Ask an owner or admin of your organization to add you to a workspace.</Notice>
      ) : !invited || skipInvitation ? (
        <form onSubmit={create}>
          <Stack>
            <WorkspaceTemplateField />
            {provision.error ? <Notice error>{provision.error.message}</Notice> : null}
            {provision.data && !provision.data.workspace ? (
              <Notice>An invitation is waiting for you. Reload this page to see it.</Notice>
            ) : null}
            <div>
              <Button disabled={provision.isPending} type="submit" variant="primary">
                {provision.isPending ? 'Creating workspace…' : 'Create workspace'}
              </Button>
            </div>
          </Stack>
        </form>
      ) : null}
    </Stack>
  );
}

export function HostedFirstRun({ account }: { account: Account }) {
  return (
    <AccountFrame
      title={`Welcome, ${account.user.name.split(' ')[0] || 'there'}`}
      description="Retainer gives your agents a place to remember your work."
      account={account}
    >
      <NeedWorkspace account={account} onWorkspace={openCreatedWorkspace} />
    </AccountFrame>
  );
}

function openCreatedWorkspace(workspace: Workspace) {
  window.location.replace(workspaceHref(workspace.slug));
}

function workspaceSetupPrompt(origin: string, workspace: AccountState['workspace']) {
  const alias = `retainer-${workspace.slug}`;
  return `Connect this agent to Retainer so we can set up my workspace.

Hosted MCP URL: ${origin}/mcp
Connection instructions: ${origin}/mcp/setup
Workspace: ${JSON.stringify(workspace.name)} (slug: ${workspace.slug}, ID: ${workspace.id})

First try an authenticated describe_schema on any existing Retainer connection. Reuse it only if it returns this workspace ID.

Otherwise follow the hosted instructions, using this workspace's public OAuth client and server name.

For Codex, add or update these tables in your Codex MCP configuration, then run codex mcp login ${alias}:

[mcp_servers.${alias}]
url = "${origin}/mcp"
[mcp_servers.${alias}.oauth]
client_id = "${hostedClientId(workspace.id, 'codex')}"
callback_url = "http://127.0.0.1/callback"

For Claude Code, run:
claude mcp add --transport http --scope user --client-id ${hostedClientId(workspace.id, 'claude')} ${alias} ${origin}/mcp
Then run claude mcp login ${alias}, or authenticate that server in /mcp.

Use the same server name for login. If it is already configured, reuse it and sign in again only if needed. Open the browser for me to approve access. This connection is registered for the workspace above.

Verify the workspace ID with describe_schema before reporting success or making any changes. If verification fails or the agent needs to reload, give me the exact next step and resume verification afterward.

Once verified, if initialized is false, read get_guide("discover_schema") and follow it. Explore the context and sources you can already access, ask only for what is missing, and show me the complete proposed schema. Wait for my approval before applying it. Call describe_schema again to verify the result.`;
}

export function WorkspaceSetup({
  state,
  onApplied,
}: {
  state: AccountState;
  onApplied: () => void;
}) {
  const { workspace, account } = state;
  const { name } = workspace;
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const prompt = workspaceSetupPrompt(window.location.origin, workspace);
  const proposals = useQuery({
    queryKey: [workspace.id, 'setup-proposals'],
    queryFn: ({ signal }) => api.schemaChanges({ status: 'proposed', limit: 10, signal }),
    enabled: workspace.role === 'admin',
    refetchInterval: 5000,
    retry: false,
  });
  async function copy() {
    setStatus('');
    if (await copyText(prompt)) {
      setStatus('Copied. Paste the prompt into your agent.');
    } else {
      setShowPrompt(true);
      setStatus('Select and copy the prompt below.');
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = new FormData(event.currentTarget);
      await accountApi.renameWorkspace(workspace.id, String(data.get('name') ?? ''));
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(true);
    setError('');
    try {
      const result = await api.decideSchemaChange(id, decision);
      if (result.status === 'failed')
        setError(result.change?.error ?? 'The schema could not be applied.');
      await proposals.refetch();
      onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountFrame
      title={name}
      description="Set up your workspace with your agent."
      account={account}
      currentWorkspace={workspace.id}
    >
      {renaming ? (
        <form onSubmit={(event) => void rename(event)}>
          <Stack>
            <Label htmlFor="setup-workspace-name">
              Workspace name
              <Input
                id="setup-workspace-name"
                name="name"
                defaultValue={name}
                maxLength={200}
                required
              />
            </Label>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={busy}>
                Save name
              </Button>
              <Button disabled={busy} onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </div>
          </Stack>
        </form>
      ) : workspace.role === 'admin' ? (
        <div>
          <Button size="small" onClick={() => setRenaming(true)}>
            Rename workspace
          </Button>
        </div>
      ) : null}
      <section className="rounded-lg border border-border bg-card p-5">
        <Stack>
          <h2 className="font-semibold">Connect Codex or Claude Code</h2>
          <p className="text-sm">
            Copy the prompt and paste it into your agent. It will help you connect and design a
            workspace around the records you already use. Review its proposal before it applies
            anything.
          </p>
          <div>
            <Button variant="primary" onClick={() => void copy()}>
              Copy setup prompt
            </Button>
          </div>
          <div className="contents" aria-live="polite">
            {status ? <Muted>{status}</Muted> : null}
          </div>
          {showPrompt ? (
            <textarea
              className="w-full rounded-md border p-2"
              aria-label="Setup prompt"
              readOnly
              value={prompt}
              rows={8}
            />
          ) : null}
        </Stack>
      </section>
      {proposals.data?.changes.map((change) => (
        <section key={change.id} className="rounded-lg border border-border bg-card p-5">
          <Stack>
            <h2 className="font-semibold">Schema change needs approval</h2>
            {change.reason ? <Muted>{change.reason}</Muted> : null}
            <ul className="list-disc pl-5 text-sm">
              {change.request.map((op, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable operation order
                <li key={index}>
                  {describeOperation(op, [])}
                  {op.op === 'create_object' && op.object.fields?.length ? (
                    <ul className="ml-4 list-disc text-muted-foreground">
                      {op.object.fields.map((field) => (
                        <li key={field.name}>
                          {field.label || field.name} ({field.type.replaceAll('_', ' ')}
                          {field.isNullable === false ? ', required' : ''}
                          {field.isUnique ? ', unique' : ''})
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void decide(change.id, 'approve')}
              >
                Approve
              </Button>
              <Button disabled={busy} onClick={() => void decide(change.id, 'reject')}>
                Reject
              </Button>
            </div>
          </Stack>
        </section>
      ))}
      {error ? <Notice error>{error}</Notice> : null}
      <Muted>Your records will appear here once your first schema is applied.</Muted>
    </AccountFrame>
  );
}
