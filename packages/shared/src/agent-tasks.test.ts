import { describe, expect, it } from 'vitest';
import {
  AGENT_TASK_LIMITS,
  agentTaskRequestSchema,
  answerProblem,
  fitAnswer,
  providerSchema,
} from './agent-tasks.js';

const OUTPUT = {
  type: 'object',
  properties: {
    round: { type: 'string', enum: ['Seed', 'Series A'] },
    amount: { type: 'integer' },
    investors: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['round'],
} as const;

describe('agent task requests', () => {
  it('takes the documented fields and refuses web fetch and unknown groups', () => {
    const ok = agentTaskRequestSchema.safeParse({
      instructions: 'Find it.',
      tools: ['retainer.read', 'web.search', 'tools.check_address'],
      output: OUTPUT,
      limits: { maxSteps: 10 },
    });
    expect(ok.success).toBe(true);
    for (const tools of [['web.fetch'], ['tools.Bad-Name']])
      expect(
        agentTaskRequestSchema.safeParse({ instructions: 'x', tools, output: OUTPUT }).success,
      ).toBe(false);
    expect(
      agentTaskRequestSchema.safeParse({
        instructions: 'x',
        tools: [],
        output: OUTPUT,
        limits: { maxSteps: AGENT_TASK_LIMITS.maxSteps + 1 },
      }).success,
    ).toBe(false);
  });
});

describe('answers', () => {
  it('closes every object for the provider and drops what it cannot take', () => {
    expect(providerSchema(OUTPUT)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        round: { type: 'string', enum: ['Seed', 'Series A'] },
        amount: { type: 'integer' },
        investors: { type: 'array', items: { type: 'string' } },
      },
      required: ['round'],
    });
  });

  it('says why an answer misses the schema', () => {
    expect(answerProblem(OUTPUT, { round: 'Seed', amount: 3 })).toBeNull();
    expect(answerProblem(OUTPUT, {})).toBe('$.round is required');
    expect(answerProblem(OUTPUT, { round: 'Series Z' })).toContain('one of');
    expect(answerProblem(OUTPUT, { round: 'Seed', amount: 1.5 })).toBe(
      '$.amount should be an integer',
    );
    expect(answerProblem(OUTPUT, { round: 'Seed', extra: 1 })).toBe('$.extra is not in the schema');
    expect(answerProblem(OUTPUT, [])).toBe('$ should be an object');
  });

  it('holds an answer to maxItems', () => {
    expect(fitAnswer(OUTPUT, { round: 'Seed', investors: ['a', 'b', 'c'] })).toEqual({
      round: 'Seed',
      investors: ['a', 'b'],
    });
  });
});
