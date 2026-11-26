import { describe, expect, it } from 'vitest';
import { systemMessages } from './agent.js';

describe('system blocks', () => {
  it('puts the 1-hour breakpoint on the last block only', () => {
    const [base, task] = systemMessages(['Base prompt', 'Find the funding round.']);
    expect(base).toEqual({ role: 'system', content: 'Base prompt' });
    expect(task).toEqual({
      role: 'system',
      content: 'Find the funding round.',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    });
  });
});
