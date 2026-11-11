import type { Actor } from '@retainer/shared';

/**
 * An error the API returns as `{ error: { code, message, details } }`.
 * Messages are written for agents: they say what was wrong and what is
 * allowed, so the caller can retry.
 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string, details?: Record<string, unknown>) =>
  new AppError(404, 'not_found', `${what} not found`, details);

export const forbidden = (message: string) => new AppError(403, 'forbidden', message);

export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'invalid_request', message, details);

/**
 * Decisions only a person makes: reviewing, merging, forgetting. An agent's
 * key scope is not a person's approval (3).
 */
export function requireUser(actor: Actor, what: string): void {
  if (actor.type !== 'user') {
    throw forbidden(`only a user can ${what}; an agent's key scope is not a person's approval`);
  }
}

/**
 * Workspace and personal memory work only with the memory tools (personal
 * memory spec 4.4): any other tool given `workspace`, `me` or a profile's ID
 * says which tools take them.
 */
export const profileNotSupported = (id?: string) =>
  new AppError(
    422,
    'profile_not_supported',
    'workspace and me (workspace and personal memory) hold facts only: use them with ' +
      'remember, get_context and get_timeline (POST /v1/records/:id/facts, GET ' +
      '/v1/records/:id/context, GET /v1/records/:id/timeline, GET /v1/records/:id/facts), ' +
      'and remove a fact with DELETE /v1/facts/:id',
    {
      ...(id ? { id } : {}),
      tools: ['remember', 'get_context', 'get_timeline'],
    },
  );

/** `me` without a person behind the credential (personal memory spec 4.3, M10). */
export const noPerson = () =>
  new AppError(
    422,
    'no_person',
    'me is the personal memory of the person this agent works for, and this credential works ' +
      'for nobody: a signed-in person, an app a person connected over OAuth, or an API key ' +
      'created with "This agent works for me" has one. Use workspace for what everyone shares',
    { credentials: ['session', 'oauth', 'api_key_acts_for_user'] },
  );
