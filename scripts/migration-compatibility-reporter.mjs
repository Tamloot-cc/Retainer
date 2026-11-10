import { writeFileSync } from 'node:fs';

// Vitest's JSON reporter omits unhandled runner errors. Record them separately
// so a simultaneous test failure cannot hide a worker crash or interruption.
export default class CompatibilityReporter {
  onTestRunEnd(_modules, errors, reason) {
    writeFileSync(
      process.env.RETAINER_COMPAT_RUNTIME_REPORT,
      JSON.stringify({
        reason,
        errors: errors.map((error) => String(error.stack ?? error.message)),
      }),
    );
  }
}
