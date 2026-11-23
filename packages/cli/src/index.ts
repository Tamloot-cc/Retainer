#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  type CliAccount,
  type CliOrganization,
  type CliWorkspace,
  RetainerAccountClient,
  RetainerApiError,
} from '@retainer/sdk';
import { pinnedMcpAddress } from '@retainer/shared';
import {
  getTokens,
  KeyMode,
  LoginRequired,
  type LoginStatus,
  login,
  refreshWhileLocked,
  serverOrigin,
} from './oauth.js';
import { credentials, locked, loginFile, readJson, updateCredentials } from './store.js';

const commands = [
  [
    'login',
    '[--server <url>]',
    'Person · browser consent',
    'login --server https://retainer.tamloot.cc',
  ],
  ['wait', '<id>', 'Person · waits for a response', 'wait 01900000-0000-7000-8000-000000000000'],
  ['logout', '', 'Person · ends this login', 'logout'],
  ['whoami', '', 'Person · read', 'whoami'],
  [
    'elevate',
    '[--workspace <w> | --org <o>] [--minutes <n>] [--reason <text>] | --end',
    'Workspace or organization · browser approval to start',
    'elevate --workspace sales --reason "review duplicate deals"',
  ],
  ['workspaces', '', 'Person · read', 'workspaces'],
  ['use', '<workspace>', 'Workspace · saves default on this machine', 'use sales'],
  [
    'workspace create',
    '<name> [--org <o>] [--template <t>]',
    'Organization · elevation',
    'workspace create Support --org acme',
  ],
  [
    'workspace rename',
    '<name>',
    'Workspace · elevation',
    'workspace rename "Customer Support" --workspace support',
  ],
  [
    'workspace delete',
    '<workspace> [--approval <id>]',
    'Workspace · click each time',
    'workspace delete sandbox',
  ],
  ['mcp-address', '[<workspace>]', 'Workspace · read', 'mcp-address sales'],
  ['members', '', 'Workspace · read', 'members --workspace sales'],
  [
    'invite',
    '<email> [--org <o>] [--org-role <member|admin|owner>] [--workspace <w> --role <viewer|editor|admin>]… [--approval <id>]',
    'Organization · elevation, owner invitation needs a click',
    'invite ben@example.com --org acme --workspace sales --role editor',
  ],
  ['invitations', '[--org <o>]', 'Organization · read', 'invitations --org acme'],
  [
    'invitation revoke',
    '<id> [--org <o>]',
    'Organization · elevation',
    'invitation revoke <id> --org acme',
  ],
  [
    'role',
    '<email> --workspace <w> <viewer|editor|admin> | --org <o> <member|admin|owner>',
    'Workspace or organization · elevation, owner changes need a click',
    'role ben@example.com --workspace sales editor',
  ],
  [
    'remove',
    '<email> [--workspace <w> | --org <o>] [--approval <id>]',
    'Workspace or organization · elevation, removing an owner needs a click',
    'remove ben@example.com --workspace sales',
  ],
  ['keys', '', 'Workspace · read', 'keys --workspace sales'],
  [
    'key create',
    '<name> --access <read|write|schema> [--approval <id>]',
    'Workspace · click each time',
    'key create "Inbox agent" --access read --workspace sales',
  ],
  ['key revoke', '<id>', 'Workspace · elevation', 'key revoke <id> --workspace sales'],
  ['connections', '[--workspace <w>]', 'Person or workspace · read', 'connections'],
  ['disconnect', '<id>', 'Workspace · elevation', 'disconnect <id> --workspace sales'],
  ['review', '', 'Person or workspace · read', 'review --workspace sales'],
  ['review show', '<id>', 'Person or workspace · read', 'review show <id>'],
  [
    'duplicates merge',
    '<suggestion> --keep <record>',
    'Workspace · elevation',
    'duplicates merge <suggestion> --keep <record> --workspace sales',
  ],
  [
    'duplicates dismiss',
    '<suggestion>',
    'Workspace · elevation',
    'duplicates dismiss <suggestion> --workspace sales',
  ],
  ['pending accept', '<id>', 'Workspace · elevation', 'pending accept <id> --workspace sales'],
  ['pending reject', '<id>', 'Workspace · elevation', 'pending reject <id> --workspace sales'],
  ['schema-changes', '', 'Workspace · read', 'schema-changes --workspace sales'],
  [
    'schema-changes approve',
    '<id>',
    'Workspace · elevation',
    'schema-changes approve <id> --workspace sales',
  ],
  [
    'schema-changes reject',
    '<id>',
    'Workspace · elevation',
    'schema-changes reject <id> --workspace sales',
  ],
  ['extensions', '', 'Workspace · read', 'extensions --workspace sales'],
  ['extension show', '<id>', 'Workspace · read', 'extension show <id> --workspace sales'],
  [
    'extension install',
    '<name>',
    'Workspace · finishes in the web app',
    'extension install enrichment --workspace sales',
  ],
  [
    'extension configure',
    '<id>',
    'Workspace · finishes in the web app',
    'extension configure <id> --workspace sales',
  ],
  [
    'extension upgrade',
    '<id>',
    'Workspace · finishes in the web app',
    'extension upgrade <id> --workspace sales',
  ],
  [
    'extension disable',
    '<id>',
    'Workspace · elevation',
    'extension disable <id> --workspace sales',
  ],
  ['extension remove', '<id>', 'Workspace · elevation', 'extension remove <id> --workspace sales'],
  ['routines', '', 'Workspace · read', 'routines --workspace sales'],
  [
    'routine approve',
    '<id> <version>',
    'Workspace · finishes in the web app',
    'routine approve <routine> <version> --workspace sales',
  ],
  [
    'routine reject',
    '<id> <version>',
    'Workspace · elevation',
    'routine reject <routine> <version> --workspace sales',
  ],
  ['routine pause', '<id>', 'Workspace · elevation', 'routine pause <routine> --workspace sales'],
  [
    'routine resume',
    '<id>',
    'Workspace · elevation if the existing approval is still valid',
    'routine resume <routine> --workspace sales',
  ],
] as const;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      server: { type: 'string' },
      org: { type: 'string' },
      workspace: { type: 'string', multiple: true },
      minutes: { type: 'string' },
      reason: { type: 'string' },
      end: { type: 'boolean' },
      template: { type: 'string' },
      'org-role': { type: 'string' },
      role: { type: 'string', multiple: true },
      approval: { type: 'string' },
      access: { type: 'string' },
      keep: { type: 'string' },
    },
  });
}
type Options = ReturnType<typeof parse>['values'];
type Result = { data: unknown; exit?: number };
const waiting = (data: unknown): Result => ({ data, exit: 6 });
const done = (data: unknown): Result => ({ data });
class Usage extends Error {}
function required(value: string | undefined, name: string) {
  if (!value) throw new Usage(`Give ${name}.`);
  return value;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

class CommandContext {
  private identity?: Promise<CliAccount>;
  private tokens?: Promise<Awaited<ReturnType<typeof getTokens>>>;
  target?: { type: 'workspace' | 'org'; selector: string };
  routineUrl?: string;
  constructor(
    readonly server: string,
    readonly options: Options,
    readonly savedWorkspace?: string,
  ) {}
  async client(workspace?: CliWorkspace) {
    this.tokens ??= getTokens(this.server);
    return new RetainerAccountClient({
      baseUrl: this.server,
      accessToken: (await this.tokens).accessToken,
      ...(workspace ? { workspace: workspace.id } : {}),
      ...(this.options.approval ? { approval: this.options.approval } : {}),
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(29_000), redirect: 'error' }),
    });
  }
  account() {
    this.identity ??= this.client().then((client) => client.account());
    return this.identity;
  }
  explicitWorkspace() {
    if ((this.options.workspace?.length ?? 0) > 1) throw new Usage('Give one --workspace.');
    return this.options.workspace?.[0];
  }
  async workspace(selector?: string): Promise<CliWorkspace> {
    const flag = this.explicitWorkspace();
    const name = required(
      selector ?? flag ?? process.env.RETAINER_WORKSPACE ?? this.savedWorkspace,
      '--workspace <slug|id>',
    );
    const all = (await this.account()).organizations.flatMap(({ workspaces }) => workspaces);
    const workspace = all.find((w) => w.id === name || w.slug === name);
    if (!workspace)
      throw new Usage(`Workspace "${name}" is not available. Run retainer workspaces.`);
    if (flag && flag !== workspace.id && flag !== workspace.slug)
      throw new Usage('The workspace argument and --workspace refer to different targets.');
    this.target = { type: 'workspace', selector: workspace.slug };
    return workspace;
  }
  async organization(allowWorkspaceOptions = false): Promise<CliOrganization> {
    if (!allowWorkspaceOptions && this.options.workspace?.length)
      throw new Usage('Use --org for this organization command.');
    const all = (await this.account()).organizations.filter(({ role }) => role !== 'member');
    const name = this.options.org;
    const matches = name
      ? all.filter(
          (org) =>
            org.id === name ||
            org.name.toLowerCase() === name.toLowerCase() ||
            org.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '') === name.toLowerCase(),
        )
      : all;
    if (matches.length !== 1 || !matches[0])
      throw new Usage('Give --org <slug|id> for an organization you manage. Run retainer whoami.');
    const org = matches[0];
    this.target = { type: 'org', selector: org.id };
    return org;
  }
  workspacePage(workspace: CliWorkspace, route: string) {
    return `${this.server}/app/w/${encodeURIComponent(workspace.slug)}/${route}`;
  }
}

async function waitFor(ctx: CommandContext, id: string) {
  if (!uuid.test(id)) throw new Usage('Give the ID printed by login or an approval request.');
  const file = await readJson<LoginStatus>(loginFile(id));
  const deadline = Date.now() + 600_000;
  if (file) {
    for (;;) {
      const status = await readJson<LoginStatus>(loginFile(id));
      if (status?.status === 'done') {
        await rm(loginFile(id), { force: true });
        return done({ id, server: status.server, status: 'done' });
      }
      if (status?.status === 'denied') return { data: { id, status: 'denied' }, exit: 7 };
      if (status?.status === 'failed')
        throw new Error('The browser could not complete login. Run retainer login again.');
      if (status?.status === 'expired' || Date.now() >= Date.parse(file.expiresAt)) break;
      await delay(250);
    }
  } else {
    const api = await ctx.client();
    for (;;) {
      const approval = await api.approval(id);
      if (approval.status === 'approved' || approval.status === 'used') return done(approval);
      if (approval.status === 'denied' || approval.status === 'ended')
        return { data: approval, exit: 7 };
      if (approval.status === 'expired' || Date.now() >= deadline) break;
      await delay(600);
    }
  }
  return { data: { id, status: 'expired' }, exit: 5 };
}

async function getReview(ctx: CommandContext, id?: string) {
  const account = await ctx.account();
  const workspaces = ctx.explicitWorkspace()
    ? [await ctx.workspace()]
    : account.organizations.flatMap((org) => org.workspaces);
  for (const workspace of id ? workspaces : []) {
    const api = await ctx.client(workspace);
    const tryRead = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof RetainerApiError) || error.status !== 404) throw error;
      }
    };
    const [assertion, schemaChange, routine, extension] = await Promise.all([
      tryRead(() => api.assertion(id ?? '')),
      tryRead(() => api.schemaChange(id ?? '')),
      tryRead(() => api.routine(id ?? '')),
      tryRead(() => api.extension(id ?? '')),
    ]);
    if (assertion) return { workspace, assertion, record: await api.record(assertion.recordId) };
    if (schemaChange || routine || extension)
      return { workspace, schemaChange, routine, extension };
    for (let cursor: string | undefined; ; ) {
      const page = await api.review({
        limit: 100,
        ...(cursor ? { mergeSuggestionsCursor: cursor } : {}),
      });
      const suggestion = page.mergeSuggestions.find((entry) => entry.id === id);
      if (suggestion) return { workspace, suggestion };
      cursor = page.nextCursors.mergeSuggestions ?? undefined;
      if (!cursor) break;
    }
  }
  if (id) throw new Usage('That review item was not found. Run retainer review.');
  return {
    workspaces: await Promise.all(
      workspaces.map(async (workspace) => {
        const api = await ctx.client(workspace);
        const [inbox, schemaChanges, routines, extensions] = await Promise.all([
          api.review({ limit: 100 }),
          api.schemaChanges({ status: 'proposed', limit: 100 }),
          api.routines(),
          api.extensions(),
        ]);
        return {
          workspace,
          inbox,
          schemaChanges,
          routines: routines.routines.filter((routine) => routine.proposals > 0),
          extensions: extensions.installations,
        };
      }),
    ),
  };
}

async function execute(ctx: CommandContext, command: string, args: string[]): Promise<Result> {
  const { options, server } = ctx;
  const first = () => required(args[0], 'the command argument');
  switch (command) {
    case 'login':
      return waiting(await login(server));
    case 'wait':
      return waitFor(ctx, first());
    case 'logout': {
      let warning: string | undefined;
      await locked(server, async () => {
        try {
          const { accessToken } = await refreshWhileLocked(server);
          const api = new RetainerAccountClient({
            baseUrl: server,
            accessToken,
            fetch: (input, init) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' }),
          });
          await api.logout();
        } catch {
          warning = 'Disconnect this CLI login from Connected apps in Your account.';
        }
        await updateCredentials((file) => {
          delete file.servers[server];
          if (file.lastServer === server) {
            const replacement = Object.keys(file.servers).at(-1);
            if (replacement) file.lastServer = replacement;
            else delete file.lastServer;
          }
        });
      });
      return done({ server, signedOut: true, warning });
    }
    case 'whoami': {
      const account = await ctx.account();
      const selector =
        ctx.explicitWorkspace() ?? process.env.RETAINER_WORKSPACE ?? ctx.savedWorkspace;
      const workspace = selector
        ? account.organizations
            .flatMap((o) => o.workspaces)
            .find((w) => w.id === selector || w.slug === selector)
        : undefined;
      return done({
        ...account,
        server,
        workspace: workspace ?? null,
        elevations: (account.elevations ?? []).map((value) => ({
          ...value,
          secondsLeft: Math.max(0, Math.floor((Date.parse(value.expiresAt) - Date.now()) / 1000)),
        })),
      });
    }
    case 'workspaces':
      return done({
        workspaces: (await ctx.account()).organizations.flatMap((org) => org.workspaces),
      });
    case 'review':
      return done(await getReview(ctx));
    case 'review show':
      return done(await getReview(ctx, first()));
    case 'elevate': {
      const organization = options.org ? await ctx.organization() : null;
      const workspace = organization ? null : await ctx.workspace();
      const target = organization
        ? { organizationId: organization.id }
        : { workspaceId: workspace?.id ?? '' };
      const api = await ctx.client(workspace ?? undefined);
      if (options.end) {
        const approvals = ((await ctx.account()).elevations ?? []).filter((e) =>
          'organizationId' in target
            ? e.organizationId === target.organizationId
            : e.workspaceId === target.workspaceId,
        );
        await Promise.all(approvals.map((e) => api.endElevation(e.id)));
        return done({ ...target, ended: approvals.map((e) => e.id) });
      }
      const minutes = options.minutes === undefined ? undefined : Number(options.minutes);
      if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60))
        throw new Usage('--minutes must be an integer from 1 to 60.');
      return waiting(
        await api.startElevation({
          ...target,
          ...(minutes ? { minutes } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        }),
      );
    }
    case 'connections':
      if (!ctx.explicitWorkspace()) return done(await (await ctx.client()).connections());
      break;
    case 'invite':
    case 'invitations':
    case 'invitation revoke':
    case 'workspace create': {
      const organization = await ctx.organization(command === 'invite');
      const api = await ctx.client();
      const named = { organization: { id: organization.id, name: organization.name } };
      if (command === 'invitations')
        return done({ ...named, ...(await api.invitations(organization.id)) });
      if (command === 'invitation revoke') {
        await api.revokeInvitation(organization.id, first());
        return done({ ...named, revoked: first() });
      }
      if (command === 'workspace create')
        return done({
          ...named,
          ...(await api.createWorkspace({
            name: first(),
            organizationId: organization.id,
            ...(options.template ? { template: options.template } : {}),
          })),
        });
      const workspaces = options.workspace ?? [];
      const roles = options.role ?? [];
      if (workspaces.length !== roles.length)
        throw new Usage('Give one --role for each invited --workspace.');
      const grants = workspaces.map((selector, index) => {
        const workspace = organization.workspaces.find(
          (w) => w.id === selector || w.slug === selector,
        );
        if (!workspace) throw new Usage(`Workspace "${selector}" is outside this organization.`);
        return { workspaceId: workspace.id, role: required(roles[index], '--role') };
      });
      return done({
        ...named,
        ...(await api.invite(organization.id, {
          email: first(),
          role: options['org-role'] ?? 'member',
          workspaces: grants,
        })),
      });
    }
    case 'role':
    case 'remove': {
      const organization = options.org ? await ctx.organization() : undefined;
      const workspace = organization ? undefined : await ctx.workspace();
      const api = await ctx.client(workspace);
      const listing = organization
        ? await api.organization(organization.id)
        : await api.members(workspace?.id ?? '');
      const email = first().toLowerCase();
      const candidates = 'candidates' in listing ? listing.candidates : [];
      const member = [
        ...listing.members,
        ...(Array.isArray(candidates) ? (candidates as typeof listing.members) : []),
      ].find((m) => m.email.toLowerCase() === email);
      if (!member) throw new Usage('That member was not found in this target.');
      const target = organization
        ? { organizationId: organization.id }
        : { workspaceId: workspace?.id ?? '' };
      if (command === 'role')
        await api.setMemberRole(target, member.userId, required(args[1], 'the new role'));
      else await api.removeMember(target, member.userId);
      return done({
        ...target,
        userId: member.userId,
        email: member.email,
        role: command === 'role' ? args[1] : null,
      });
    }
  }

  const workspace = await ctx.workspace(
    ['workspace delete', 'mcp-address', 'use'].includes(command) ? args[0] : undefined,
  );
  const api = await ctx.client(workspace);
  const wrap = (value: unknown) => done({ workspace, result: value });
  const extensionPath = (suffix: string) =>
    ctx.workspacePage(workspace, `extensions/${encodeURIComponent(first())}${suffix}`);
  const routinePath = () => ctx.workspacePage(workspace, `routines/${encodeURIComponent(first())}`);
  switch (command) {
    case 'use':
      first();
      await locked(server, () =>
        updateCredentials((file) => {
          const saved = file.servers[server];
          if (!saved) throw new LoginRequired();
          saved.workspace = workspace.id;
        }),
      );
      return wrap({ selected: true });
    case 'mcp-address':
      return wrap({ url: pinnedMcpAddress(server, workspace.id) });
    case 'workspace rename':
      return wrap(await api.renameWorkspace(workspace.id, first()));
    case 'workspace delete':
      first();
      return wrap(await api.deleteWorkspace(workspace.id, workspace.name));
    case 'members':
      return wrap(await api.members(workspace.id));
    case 'keys':
      return wrap(await api.keys(workspace.id));
    case 'key create':
      return wrap(await api.createKey(workspace.id, first(), required(options.access, '--access')));
    case 'key revoke':
      await api.revokeKey(workspace.id, first());
      return wrap({ revoked: first() });
    case 'connections':
      return wrap(await api.connections(workspace.id));
    case 'disconnect':
      await api.disconnect(first(), workspace.id);
      return wrap({ disconnected: first() });
    case 'duplicates merge':
      return wrap(await api.mergeSuggestion(first(), required(options.keep, '--keep')));
    case 'duplicates dismiss':
      return wrap(await api.dismissMergeSuggestion(first()));
    case 'pending accept':
      return wrap(await api.decideAssertion(first(), 'accept'));
    case 'pending reject':
      return wrap(await api.decideAssertion(first(), 'reject'));
    case 'schema-changes':
      return wrap(await api.schemaChanges());
    case 'schema-changes approve':
    case 'schema-changes reject': {
      const result = await api.decideSchemaChange(
        first(),
        command.endsWith('approve') ? 'approve' : 'reject',
      );
      return { data: { workspace, result }, ...(result.status === 'failed' ? { exit: 1 } : {}) };
    }
    case 'extensions':
      return wrap(await api.extensions());
    case 'extension show':
      return wrap(await api.extension(first()));
    case 'extension disable':
      return wrap(await api.disableExtension(first()));
    case 'extension remove':
      return wrap(await api.uninstallExtension(first()));
    case 'extension install': {
      const name = first();
      const catalog = await api.extensionCatalog();
      const release = catalog.releases.find(
        ({ manifest }) =>
          manifest.universalId === name || manifest.name.toLowerCase() === name.toLowerCase(),
      );
      if (!release) throw new Usage('This extension is not in the workspace catalog.');
      return waiting({
        url: ctx.workspacePage(
          workspace,
          `extensions/new/${encodeURIComponent(release.manifest.universalId)}`,
        ),
      });
    }
    case 'extension configure': {
      const extension = await api.extension(first());
      return waiting({
        url:
          extension.state === 'configuring'
            ? ctx.workspacePage(
                workspace,
                `extensions/new/${encodeURIComponent(extension.registrationId)}`,
              )
            : extensionPath('/bindings'),
      });
    }
    case 'extension upgrade':
      return waiting({ url: extensionPath('/upgrade') });
    case 'routines':
      return wrap(await api.routines());
    case 'routine approve': {
      const version = required(args[1], 'the version');
      return waiting({ url: `${routinePath()}?version=${encodeURIComponent(version)}` });
    }
    case 'routine reject': {
      const requested = required(args[1], 'the version');
      const version = /^\d+$/.test(requested)
        ? (await api.routine(first())).versions.find((v) => v.number === Number(requested))?.id
        : requested;
      return wrap(
        await api.decideRoutineVersion(
          first(),
          required(version, 'a version available for review'),
          'reject',
        ),
      );
    }
    case 'routine pause':
      return wrap(await api.setRoutineState(first(), 'pause'));
    case 'routine resume':
      ctx.routineUrl = routinePath();
      return wrap(await api.setRoutineState(first(), 'resume'));
    default:
      throw new Usage('Use retainer --help to choose a command.');
  }
}

const help = () => ({
  usage: 'retainer <command> [--server <url>] [--workspace <slug|id>] [--json]',
  commands: commands.map(([command, args, target, example]) => ({
    command,
    args,
    target,
    example: `retainer ${example}`,
  })),
});
function print(result: unknown, json: boolean) {
  if (json) console.log(JSON.stringify(result));
  else if (result && typeof result === 'object' && 'usage' in result) {
    const description = result as ReturnType<typeof help>;
    console.log(description.usage);
    for (const item of description.commands) {
      console.log(`\n  ${item.command} ${item.args}\n    ${item.target}\n    ${item.example}`);
    }
  } else if (result && typeof result === 'object') {
    console.table(
      Object.fromEntries(
        Object.entries(result).map(([key, value]) => [
          key,
          typeof value === 'object' ? JSON.stringify(value, null, 2) : value,
        ]),
      ),
    );
  } else console.log(result);
}

async function main(argv: string[]) {
  let json = !process.stdout.isTTY || argv.includes('--json');
  let ctx: CommandContext | undefined;
  let command = '';
  try {
    const parsed = parse(argv);
    json ||= parsed.values.json === true;
    if (parsed.values.help) {
      print(help(), json);
      return 0;
    }
    const [group, subcommand, ...tail] = parsed.positionals;
    const twoWords = `${group} ${subcommand}`;
    const pair = commands.some(([name]) => name === twoWords);
    command = pair ? twoWords : (group ?? '');
    if (!commands.some(([name]) => name === command))
      throw new Usage('Choose a command with retainer --help.');
    const file = await credentials();
    const server = serverOrigin(
      parsed.values.server ??
        process.env.RETAINER_URL ??
        file.lastServer ??
        'https://retainer.tamloot.cc',
    );
    ctx = new CommandContext(server, parsed.values, file.servers[server]?.workspace);
    const result = await execute(ctx, command, pair ? tail : parsed.positionals.slice(1));
    print(result.data, json);
    return result.exit ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The command failed.';
    if (error instanceof KeyMode) {
      print({ error: 'key_mode', message, next: 'retainer-ops --help' }, json);
      return 1;
    }
    if (
      error instanceof RetainerApiError &&
      error.code === 'confirmation_required' &&
      error.details
    ) {
      const { id, url, expiresAt } = error.details;
      print({ id, url, expiresAt }, json);
      return 6;
    }
    if (
      error instanceof RetainerApiError &&
      error.code === 'approval_required' &&
      ctx?.routineUrl
    ) {
      print({ url: ctx.routineUrl }, json);
      return 6;
    }
    const loginNeeded =
      error instanceof LoginRequired || (error instanceof RetainerApiError && error.status === 401);
    const usage =
      error instanceof Usage ||
      (error instanceof Error &&
        'code' in error &&
        String(error.code).startsWith('ERR_PARSE_ARGS'));
    const elevation = error instanceof RetainerApiError && error.code === 'elevation_required';
    const next =
      loginNeeded || command === 'login'
        ? `retainer login${ctx ? ` --server ${quote(ctx.server)}` : ''}`
        : elevation && ctx?.target
          ? `retainer elevate --${ctx.target.type} ${quote(ctx.target.selector)} --reason ${quote(command)}`
          : 'retainer --help';
    print(
      {
        error: loginNeeded
          ? 'not_logged_in'
          : usage
            ? 'invalid_usage'
            : error instanceof RetainerApiError
              ? error.code
              : 'request_failed',
        message,
        next,
      },
      json,
    );
    return loginNeeded ? 3 : usage ? 2 : elevation ? 4 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
