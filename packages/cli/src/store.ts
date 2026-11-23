import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const directory = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'retainer',
);
const credentialsFile = join(directory, 'credentials.json');
export type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number };
export type Credentials = {
  lastServer?: string;
  servers: Record<string, Tokens & { workspace?: string }>;
};

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function loginFile(id: string) {
  return join(directory, `login-${id}.json`);
}

export async function credentials(): Promise<Credentials> {
  return (await readJson<Credentials>(credentialsFile)) ?? { servers: {} };
}

/** Per-server refreshes can overlap, while file replacement is serialized across servers. */
export async function locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${createHash('sha256').update(name).digest('hex')}.lock`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error('Another Retainer CLI process is using the credential file. Retry.');
      const lockStat = await stat(lock).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 60_000) {
        // Serialize stale removal so two waiters cannot unlink a new lock.
        const reaper = `${lock}.reclaim`;
        const handle = await open(reaper, 'wx', 0o600).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'EEXIST') return null;
          throw cause;
        });
        if (handle) {
          try {
            const current = await stat(lock).catch(() => null);
            if (current && Date.now() - current.mtimeMs > 60_000) await rm(lock, { force: true });
          } finally {
            await handle.close();
            await rm(reaper, { force: true });
          }
        }
      }
      await delay(80);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

export function updateCredentials(update: (file: Credentials) => void) {
  return locked('credentials', async () => {
    const file = await credentials();
    update(file);
    await writeJson(credentialsFile, file);
  });
}
