import { z } from 'zod';

/**
 * Agent tasks (agent spec §9): code hands the workspace agent instructions,
 * input and an answer shape, and gets back a typed answer. Shared by the
 * server, the routine runner, the extension SDK and the agent runtime.
 */

/**
 * The tool groups a task may use (§8.1, §9.1). Web fetch isn't offered in v1
 * (spec §2, the HIPAA-configured organization); `tools.<name>` names one
 * extension tool that reads.
 */
export const AGENT_TOOL_GROUPS = ['retainer.read', 'retainer.write', 'web.search'] as const;
export type AgentToolGroup = (typeof AGENT_TOOL_GROUPS)[number] | `tools.${string}`;

export const agentToolGroupSchema = z.union([
  z.enum(AGENT_TOOL_GROUPS),
  z.string().regex(/^tools\.[a-z][a-z0-9_]{0,99}$/) as z.ZodType<`tools.${string}`>,
]);

/** A task's limits (§10.1): the defaults, and the most a caller may ask for. */
export const AGENT_TASK_LIMITS = {
  maxSteps: 100,
  maxOutputTokens: 32_000,
  maxToolCalls: 500,
  webSearches: 100,
  /** Tasks one routine run may start (§10.1). */
  tasksPerRun: 10,
  /** Instructions, in characters. */
  instructionsChars: 20_000,
  /** The task's input, serialized. */
  inputBytes: 65_536,
  /** The answer, serialized. */
  answerBytes: 65_536,
} as const;

/** Lower limits a caller may pass (§9.1); never higher than the defaults. */
export const agentTaskLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(AGENT_TASK_LIMITS.maxSteps).optional(),
  maxToolCalls: z.number().int().min(0).max(AGENT_TASK_LIMITS.maxToolCalls).optional(),
  webSearches: z.number().int().min(0).max(AGENT_TASK_LIMITS.webSearches).optional(),
});

/**
 * An answer's JSON schema: the subset routine model calls take (object,
 * array, string, number, integer, boolean, null, `enum`, `required`,
 * `description`, `maxItems`).
 */
export type AgentOutputSchema =
  | {
      type: 'string' | 'number' | 'integer' | 'boolean' | 'null';
      description?: string;
      enum?: readonly (string | number)[];
    }
  | { type: 'array'; items: AgentOutputSchema; description?: string; maxItems?: number }
  | {
      type: 'object';
      properties: { readonly [key: string]: AgentOutputSchema };
      required?: readonly string[];
      description?: string;
    };

const scalarSchema = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'null']),
  description: z.string().max(2000).optional(),
  enum: z
    .array(z.union([z.string().max(500), z.number()]))
    .min(1)
    .max(200)
    .optional(),
});
export const agentOutputSchemaSchema: z.ZodType<AgentOutputSchema> = z.lazy(() =>
  z.union([
    scalarSchema,
    z.strictObject({
      type: z.literal('array'),
      items: agentOutputSchemaSchema,
      description: z.string().max(2000).optional(),
      maxItems: z.number().int().min(0).max(1000).optional(),
    }),
    z.strictObject({
      type: z.literal('object'),
      properties: z.record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
        agentOutputSchemaSchema,
      ),
      required: z.array(z.string()).optional(),
      description: z.string().max(2000).optional(),
    }),
  ]),
) as z.ZodType<AgentOutputSchema>;

/** What `retainer.ai.agent` and `agentClient().start` take (§9.1). */
export const agentTaskRequestSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(AGENT_TASK_LIMITS.instructionsChars),
  input: z.json().optional(),
  tools: z.array(agentToolGroupSchema).max(20),
  output: agentOutputSchemaSchema,
  limits: agentTaskLimitsSchema.optional(),
});
export type AgentTaskRequest = z.infer<typeof agentTaskRequestSchema>;

/**
 * How a task ended, when it gave no answer (§9.3): `ai.agent` throws the
 * code, and `onAgentResult` receives it.
 */
export const AGENT_TASK_ERROR_CODES = [
  'refused',
  'incomplete',
  'context_limit_reached',
  'model_unavailable',
  'timed_out',
  'invalid_output',
  'limit_reached',
  'cancelled',
  'failed',
] as const;
export type AgentTaskErrorCode = (typeof AGENT_TASK_ERROR_CODES)[number];

/** A task's result, as an extension function receives it on `invocation.agentResult`. */
export const agentResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ taskId: z.uuid(), status: z.literal('completed'), answer: z.json() }),
  z.strictObject({
    taskId: z.uuid(),
    status: z.literal('failed'),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  }),
]);
export type AgentResult = z.infer<typeof agentResultSchema>;

const PROVIDER_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
]);

/**
 * The schema the provider's structured output receives: its own keywords
 * only, every object closed. `fitAnswer` applies the rest (`maxItems`).
 */
export function providerSchema(schema: unknown, depth = 0): unknown {
  if (depth > 20 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).filter(([key]) => PROVIDER_KEYWORDS.has(key)),
  );
  if (out.type === 'object') {
    out.additionalProperties = false;
    const props = (out.properties ?? {}) as Record<string, unknown>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, providerSchema(value, depth + 1)]),
    );
  }
  if (out.type === 'array' && out.items) out.items = providerSchema(out.items, depth + 1);
  return out;
}

/** The answer held to the limits the provider can't take: an array keeps its first `maxItems`. */
export function fitAnswer(schema: unknown, value: unknown, depth = 0): unknown {
  if (depth > 20 || !schema || typeof schema !== 'object') return value;
  const s = schema as {
    type?: string;
    items?: unknown;
    maxItems?: unknown;
    properties?: Record<string, unknown>;
  };
  if (s.type === 'array' && Array.isArray(value)) {
    const max = typeof s.maxItems === 'number' && s.maxItems >= 0 ? s.maxItems : value.length;
    return value.slice(0, max).map((item) => fitAnswer(s.items, item, depth + 1));
  }
  if (s.type === 'object' && value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fitAnswer(s.properties?.[key], item, depth + 1),
      ]),
    );
  return value;
}

/**
 * Why a value doesn't match an answer schema, or null when it does. Checks
 * the subset `AgentOutputSchema` allows: types, `enum`, `required` and
 * closed objects.
 */
export function answerProblem(schema: AgentOutputSchema, value: unknown, at = '$'): string | null {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return `${at} should be an object`;
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) return `${at}.${key} is required`;
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties[key];
      if (!property) return `${at}.${key} is not in the schema`;
      const problem = answerProblem(property, item, `${at}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} should be an array`;
    for (const [index, item] of value.entries()) {
      const problem = answerProblem(schema.items, item, `${at}[${index}]`);
      if (problem) return problem;
    }
    return null;
  }
  const ok =
    schema.type === 'null'
      ? value === null
      : schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === schema.type;
  if (!ok)
    return `${at} should be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}`;
  if (schema.enum && !schema.enum.includes(value as string | number))
    return `${at} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`;
  return null;
}
