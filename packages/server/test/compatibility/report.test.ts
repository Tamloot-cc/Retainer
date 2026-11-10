import { describe, expect, it } from 'vitest';
import { assertCompletedRun, classifyReport } from './report.js';

function report(status = 'passed') {
  return {
    numTotalTests: 1,
    testResults: [
      {
        name: '/base/test/db/records.test.ts',
        status,
        assertionResults: [
          {
            fullName: 'reads records',
            status,
            failureMessages: status === 'failed' ? ['column missing'] : [],
          },
        ],
      },
    ],
  };
}

describe('migration compatibility verdict evidence', () => {
  it('rejects interruption and runner errors even alongside test failures', () => {
    expect(() => assertCompletedRun({ reason: 'passed', errors: [] }, 'candidate')).not.toThrow();
    expect(() => assertCompletedRun({ reason: 'failed', errors: [] }, 'candidate')).not.toThrow();
    expect(() => assertCompletedRun({ reason: 'interrupted', errors: [] }, 'candidate')).toThrow();
    expect(() =>
      assertCompletedRun({ reason: 'failed', errors: ['worker crashed'] }, 'candidate'),
    ).toThrow();
  });
  it('accepts a completed passing run', () => {
    expect(classifyReport(report(), 0, 'candidate', '/base')).toEqual([]);
  });
  it('names old tests that fail, preserving the diagnostic', () => {
    expect(classifyReport(report('failed'), 1, 'candidate', '/base')).toEqual([
      {
        file: 'test/db/records.test.ts',
        name: 'reads records',
        messages: ['column missing'],
      },
    ]);
  });
  it('counts fixture failures with collected tests as breaking evidence', () => {
    const result = report('skipped');
    for (const suite of result.testResults) suite.status = 'failed';
    expect(classifyReport(result, 1, 'candidate', '/base')[0]?.name).toContain(
      'suite setup/teardown failed',
    );
  });
  it('does not call a test database connection failure breaking', () => {
    const result = report('failed');
    for (const suite of result.testResults) {
      for (const test of suite.assertionResults) test.failureMessages = ['connect ECONNREFUSED'];
    }
    expect(() => classifyReport(result, 1, 'candidate', '/base')).toThrow(/infrastructure/);
  });
  it('refuses empty, unloadable, or inconsistent reports', () => {
    for (const result of [
      { ...report(), numTotalTests: 0 },
      {
        ...report(),
        testResults: [{ name: 'unloadable.ts', status: 'failed', assertionResults: [] }],
      },
    ])
      expect(() => classifyReport(result, 1, 'candidate', '/base')).toThrow();
    expect(() => classifyReport(report(), 1, 'candidate', '/base')).toThrow(/disagrees/);
    expect(() => classifyReport(report('failed'), 0, 'candidate', '/base')).toThrow(/disagrees/);
  });
});
