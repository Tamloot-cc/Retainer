import { WORKSPACE_ROLE_SCOPES } from '@retainer/shared';
import { createMiddleware } from 'hono/factory';
import { CLI_VIA } from '../db/cli.js';
import { forbidden } from '../errors.js';
import type { AppEnv } from '../http/response.js';

const id = '[0-9a-fA-F-]{36}';
const v1Reads = new RegExp(
  `^/v1/(review|assertions/${id}|schema(?:/changes(?:/${id})?)?|extensions(?:/catalog|/${id})?|routines(?:/${id})?|records/${id}(?:/assertions)?)$`,
);
const v1Decisions = new RegExp(
  `^/v1/(assertions/${id}/(?:accept|reject)|review/merges/${id}/(?:merge|dismiss)|schema/changes/${id}/(?:approve|reject)|routines/${id}/(?:versions/${id}/reject|pause|resume)|extensions/${id}/(?:disable|uninstall))$`,
);

/**
 * Chats with the workspace agent (agent spec §6.7): the CLI reaches them as
 * itself, never as the person. The agent writes only while the login is
 * elevated, checked at each write, and never reaches a decision route.
 */
const agentChats = new RegExp(`^/v1/agent/chats(?:/${id}(?:/(token|cancel))?)?$`);
function agentChatRoute(method: string, path: string): boolean {
  const match = agentChats.exec(path);
  if (!match) return false;
  const action = match[1];
  if (path === '/v1/agent/chats') return method === 'GET' || method === 'POST';
  if (action) return method === 'POST';
  return method === 'GET' || method === 'DELETE';
}

export function admitCliRoutes() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const caller = c.get('caller');
    if (!caller.cli) return next();
    const { method, path } = c.req;
    if (method === 'GET' && v1Reads.test(path)) return next();
    if (agentChatRoute(method, path)) return next();
    if (method !== 'POST' || !v1Decisions.test(path)) {
      throw forbidden('The Retainer CLI cannot call this route.');
    }
    const { userId, userName, role } = caller.cli;
    c.set('caller', {
      ...caller,
      actor: { type: 'user', id: userId, name: userName, via: CLI_VIA },
      scopes: WORKSPACE_ROLE_SCOPES[role],
      userId,
    });
    await next();
  });
}

const accountReads = new RegExp(
  `^/account(?:/?|/connections|/organizations/${id}(?:/invitations)?|/workspaces/${id}/(?:members|keys|connections))$`,
);
const accountPosts = new RegExp(
  `^/account/(cli/approvals(?:/${id}/end)?|workspaces(?:/${id}/keys)?|organizations/${id}/invitations)$`,
);
const accountPatches = new RegExp(
  `^/account/(workspaces/${id}|organizations/${id}/members/${id})$`,
);
const accountPuts = new RegExp(`^/account/workspaces/${id}/members/${id}$`);
const accountDeletes = new RegExp(
  `^/account/(cli/login|connections/${id}|workspaces/${id}(?:/(?:members|keys|connections)/${id})?|organizations/${id}/(?:members|invitations)/${id})$`,
);
const approvalStatus = new RegExp(`^/account/cli/approvals/${id}$`);

export function allowsCliAccountRoute(method: string, path: string): boolean {
  return (
    (method === 'GET' && (accountReads.test(path) || approvalStatus.test(path))) ||
    (method === 'POST' && accountPosts.test(path)) ||
    (method === 'PATCH' && accountPatches.test(path)) ||
    (method === 'PUT' && accountPuts.test(path)) ||
    (method === 'DELETE' && accountDeletes.test(path))
  );
}
