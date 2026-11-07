import { z } from 'zod';

/**
 * Who made a write. Decided by the credential (an API key, or in accounts
 * mode a person's session or an app's OAuth token), never by the caller's
 * payload.
 * Order matters: earlier types win when assertions about the same field
 * disagree (see ACTOR_PRECEDENCE).
 */
export const ACTOR_TYPES = ['user', 'integration', 'agent', 'system'] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export const actorSchema = z.object({
  type: z.enum(ACTOR_TYPES),
  id: z.string().min(1),
  name: z.string().optional(),
});

export type Actor = z.infer<typeof actorSchema>;

/** The same person, integration or agent. */
export const sameActor = (a: Pick<Actor, 'type' | 'id'>, b: Pick<Actor, 'type' | 'id'>) =>
  a.type === b.type && a.id === b.id;

/** Higher number wins. Same precedence: the latest assertion wins. */
export const ACTOR_PRECEDENCE: Record<ActorType, number> = {
  user: 4,
  integration: 3,
  agent: 2,
  system: 1,
};
