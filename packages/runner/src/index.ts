import { handle } from './handle.js';

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 524288) return { status: 'failed', code: 'invalid_invocation' };
    chunks.push(chunk);
  }
  return handle(Buffer.concat(chunks).toString(), 'both');
}
const result = await main().catch(() => ({
  status: 'failed' as const,
  code: 'invalid_invocation',
}));
process.stdout.write(JSON.stringify(result), () => process.exit(0));
