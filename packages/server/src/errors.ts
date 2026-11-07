import type { Actor } from '@retainer/shared';

/**
 * An error the API returns as `{ error: { code, message, details } }`.
 * Messages are written for agents: they say what was wrong and what is
 * allowed, so the caller can retry.
 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429 | 500 | 503,
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
