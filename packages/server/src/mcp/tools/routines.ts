import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import {
  checkAnswer,
  proposeInputSchema,
  type Routines,
  sourceInputSchema,
  sourceRefSchema,
} from '../../routines/service.js';
import { run } from '../shared.js';

/** Waits briefly for a sandbox job, so most checks answer in one call (routines spec §5.1). */
async function settle<T extends { status?: string }>(read: () => Promise<T>, seconds: number) {
  const until = Date.now() + seconds * 1000;
  let job = await read();
  while (['queued', 'running'].includes(job.status ?? '') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = await read();
  }
  return job;
}

const wait = z
  .number()
  .int()
  .min(0)
  .max(20)
  .default(15)
  .describe('Seconds to wait for the sandbox before answering with a job to poll.');

/**
 * Routine tools for agents (routines spec §5.2): what exists, a check, a
 * dry run and a proposal. An agent can never approve: a person does, in the
 * app or with an admin key.
 */
export function registerRoutineTools(server: McpServer, routines: Routines, caller: Caller) {
  server.registerTool(
    'get_routine_capabilities',
    {
      description:
        'Start here before writing a routine. Returns what this workspace has for routines: objects and fields (by key), installed tools with their effect, whether a model is available, the time zone, triggers, limits, the gap codes for your report, and the SDK types (a .d.ts) routine code is checked against.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => routines.capabilities(caller)),
  );
  server.registerTool(
    'validate_routine',
    {
      description:
        'Check a routine before proposing it: the manifest completely (objects, fields, filters, cron, tools, model), the code for imports and main, then a full TypeScript type-check in the sandbox. Answers valid with problems that point at the manifest path or code line:column, and a sourceId for the checked manifest and code (pass it to preview_routine and propose_routine instead of sending them again); if the sandbox is still working, poll get_routine_job with the jobId.',
      inputSchema: sourceInputSchema.extend({ wait }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ wait: seconds, ...input }) =>
      run(
        caller,
        'read',
        async () => {
          const result = await routines.validate(caller, input);
          if (!('jobId' in result) || result.valid !== null) return result;
          return checkAnswer(await settle(() => routines.getJob(caller, result.jobId), seconds));
        },
        (result) => (result as { valid?: boolean | null }).valid === false,
      ),
  );
  server.registerTool(
    'preview_routine',
    {
      description:
        'Dry-run a routine on up to five recent records that match its trigger and pass its condition with their current values. Pass the sourceId from validate_routine, or the manifest and code. Nothing is written and no tool is called: each run lists the writes and tool calls the code tried (a tool call ends that dry run). Answers how many distinct records are eligible (one run for a schedule without an object) and a previewId; read the runs with get_routine_preview. The previewId is null, with done true, when no record is eligible, so there is nothing to dry-run.',
      inputSchema: sourceRefSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'read', () => routines.preview(caller, input)),
  );
  server.registerTool(
    'get_routine_preview',
    {
      description:
        "A preview's dry runs: each run's status, result and the calls it tried, in order.",
      inputSchema: z.strictObject({ previewId: z.uuid(), wait }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ previewId, wait: seconds }) =>
      run(caller, 'read', async () => {
        const until = Date.now() + seconds * 1000;
        let preview = await routines.getPreview(caller, previewId);
        while (!preview.done && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          preview = await routines.getPreview(caller, previewId);
        }
        return preview;
      }),
  );
  server.registerTool(
    'get_routine_job',
    {
      description:
        'Poll a sandbox job from validate_routine (a check) or any routine run, by its ID.',
      inputSchema: z.strictObject({ jobId: z.uuid(), wait }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ jobId, wait: seconds }) =>
      run(caller, 'read', async () => {
        const job = await settle(() => routines.getJob(caller, jobId), seconds);
        return job.mode === 'check' ? { ...job, ...checkAnswer(job) } : job;
      }),
  );
  server.registerTool(
    'propose_routine',
    {
      description:
        "Save a routine for a person to review and approve. It must have passed validate_routine against the workspace's current types; pass its sourceId, or the manifest and code. Pass the person's description in their words, a one-sentence summary, and an honest report: verdict full, partial (list each gap with a gap code and what would fix it) or not_possible. Pass routineId to propose a new version of an existing routine. A proposal does nothing until an admin approves it.",
      inputSchema: proposeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => run(caller, 'write', () => routines.propose(caller, input)),
  );
  server.registerTool(
    'list_routines',
    {
      description:
        "The workspace's routines: status, what each does, held runs and proposals waiting for review.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(caller, 'read', () => routines.list(caller)),
  );
  server.registerTool(
    'get_routine',
    {
      description: 'One routine: its versions (manifest, code, facts, report) and recent runs.',
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => routines.get(caller, id)),
  );
}
