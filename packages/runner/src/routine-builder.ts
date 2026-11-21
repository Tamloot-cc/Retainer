import { rm } from 'node:fs/promises';
import type {
  RoutineCapabilities,
  RoutineEffectResponse,
  RoutineProblem,
  RoutineRunContext,
} from '@retainer/shared';
import type { RoutineApi, RoutineOutcome } from './routine.js';
import { typeCheck } from './routine.js';

/** Attempts the builder makes before it reports what still fails. */
const ATTEMPTS = 3;

type Draft = {
  verdict: 'full' | 'partial' | 'not_possible';
  gaps: { part: string; reason: string; fix: string }[];
  name: string;
  summary: string;
  manifest: string;
  code: string;
  /** Whether the description asks to act at most once for each record. */
  oncePerRecord?: boolean;
};

const MANIFEST_GUIDE = `A routine is a manifest plus TypeScript code.

The manifest is JSON:
{
  "when": one of
    { "kind": "record", "object": "<object name>", "on": ["created" | "updated" | "links"], "fields"?: ["<field key>"], "oncePerRecord"?: true }
    { "kind": "schedule", "cron": "<5-field cron, at least 15 minutes apart>", "object"?: "<object name>", "filter"?: <filter>, "oncePerRecord"?: true }
    { "kind": "manual", "object": "<object name>", "label": "<button label>", "oncePerRecord"?: true }
  "if"?: <filter>,           // checked by Retainer before the code runs; the code never starts when it fails
  "expiry"?: { "field": "<date field key>" },  // the run is dropped once this date passes
  "uses": { "tools": ["<tool name>"], "model": true | false }
}
"links" fires when an event gains a participant or about link (event types only).
A filter uses field keys: { "<key>": { "eq" | "neq" | "in" | "contains" | "gt" | "gte" | "lt" | "lte" | "isNull": value }, "and"?: [...], "or"?: [...], "not"?: {...} }. Only filterable fields can be filtered.
"oncePerRecord": true makes Retainer act at most once for each record, ever: the record is used up by the run's first write or tool call. Set it whenever the description says to act once per record ("only once per project", "at most once for each conversation", "don't do it again"), and whenever a record or manual routine creates records from the triggering record, unless the description wants it to act again on later changes or presses. A check in the code alone is not enough: the admin who approves sees Retainer's facts, which come from the manifest.

The code:
- exports one function: export async function main({ retainer, record, run, trigger }: RoutineContext<'<object name>'>) { ... }
  (RoutineContext without a type argument when there is no object).
- has no imports; retainer is the only way to read or change anything.
- reads "now" from run.at, never from the clock; formats dates in run.timezone.
- reads and writes values by field key, as the types show.
- calls only the tools the manifest lists, and retainer.ai.generate only when uses.model is true.
- returns a short JSON summary of what it did.
- keeps conditions that only depend on the record in the manifest's "if", not in the code.
- in a model call's output schema, uses only type, description, enum, properties, required, items and maxItems; Retainer enforces maxItems on the answer.
- in a dry run (run.dryRun), gets writes back in their usual shape, but nothing is written.`;

function instructions(
  caps: Omit<RoutineCapabilities, 'types' | 'typesFingerprint'>,
  types: string,
) {
  return `You write Retainer routines: small automations a person describes in plain words. Write the routine that does what the description asks, using only what this workspace has.

${MANIFEST_GUIDE}

The workspace's time zone is ${caps.timezone}. ${caps.model.available ? 'A model is available to routine code.' : 'No model is available: routine code cannot call retainer.ai.generate.'}
Limits: ${JSON.stringify(caps.limits)}.

The SDK's types, generated from this workspace:
\`\`\`ts
${types}
\`\`\`

Report honestly how much of the description the routine does: "full", "partial" (list each gap) or "not_possible" (then manifest and code may be empty strings). "full" means every action and every rule the description states is done, and each rule Retainer can enforce (a condition, "once per record", a schedule) is in the manifest. Each gap names the part of the description, a reason from ${JSON.stringify(caps.gapCodes)}, and what would make it possible (a field to add, an extension to install). Never pretend: if a field, object, tool or model the description needs is missing, it is a gap.

name: a short name for the routine. summary: one sentence, in plain words, of what the routine does.
When the input lists problems with a previous attempt, fix every one of them.`;
}

const outputSchema = (gapCodes: readonly string[]) => ({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['full', 'partial', 'not_possible'] },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          part: { type: 'string' },
          reason: { type: 'string', enum: [...gapCodes] },
          fix: { type: 'string' },
        },
        required: ['part', 'reason', 'fix'],
      },
    },
    name: { type: 'string' },
    summary: { type: 'string' },
    manifest: { type: 'string', description: 'The manifest, as a JSON string.' },
    code: { type: 'string', description: 'The TypeScript code.' },
    oncePerRecord: {
      type: 'boolean',
      description:
        'Whether the description asks to act at most once for each record, ever ("only once per project"). False for a frequency ("once a week per deal") and for "once" meaning "as soon as".',
    },
  },
  required: ['verdict', 'gaps', 'name', 'summary', 'manifest', 'code', 'oncePerRecord'],
});

/**
 * The builder says whether the description asks to act at most once per
 * record; the manifest must then carry `oncePerRecord`, where Retainer
 * enforces it and the approver reads it (routines spec §4.2). The model
 * reads the description, so a phrasing such as "once a week" or "only once
 * the deal has an amount" is its call, not a pattern's.
 */
export function onceProblems(
  oncePerRecord: boolean | undefined,
  manifest: unknown,
): RoutineProblem[] {
  const when = (manifest as { when?: { kind?: string; object?: string; oncePerRecord?: boolean } })
    ?.when;
  if (!oncePerRecord || !when || when.oncePerRecord) return [];
  if (when.kind === 'schedule' && !when.object) return [];
  return [
    {
      part: 'manifest',
      at: 'when.oncePerRecord',
      code: 'once_not_in_manifest',
      message:
        'you said the description asks to act once per record: set "oncePerRecord": true in "when", so Retainer enforces it and shows it to the approver',
    },
  ];
}

/**
 * The built-in builder (routines spec §5.1): the description in, a checked
 * proposal out. It goes through the same checks as any agent's routine, and
 * cannot approve. Every model call is a numbered effect of the build run, so
 * it counts against the workspace's daily model calls.
 */
export async function buildRoutine(
  api: RoutineApi,
  context: RoutineRunContext,
  signal: AbortSignal,
): Promise<RoutineOutcome> {
  const description = context.build?.description ?? '';
  const caps = await api.call<RoutineCapabilities>('GET', 'capabilities');
  const { types, typesFingerprint, ...facts } = caps;
  const system = instructions(facts, types);
  let previous: { draft: Draft; problems: RoutineProblem[] } | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const response = await api.call<RoutineEffectResponse>('POST', 'effects', {
      position: attempt,
      operation: 'ai.generate',
      // The prompt is long; the effect records what the call was for.
      args: { purpose: 'build', attempt },
    });
    let draft: Draft;
    if (response.state === 'done') draft = response.result as Draft;
    else if (response.state === 'model') {
      draft = (await api.model(response.model, {
        system,
        user: JSON.stringify({
          description,
          ...(previous
            ? {
                previousAttempt: {
                  manifest: previous.draft.manifest,
                  code: previous.draft.code,
                },
                problems: previous.problems,
              }
            : {}),
        }),
        schema: outputSchema(caps.gapCodes),
      })) as Draft;
      await api.call('POST', `effects/${attempt}/result`, { result: draft });
    } else return { outcome: 'failed', code: 'builder_failed' };
    const report = { verdict: draft.verdict, gaps: draft.gaps };
    if (draft.verdict === 'not_possible') return { outcome: 'succeeded', report, proposed: false };
    let manifest: unknown;
    try {
      manifest = JSON.parse(draft.manifest);
    } catch {
      previous = {
        draft,
        problems: [{ part: 'manifest', code: 'invalid_manifest', message: 'not valid JSON' }],
      };
      continue;
    }
    const checked = await api.call<{
      manifest: unknown;
      problems: RoutineProblem[];
      typesFingerprint: string;
      contextType?: string;
    }>('POST', 'build/check', { manifest, code: draft.code });
    let problems = [...checked.problems, ...onceProblems(draft.oncePerRecord, manifest)];
    if (!problems.length) {
      const typed = await typeCheck(types, draft.code, true, signal, checked.contextType);
      await rm(typed.dir, { recursive: true, force: true }).catch(() => {});
      problems = typed.problems;
    }
    if (problems.length) {
      previous = { draft, problems };
      continue;
    }
    const proposal = await api.call<{ routineId: string; versionId: string; number: number }>(
      'POST',
      'build/propose',
      {
        proposal: {
          name: draft.name.slice(0, 200) || 'Routine',
          description,
          summary: draft.summary.slice(0, 500) || draft.name,
          report,
          manifest,
          code: draft.code,
          ...(context.build?.routineId ? { routineId: context.build.routineId } : {}),
        },
        typesFingerprint,
      },
    );
    return { outcome: 'succeeded', proposed: true, report, ...proposal };
  }
  return {
    outcome: 'failed',
    code: 'builder_failed',
    problems: previous?.problems.slice(0, 20) ?? [],
  };
}
