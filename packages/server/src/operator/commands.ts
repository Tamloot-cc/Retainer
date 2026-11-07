import { parseArgs } from 'node:util';
import { createApiKey, listApiKeys, parseActor, parseScopes, revokeApiKey } from '../auth/keys.js';
import type { Sql } from '../db/client.js';
import { listOrganizations } from '../db/organizations.js';
import { listWorkspaces } from '../db/workspaces.js';
import { AppError } from '../errors.js';
import { TEMPLATE_NAMES } from '../templates/index.js';
import { purgeAfter, purgeDeletedWorkspaces, restoreWorkspace } from '../workspaces/deletion.js';
import {
  createOrganization,
  moveWorkspace,
  setOrganizationLimits,
  setOrganizationMember,
  setWorkspaceMember,
} from '../workspaces/organizations.js';
import { createWorkspace } from '../workspaces/workspaces.js';

export const USAGE = `Usage: retainer <command>

Workspaces
  retainer workspace create --name <name> [--slug <slug>] [--template <template>] [--org <id|name>]
  retainer workspace list
  retainer workspace move <slug|id> --org <id|name>
  retainer workspace restore <slug|id>     Undo a deletion within its 7 days
  retainer workspace purge                 Remove workspaces deleted over 7 days ago now

Organizations and people (accounts mode)
  retainer org create --name <name>
  retainer org list
  retainer org limit --org <id|name> [--workspaces <n|none>] [--members <n|none>]
  retainer member add --org <id|name> --email <email> --role <owner|admin|member>
  retainer member add --workspace <slug|id> --email <email> --role <viewer|editor|admin>

API keys
  retainer key create --workspace <slug|id> --name <name> --actor <type:id> --scopes <list>
  retainer key list --workspace <slug|id>
  retainer key revoke <key-id>

Options
  --json    Print machine-readable JSON
  --help    Show this help

Templates: ${TEMPLATE_NAMES.join(', ')}
Actor types: user, integration, agent, system   Scopes: read, write, schema:write, admin
The CLI connects to DATABASE_URL directly; there is no admin HTTP API.`;

export type CliIo = {
  /** A connection as the migration role (operator operations). */
  sql: Sql;
  out: (line: string) => void;
  err: (line: string) => void;
};

function required(value: string | undefined, flag: string): string {
  if (!value) throw new AppError(400, 'invalid_request', `missing --${flag}`);
  return value;
}

/**
 * Runs an operator command (ARCHITECTURE.md 7.1). Returns the exit code;
 * never calls process.exit, so tests can drive it in-process.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [group, command, ...rest] = positionals;
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data, null, 2) : human);

  if (values.help || !group) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    switch (`${group} ${command ?? ''}`) {
      case 'workspace create': {
        const workspace = await createWorkspace(io.sql, {
          name: required(values.name, 'name'),
          ...(values.slug ? { slug: values.slug } : {}),
          ...(values.template ? { template: values.template } : {}),
          ...(values.org ? { organization: values.org } : {}),
        });
        const template =
          workspace.templates.map((t) => t.name).join(', ') || 'none (the first agent picks one)';
        print(
          `Created workspace "${workspace.name}"\n  slug: ${workspace.slug}\n  id: ${workspace.id}\n  template: ${template}`,
          workspace,
        );
        return 0;
      }
      case 'workspace list': {
        const workspaces = await listWorkspaces(io.sql);
        print(
          workspaces.length === 0
            ? 'No workspaces.'
            : workspaces
                .map(
                  (w) =>
                    `${w.slug}\t${w.id}\t${w.name}\t${w.templates.map((t) => t.name).join(',') || '-'}` +
                    (w.deletionScheduledAt
                      ? `\tdeleted, removed for good after ${purgeAfter(new Date(w.deletionScheduledAt)).toISOString()}`
                      : ''),
                )
                .join('\n'),
          workspaces,
        );
        return 0;
      }
      case 'workspace move': {
        const moved = await moveWorkspace(io.sql, {
          workspace: required(rest[0] ?? values.workspace, 'workspace'),
          organization: required(values.org, 'org'),
        });
        print(
          `Moved to "${moved.organization.name}" (${moved.organization.id}).` +
            (moved.removedMembers > 0
              ? ` Removed ${moved.removedMembers} member role(s) from the old organization.`
              : ''),
          moved,
        );
        return 0;
      }
      case 'workspace restore': {
        const workspace = await restoreWorkspace(
          io.sql,
          required(rest[0] ?? values.workspace, 'workspace'),
        );
        print(`Restored workspace "${workspace.name}" (${workspace.slug}).`, workspace);
        return 0;
      }
      case 'workspace purge': {
        const report = await purgeDeletedWorkspaces(io.sql);
        print(
          `Removed ${report.purged} deleted workspace(s) for good.` +
            (report.failed > 0 ? ` ${report.failed} could not be removed; see the log.` : ''),
          report,
        );
        return report.failed > 0 ? 1 : 0;
      }
      case 'org create': {
        const organization = await createOrganization(io.sql, {
          name: required(values.name, 'name'),
        });
        print(
          `Created organization "${organization.name}"\n  id: ${organization.id}\n` +
            'Add its first owner with: retainer member add --org <id> --email <email> --role owner',
          organization,
        );
        return 0;
      }
      case 'org list': {
        const organizations = await listOrganizations(io.sql);
        print(
          organizations
            .map(
              (o) =>
                `${o.id}\t${o.name}\t${o.workspaces} workspace(s)\t${o.members} member(s)` +
                (o.owners === 0 ? '\tno owner' : ''),
            )
            .join('\n') || 'No organizations.',
          organizations,
        );
        return 0;
      }
      case 'org limit': {
        const limits: { workspaces?: number | null; members?: number | null } = {};
        for (const kind of ['workspaces', 'members'] as const) {
          const value = values[kind];
          if (value !== undefined) limits[kind] = parseLimit(value, kind);
        }
        if (Object.keys(limits).length === 0) {
          throw new AppError(400, 'invalid_request', 'give --workspaces, --members or both');
        }
        const set = await setOrganizationLimits(io.sql, {
          organization: required(values.org, 'org'),
          limits,
        });
        const limitLine = (kind: 'workspaces' | 'members') =>
          `${kind}: ${set.limits[kind] ?? 'no limit'}`;
        print(
          `Limits of "${set.organization.name}"\n  ${limitLine('workspaces')}\n  ${limitLine('members')}`,
          set,
        );
        return 0;
      }
      case 'member add': {
        const email = required(values.email, 'email');
        const role = required(values.role, 'role');
        if (values.workspace) {
          const member = await setWorkspaceMember(io.sql, {
            workspace: values.workspace,
            email,
            role,
          });
          print(`${email} is now ${member.role} in the workspace.`, member);
        } else {
          const member = await setOrganizationMember(io.sql, {
            organization: required(values.org, 'org'),
            email,
            role,
          });
          print(`${email} is now ${member.role} of "${member.organization.name}".`, member);
        }
        return 0;
      }
      case 'key create': {
        const key = await createApiKey(io.sql, {
          workspace: required(values.workspace, 'workspace'),
          name: required(values.name, 'name'),
          actor: parseActor(required(values.actor, 'actor')),
          scopes: parseScopes(required(values.scopes, 'scopes')),
        });
        print(
          [
            `Created key "${key.name}" (${key.id})`,
            `  actor: ${key.actor.type}:${key.actor.id}`,
            `  scopes: ${key.scopes.join(', ')}`,
            '',
            `  ${key.key}`,
            '',
            'Store it now: it is shown once and only its hash is kept.',
          ].join('\n'),
          key,
        );
        return 0;
      }
      case 'key list': {
        const keys = await listApiKeys(io.sql, required(values.workspace, 'workspace'));
        print(
          keys
            .map(
              (k) =>
                `${k.id}\t${k.prefix}…\t${k.name}\t${k.actor.type}:${k.actor.id}\t${k.scopes.join(',')}\t${k.revokedAt ? 'revoked' : 'active'}`,
            )
            .join('\n') || 'No keys.',
          keys,
        );
        return 0;
      }
      case 'key revoke': {
        const id = required(rest[0] ?? values.id, 'id');
        const revoked = await revokeApiKey(io.sql, id);
        print(`Revoked key ${revoked.id}`, revoked);
        return 0;
      }
      default:
        io.err(`Unknown command: retainer ${positionals.join(' ')}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof AppError) {
      io.err(`Error: ${error.message}`);
      if (error.details?.templates)
        io.err(`Templates: ${(error.details.templates as string[]).join(', ')}`);
      return 1;
    }
    if (error instanceof Error && error.name === 'SchemaValidationError') {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** A quota from the command line: a whole number, or `none` for no limit. */
function parseLimit(value: string, kind: string): number | null {
  if (value === 'none') return null;
  if (!/^\d+$/.test(value)) {
    throw new AppError(400, 'invalid_request', `--${kind} must be a whole number or none`);
  }
  return Number(value);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      template: { type: 'string' },
      workspace: { type: 'string' },
      org: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string' },
      actor: { type: 'string' },
      scopes: { type: 'string' },
      id: { type: 'string' },
      workspaces: { type: 'string' },
      members: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
