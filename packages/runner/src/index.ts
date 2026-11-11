import { decodeInvocation, type ExecutionResult } from '@retainer/extension';
import { execute } from './registry.js';

async function main(): Promise<ExecutionResult> {
  if (process.versions.node.split('.')[0] !== '24')
    return { status: 'failed', code: 'incompatible_runtime' };
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65536) return { status: 'failed', code: 'invalid_invocation' };
    chunks.push(chunk);
  }
  const invocation = decodeInvocation(Buffer.concat(chunks).toString());
  if (
    !process.env.RETAINER_BUNDLED_RELEASE_DIGEST ||
    invocation.releaseDigest !== process.env.RETAINER_BUNDLED_RELEASE_DIGEST
  )
    return { status: 'failed', code: 'incompatible_runtime' };
  const duration = new Date(invocation.deadline).getTime() - Date.now();
  if (duration <= 0 || duration > 300000) return { status: 'failed', code: 'invalid_deadline' };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), duration);
  try {
    return await execute(invocation, controller.signal);
  } catch {
    return {
      status: 'retry',
      code: controller.signal.aborted ? 'execution_timeout' : 'handler_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
const result = await main().catch(() => ({
  status: 'failed' as const,
  code: 'invalid_invocation',
}));
process.stdout.write(JSON.stringify(result), () => process.exit(0));
