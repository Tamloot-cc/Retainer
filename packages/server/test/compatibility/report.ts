type Report = {
  numTotalTests: number;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
};

/** Only completed test failures are compatibility evidence; runner errors are unknown. */
export function classifyReport(report: Report, status: number, phase: string, base: string) {
  if (!report.numTotalTests) {
    throw new Error(`${phase}: no tests ran`);
  }
  // A collected suite can still fail before exercising old code, e.g. while
  // cloning its database. Do not call known transport/resource failures breaking.
  const infrastructureError =
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|too many clients|remaining connection slots|password authentication failed|source database .*being accessed|database .*does not exist|Hook timed out/i;
  for (const suite of report.testResults) {
    const messages = [
      suite.message ?? '',
      ...suite.assertionResults.flatMap((test) => test.failureMessages),
    ];
    if (messages.some((message) => infrastructureError.test(message))) {
      throw new Error(`${phase}: test infrastructure failed in ${suite.name}; inspect the report`);
    }
  }
  const failures = report.testResults.flatMap((suite) => {
    const failed = suite.assertionResults.filter((test) => test.status === 'failed');
    if (suite.status === 'failed' && !failed.length) {
      if (!suite.assertionResults.length) {
        throw new Error(`${phase}: suite could not load: ${suite.name}: ${suite.message}`);
      }
      // A missing column can break beforeAll fixture creation: collected old
      // tests then get skipped. This is compatibility evidence, not a clean run.
      return suite.assertionResults.map((test) => ({
        file: suite.name.replace(`${base}/`, ''),
        name: `${test.fullName} (suite setup/teardown failed)`,
        messages: [suite.message ?? 'Suite setup/teardown failed'],
      }));
    }
    return failed.map((test) => ({
      file: suite.name.replace(`${base}/`, ''),
      name: test.fullName,
      messages: test.failureMessages,
    }));
  });
  if ((status !== 0) !== failures.length > 0) {
    throw new Error(`${phase}: test exit status disagrees with report`);
  }
  return failures;
}

export function assertCompletedRun(runtime: { reason: string; errors: string[] }, phase: string) {
  if (!['passed', 'failed'].includes(runtime.reason) || runtime.errors.length) {
    throw new Error(`${phase}: runner did not complete cleanly: ${JSON.stringify(runtime)}`);
  }
}
