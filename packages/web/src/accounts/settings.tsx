import {
  isOrganizationManager,
  type KeyAccess,
  ORGANIZATION_ROLE_DESCRIPTIONS,
  type OrganizationRole,
  WORKSPACE_ROLE_DESCRIPTIONS,
  type WorkspaceRole,
} from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  account as accountApi,
  type PendingInvitation,
  type WorkspaceKey,
  workspaceHref,
} from '../api/account.js';
import { QueryError, useView } from '../routes/state.js';
import {
  Button,
  CheckLabel,
  Code,
  CopyButton,
  Dialog,
  Empty,
  Input,
  Label,
  Muted,
  Notice,
  Page,
  Panel,
  Segmented,
  SelectMenu,
  Stack,
  Table,
  Tabs,
  Td,
  Tr,
} from '../ui/index.js';
import { ConnectedApps } from './connections.js';
import { type AccountState, useAccount } from './context.js';
import {
  capital,
  shortDate as date,
  KEY_ACCESS_OPTIONS,
  keyAccessWords,
  organizationRoleOptions,
  providerNames,
  roleLegend,
  WORKSPACE_ROLE_OPTIONS,
} from './format.js';
import { MemoryTab } from './memory.js';

/** `/app/w/<slug>/settings`: people, agents and the workspace (accounts spec 5.1). */

type Tab = 'members' | 'memory' | 'agents' | 'workspace' | 'organization';

export function SettingsPage() {
  const state = useAccount();
  const { search, setSearch } = useView();
  const organization = useQuery({
    queryKey: ['account', 'organization', state?.organization.id],
    queryFn: () => accountApi.organization(state?.organization.id ?? ''),
    enabled: !!state && isOrganizationManager(state.organization.role),
  });
  if (!state)
    return (
      <Page title="Settings">
        <Notice>
          Settings are for accounts. With an API key, your operator manages people and keys with the
          command line.
        </Notice>
      </Page>
    );
  const admin = state.workspace.role === 'admin';
  // Hidden while the organization is one person with one workspace (A5).
  const showOrganization =
    !!organization.data &&
    (organization.data.members.length > 1 || organization.data.workspaces.length > 1);
  const tabs: { value: Tab; label: string; hint: string }[] = [
    {
      value: 'members',
      label: 'Members',
      hint: 'Who has access to this workspace, and their roles',
    },
    {
      value: 'memory',
      label: 'Memory',
      hint: 'What agents remember about this workspace and about you',
    },
    ...(admin
      ? ([
          {
            value: 'agents',
            label: 'Agents',
            hint: 'API keys and apps people connected, such as Claude',
          },
          {
            value: 'workspace',
            label: 'Workspace',
            hint: isOrganizationManager(state.organization.role)
              ? "This workspace's name, and deleting it"
              : "This workspace's name",
          },
        ] as const)
      : []),
    ...(showOrganization
      ? ([
          {
            value: 'organization',
            label: 'Organization',
            hint: 'Everyone in the organization, invitations and workspaces',
          },
        ] as const)
      : []),
  ];
  const tab = tabs.find((t) => t.value === search.tab)?.value ?? 'members';
  return (
    <Page title="Settings" description={state.workspace.name}>
      <Tabs items={tabs} value={tab} onChange={(v) => void setSearch({ tab: v })} sticky />
      {tab === 'members' ? (
        <MembersTab state={state} />
      ) : tab === 'memory' ? (
        <MemoryTab />
      ) : tab === 'agents' ? (
        <AgentsTab state={state} />
      ) : tab === 'workspace' ? (
        <WorkspaceTab state={state} />
      ) : (
        <OrganizationTab state={state} />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MembersTab({ state }: { state: AccountState }) {
  const client = useQueryClient();
  const key = ['account', 'members', state.workspace.id];
  const members = useQuery({
    queryKey: key,
    queryFn: () => accountApi.members(state.workspace.id),
  });
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null),
    [inviting, setInviting] = useState(false),
    [adding, setAdding] = useState(false),
    [error, setError] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const change = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      accountApi.setMemberRole(state.workspace.id, userId, role),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  if (!members.data)
    return members.error ? (
      <QueryError error={members.error} retry={() => void members.refetch()} />
    ) : (
      <Notice>Loading members…</Notice>
    );
  const admin = members.data.role === 'admin';
  const manager = isOrganizationManager(state.organization.role);
  const askable = members.data.members.filter((m) => isOrganizationManager(m.organizationRole));
  return (
    <Stack>
      <div className="flex flex-wrap items-center gap-2">
        <Muted small>
          {members.data.members.length === 1
            ? 'Only you have access so far.'
            : `${members.data.members.length} people have access.`}
        </Muted>
        <span className="flex-1" />
        {admin && members.data.candidates.length ? (
          <Button onClick={() => setAdding(true)}>Add someone</Button>
        ) : null}
        {manager ? (
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite
          </Button>
        ) : null}
      </div>
      {error ? (
        <Notice error onDismiss={() => setError('')}>
          {error}
        </Notice>
      ) : null}
      <Table headers={[{ label: 'Person' }, { label: 'Role' }, { label: 'Joined' }, { label: '' }]}>
        {members.data.members.map((m) => {
          const throughOrganization = isOrganizationManager(m.organizationRole);
          const you = m.userId === state.account.user.id;
          return (
            <Tr key={m.userId}>
              <Td first>
                <span className="block">
                  {m.name}
                  {you ? <span className="text-muted-foreground"> (you)</span> : null}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">{m.email}</span>
              </Td>
              <Td>
                {throughOrganization ? (
                  <span title={ORGANIZATION_ROLE_DESCRIPTIONS[m.organizationRole]}>
                    Admin in every workspace
                  </span>
                ) : admin && !you ? (
                  <SelectMenu
                    label={`Role for ${m.name}`}
                    size="small"
                    options={WORKSPACE_ROLE_OPTIONS}
                    value={m.role}
                    onChange={(role) =>
                      change.mutate({ userId: m.userId, role: role as WorkspaceRole })
                    }
                  />
                ) : (
                  <span title={WORKSPACE_ROLE_DESCRIPTIONS[m.role]}>{capital(m.role)}</span>
                )}
              </Td>
              <Td>{date(m.joinedAt)}</Td>
              <Td>
                {admin && !throughOrganization && !you ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => setRemoving({ userId: m.userId, name: m.name })}
                  >
                    Remove
                  </Button>
                ) : null}
              </Td>
            </Tr>
          );
        })}
      </Table>
      {!manager ? (
        <Muted small>
          To invite someone new, ask{' '}
          {askable.map((m) => m.name).join(' or ') || 'an organization admin'}.
        </Muted>
      ) : null}
      <Muted small>{roleLegend('workspace')}</Muted>
      {members.data.invitations.length ? (
        <Invitations
          invitations={members.data.invitations}
          organizationId={state.organization.id}
          canRevoke={manager}
          onChange={refresh}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''} from ${state.workspace.name}?`}
        description="They lose access at their next request. Agent keys they created keep working, and their past changes keep their name."
      >
        <Button
          variant="destructive"
          onClick={() => {
            if (!removing) return;
            accountApi
              .removeMember(state.workspace.id, removing.userId)
              .then(refresh, (e: Error) => setError(e.message))
              .finally(() => setRemoving(null));
          }}
        >
          Remove
        </Button>
      </Dialog>
      <AddMember
        open={adding}
        onOpenChange={setAdding}
        candidates={members.data.candidates}
        onAdd={(userId, role) => change.mutateAsync({ userId, role }).then(() => setAdding(false))}
      />
      <InviteDialog
        open={inviting}
        onOpenChange={(open) => {
          setInviting(open);
          if (!open) void refresh();
        }}
        organizationId={state.organization.id}
        workspace={{ id: state.workspace.id, name: state.workspace.name }}
        canInviteOwner={state.organization.role === 'owner'}
      />
    </Stack>
  );
}

function AddMember({
  open,
  onOpenChange,
  candidates,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: { userId: string; name: string; email: string }[];
  onAdd: (userId: string, role: WorkspaceRole) => Promise<void>;
}) {
  const [person, setPerson] = useState<string | null>(null),
    [role, setRole] = useState<WorkspaceRole>('editor');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add someone from your organization">
      <Stack>
        <SelectMenu
          label="Person"
          fill
          placeholder="Choose a person…"
          options={candidates.map((c) => ({
            value: c.userId,
            label: c.name || c.email,
            hint: c.email,
          }))}
          value={person}
          onChange={setPerson}
        />
        <SelectMenu
          label="Role"
          fill
          options={WORKSPACE_ROLE_OPTIONS}
          value={role}
          onChange={(v) => setRole(v as WorkspaceRole)}
        />
        <Button
          variant="primary"
          disabled={!person}
          onClick={() => person && void onAdd(person, role)}
        >
          Add
        </Button>
      </Stack>
    </Dialog>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  organizationId,
  workspace,
  canInviteOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** Invite to this workspace with a role; without it, to the organization only. */
  workspace?: { id: string; name: string };
  canInviteOwner: boolean;
}) {
  const [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [role, setRole] = useState<string>(workspace ? 'editor' : 'member');
  const providers = providerNames(useAccount()?.account.providers ?? []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = (e.currentTarget.elements.namedItem('email') as HTMLInputElement).value.trim();
    setError('');
    try {
      const organizationRole: OrganizationRole = workspace ? 'member' : (role as OrganizationRole);
      const created = await accountApi.invite(organizationId, {
        email,
        role: organizationRole,
        workspaces: workspace ? [{ workspaceId: workspace.id, role: role as WorkspaceRole }] : [],
      });
      setLink(created.link);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const roleOptions = workspace ? WORKSPACE_ROLE_OPTIONS : organizationRoleOptions(canInviteOwner);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setLink('');
          setError('');
        }
      }}
      title={workspace ? `Invite someone to ${workspace.name}` : 'Invite someone'}
      description={`Retainer gives you a link to send them. They sign in with the ${providers} account for that email to accept.`}
    >
      {link ? (
        <Stack>
          <div className="flex items-center gap-2">
            <Code>{link}</Code>
            <CopyButton value={link} label="Copy invitation link" />
          </div>
          <Muted small>The link works once, for 7 days. You won't see it again.</Muted>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </Stack>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <Stack>
            <Label htmlFor="invite-email">
              Email
              <Input id="invite-email" name="email" type="email" required autoFocus />
            </Label>
            <SelectMenu label="Role" fill options={roleOptions} value={role} onChange={setRole} />
            {error ? <Notice error>{error}</Notice> : null}
            <Button type="submit" variant="primary">
              Create invitation link
            </Button>
          </Stack>
        </form>
      )}
    </Dialog>
  );
}

function Invitations({
  invitations,
  organizationId,
  canRevoke,
  onChange,
}: {
  invitations: PendingInvitation[];
  organizationId: string;
  canRevoke: boolean;
  onChange: () => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Waiting to accept</h2>
      <Table
        headers={[{ label: 'Email' }, { label: 'Invited by' }, { label: 'Expires' }, { label: '' }]}
      >
        {invitations.map((i) => (
          <Tr key={i.id}>
            <Td first>{i.email}</Td>
            <Td>{i.invitedBy ?? '—'}</Td>
            <Td>{date(i.expiresAt)}</Td>
            <Td>
              {canRevoke ? (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() =>
                    void accountApi.revokeInvitation(organizationId, i.id).then(onChange)
                  }
                >
                  Revoke
                </Button>
              ) : null}
            </Td>
          </Tr>
        ))}
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function AgentsTab({ state }: { state: AccountState }) {
  const client = useQueryClient();
  const key = ['account', 'keys', state.workspace.id];
  const keys = useQuery({ queryKey: key, queryFn: () => accountApi.keys(state.workspace.id) });
  const [creating, setCreating] = useState(false),
    [revoking, setRevoking] = useState<WorkspaceKey | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const active = keys.data?.keys.filter((k) => !k.revokedAt) ?? [];
  return (
    <Stack>
      <div className="flex flex-wrap items-center gap-2">
        <Muted small>
          An API key lets an agent or app read and write this workspace. Its changes show under the
          key's name.
        </Muted>
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setCreating(true)}>
          Create key
        </Button>
      </div>
      {!keys.data ? (
        keys.error ? (
          <QueryError error={keys.error} retry={() => void keys.refetch()} />
        ) : (
          <Notice>Loading keys…</Notice>
        )
      ) : active.length === 0 ? (
        <Empty title="No API keys yet" description="Create one to connect an agent." />
      ) : (
        <Table headers={[{ label: 'Name' }, { label: 'Can' }, { label: 'Created' }, { label: '' }]}>
          {active.map((k) => (
            <Tr key={k.id}>
              <Td first>
                <span className="block">{k.name}</span>
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {k.prefix}…
                </span>
                {k.worksFor ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    Works for {k.worksFor.name}
                  </span>
                ) : null}
              </Td>
              <Td>{keyAccessWords(k.scopes)}</Td>
              <Td>
                {date(k.createdAt)}
                {k.createdBy ? (
                  <span className="text-muted-foreground"> by {k.createdBy.name}</span>
                ) : null}
              </Td>
              <Td>
                <Button size="small" variant="ghost" onClick={() => setRevoking(k)}>
                  Revoke
                </Button>
              </Td>
            </Tr>
          ))}
        </Table>
      )}
      <CreateKey
        open={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) void refresh();
        }}
        workspaceId={state.workspace.id}
      />
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? ''}?`}
        description="It stops working at once. Anything using it will need a new key."
      >
        <Button
          variant="destructive"
          onClick={() => {
            if (!revoking) return;
            void accountApi
              .revokeKey(state.workspace.id, revoking.id)
              .then(refresh)
              .finally(() => setRevoking(null));
          }}
        >
          Revoke
        </Button>
      </Dialog>
      <Panel title="Connected apps">
        <Stack>
          <Muted small>
            Apps people connected by signing in, such as Claude. Each works as the person who
            connected it, and never does more than they can here.
          </Muted>
          <ConnectedApps workspaceId={state.workspace.id} />
        </Stack>
      </Panel>
    </Stack>
  );
}

function CreateKey({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const [access, setAccess] = useState<KeyAccess>('write'),
    [worksForMe, setWorksForMe] = useState(false),
    [created, setCreated] = useState<string>(''),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value.trim();
    setError('');
    try {
      setCreated((await accountApi.createKey(workspaceId, { name, access, worksForMe })).key);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const origin = window.location.origin;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setCreated('');
          setError('');
          setWorksForMe(false);
        }
      }}
      title={created ? 'Your new key' : 'Create an API key'}
      description={
        created
          ? "Copy it now. You won't see it again; if it's lost, revoke it and create another."
          : 'Name it after the agent or app that will use it.'
      }
    >
      {created ? (
        <Stack>
          <div className="flex items-center gap-2">
            <Code>{created}</Code>
            <CopyButton value={created} label="Copy key" />
          </div>
          <Instructions title="Connect over MCP">
            {`URL: ${origin}/mcp\nHeader: Authorization: Bearer ${created}`}
          </Instructions>
          <Instructions title="Call the REST API">
            {`curl ${origin}/v1/me \\\n  -H "Authorization: Bearer ${created}"`}
          </Instructions>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </Stack>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <Stack>
            <Label htmlFor="key-name">
              Name
              <Input
                id="key-name"
                name="name"
                required
                maxLength={200}
                autoFocus
                placeholder="Sales agent"
              />
            </Label>
            <Segmented
              label="What it can do"
              value={access}
              options={KEY_ACCESS_OPTIONS}
              onChange={setAccess}
            />
            <Stack gap="small">
              <CheckLabel>
                <Input
                  type="checkbox"
                  checked={worksForMe}
                  onChange={(e) => setWorksForMe(e.target.checked)}
                />
                <span>This agent works for me</span>
              </CheckLabel>
              <Muted small>
                It can read and write your personal memory here, which only you and your agents see.
                Leave it off for a key a team or a service shares.
              </Muted>
            </Stack>
            {error ? <Notice error>{error}</Notice> : null}
            <Button type="submit" variant="primary">
              Create key
            </Button>
          </Stack>
        </form>
      )}
    </Dialog>
  );
}

function Instructions({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm font-medium">
        {title}
        <CopyButton value={children} label={`Copy: ${title}`} />
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{children}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function WorkspaceTab({ state }: { state: AccountState }) {
  const [error, setError] = useState('');
  const canDelete = isOrganizationManager(state.organization.role);
  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value.trim();
    setError('');
    try {
      await accountApi.renameWorkspace(state.workspace.id, name);
      // The name is in the sidebar and the switcher; a reload shows it everywhere.
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Stack>
      <Panel title="Name">
        <form onSubmit={(e) => void rename(e)}>
          <Stack>
            <Label htmlFor="workspace-name">
              Workspace name
              <Input
                id="workspace-name"
                name="name"
                required
                maxLength={200}
                defaultValue={state.workspace.name}
              />
            </Label>
            <Muted small>
              Its address stays {window.location.origin}
              {workspaceHref(state.workspace.slug)}, so links and agents keep working.
            </Muted>
            {error ? <Notice error>{error}</Notice> : null}
            <div>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </Stack>
        </form>
      </Panel>
      {canDelete ? <DeleteWorkspace state={state} /> : null}
    </Stack>
  );
}

/**
 * Deleting a workspace (4.5): for organization owners and admins, who type
 * its name to confirm. It is gone at once and removed for good 7 days later.
 */
function DeleteWorkspace({ state }: { state: AccountState }) {
  const [open, setOpen] = useState(false),
    [typed, setTyped] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const name = state.workspace.name;
  const matches = typed.trim() === name.trim();
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await accountApi.deleteWorkspace(state.workspace.id, typed);
      // Starts the app again outside this workspace, which no longer exists.
      window.location.assign('/app/');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Panel title="Delete workspace">
      <Stack>
        <Muted small>
          Everyone loses access at once, and its API keys and connected apps stop working. Its
          records, events and history are removed for good after 7 days. Until then, whoever runs
          this Retainer can bring it back.
        </Muted>
        <div>
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Delete workspace
          </Button>
        </div>
      </Stack>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped('');
            setError('');
          }
        }}
        title={`Delete ${name}?`}
        description="Everyone loses access at once. Its data is removed for good after 7 days."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (matches) void remove();
          }}
        >
          <Stack>
            <Label htmlFor="delete-workspace-name">
              Type the workspace's name to confirm
              <Input
                id="delete-workspace-name"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={name}
              />
            </Label>
            {error ? <Notice error>{error}</Notice> : null}
            <div>
              <Button type="submit" variant="destructive" disabled={!matches || busy}>
                Delete workspace
              </Button>
            </div>
          </Stack>
        </form>
      </Dialog>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

function OrganizationTab({ state }: { state: AccountState }) {
  const client = useQueryClient();
  const key = ['account', 'organization', state.organization.id];
  const details = useQuery({
    queryKey: key,
    queryFn: () => accountApi.organization(state.organization.id),
  });
  const [error, setError] = useState(''),
    [inviting, setInviting] = useState(false),
    [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const owner = state.organization.role === 'owner';
  if (!details.data)
    return details.error ? (
      <QueryError error={details.error} retry={() => void details.refetch()} />
    ) : (
      <Notice>Loading the organization…</Notice>
    );
  const org = details.data;
  const run = (action: Promise<unknown>) =>
    void action.then(refresh, (e: Error) => setError(e.message));
  return (
    <Stack>
      {error ? (
        <Notice error onDismiss={() => setError('')}>
          {error}
        </Notice>
      ) : null}
      <Panel title="Name">
        {owner ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value;
              run(accountApi.renameOrganization(org.id, name));
            }}
          >
            <Label htmlFor="organization-name">
              Organization name
              <Input id="organization-name" name="name" required defaultValue={org.name} />
            </Label>
            <Button type="submit">Save</Button>
          </form>
        ) : (
          <p className="text-sm">{org.name}</p>
        )}
      </Panel>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">People</h2>
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setInviting(true)}>
          Invite
        </Button>
      </div>
      <Table
        headers={[{ label: 'Person' }, { label: 'Role' }, { label: 'Workspaces' }, { label: '' }]}
      >
        {org.members.map((m) => {
          const you = m.userId === state.account.user.id;
          // Owners manage owners; owners and admins manage everyone else.
          const manageable = !you && (owner || m.role !== 'owner');
          return (
            <Tr key={m.userId}>
              <Td first>
                <span className="block">
                  {m.name}
                  {you ? <span className="text-muted-foreground"> (you)</span> : null}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">{m.email}</span>
              </Td>
              <Td>
                {manageable ? (
                  <SelectMenu
                    label={`Organization role for ${m.name}`}
                    size="small"
                    options={organizationRoleOptions(owner)}
                    value={m.role}
                    onChange={(role) =>
                      run(
                        accountApi.setOrganizationRole(org.id, m.userId, role as OrganizationRole),
                      )
                    }
                  />
                ) : (
                  <span title={ORGANIZATION_ROLE_DESCRIPTIONS[m.role]}>{capital(m.role)}</span>
                )}
              </Td>
              <Td>
                {m.role === 'member'
                  ? m.workspaces.map((w) => `${w.name} (${w.role})`).join(', ') || 'None yet'
                  : 'All, as admin'}
              </Td>
              <Td>
                {manageable ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => setRemoving({ userId: m.userId, name: m.name })}
                  >
                    Remove
                  </Button>
                ) : null}
              </Td>
            </Tr>
          );
        })}
      </Table>
      <Muted small>{roleLegend('organization')}</Muted>
      {org.invitations.length ? (
        <Invitations
          invitations={org.invitations}
          organizationId={org.id}
          canRevoke
          onChange={refresh}
        />
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Workspaces</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {org.workspaces.map((w) => (
            <li key={w.id}>
              <a className="underline" href={workspaceHref(w.slug)}>
                {w.name}
              </a>
              <span className="text-muted-foreground">
                {' '}
                · {w.members} {w.members === 1 ? 'member' : 'members'} besides owners and admins
              </span>
            </li>
          ))}
        </ul>
      </section>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''} from ${org.name}?`}
        description="This ends their role in every workspace at their next request. Agent keys they created keep working, and their past changes keep their name."
      >
        <Button
          variant="destructive"
          onClick={() => {
            if (removing) run(accountApi.removeFromOrganization(org.id, removing.userId));
            setRemoving(null);
          }}
        >
          Remove
        </Button>
      </Dialog>
      <InviteDialog
        open={inviting}
        onOpenChange={(open) => {
          setInviting(open);
          if (!open) void refresh();
        }}
        organizationId={org.id}
        canInviteOwner={owner}
      />
    </Stack>
  );
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}): ReactNode {
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value.trim();
    try {
      const workspace = await accountApi.createWorkspace({ name, organizationId });
      window.location.assign(workspaceHref(workspace.slug));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New workspace">
      <form onSubmit={(e) => void submit(e)}>
        <Stack>
          <Label htmlFor="new-workspace-name">
            Name
            <Input id="new-workspace-name" name="name" required maxLength={200} autoFocus />
          </Label>
          {error ? <Notice error>{error}</Notice> : null}
          <Button type="submit" variant="primary">
            Create workspace
          </Button>
        </Stack>
      </form>
    </Dialog>
  );
}
