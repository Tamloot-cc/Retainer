import { readFileSync } from 'node:fs';

export const WRITER_BUILD_PATTERN = /^[a-f0-9]{40}$/;

/** Immutable across every pool and reconnect in a hosted Lambda environment. */
function readWriterBuild(): string | undefined {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return undefined;
  try {
    const stamp = JSON.parse(
      readFileSync(new URL('../../retainer-build.json', import.meta.url), 'utf8'),
    );
    if (typeof stamp.productCommit !== 'string' || !WRITER_BUILD_PATTERN.test(stamp.productCommit))
      throw new Error('invalid hosted writer build stamp');
    return stamp.productCommit;
  } catch (error) {
    // Cloud bootstrap placeholders have no product build stamp.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export const HOSTED_WRITER_BUILD = readWriterBuild();
