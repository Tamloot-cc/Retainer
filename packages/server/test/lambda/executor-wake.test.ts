import { describe, expect, it, vi } from 'vitest';
import { executorWake } from '../../src/lambda/executor-wake.js';
import { log } from '../../src/log.js';

describe('executorWake', () => {
  it("invokes the executor asynchronously with the schedule's own event", async () => {
    const invoke = vi.fn(async () => 202);
    await executorWake('retainer-executor', invoke)();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [target, payload] = invoke.mock.calls[0] as unknown as [string, Uint8Array];
    expect(target).toBe('retainer-executor');
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({
      task: 'execute-extension-jobs',
    });
  });

  it('never fails the request: a refusal, an error or a slow invoke is only logged', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await expect(executorWake('f', async () => 429)()).resolves.toBeUndefined();
      await expect(
        executorWake('f', async () => {
          throw new Error('AccessDeniedException');
        })(),
      ).resolves.toBeUndefined();
      const started = Date.now();
      await expect(
        executorWake('f', () => new Promise<number>(() => {}), { waitMs: 50 })(),
      ).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(String(warn.mock.calls[1]?.[0])).toContain('AccessDeniedException');
    } finally {
      warn.mockRestore();
    }
  });

  it('sends one wake per burst: a pass already woken finds the later runs itself', async () => {
    let clock = 0;
    const invoke = vi.fn(async () => 202);
    const wake = executorWake('f', invoke, { everyMs: 3000, now: () => clock });
    await wake();
    clock = 2999;
    await wake();
    expect(invoke).toHaveBeenCalledTimes(1);
    clock = 3000;
    await wake();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
