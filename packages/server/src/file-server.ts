import { createFileServer } from './file-storage/local.js';

const key = process.env.RETAINER_FILE_SIGNING_KEY,
  directory = process.env.RETAINER_FILE_DIRECTORY;
if (!key || !directory)
  throw new Error('file service directory and external signing key are required');
const server = createFileServer({
  directory,
  key: Buffer.from(key, 'base64'),
  allowedOrigins: (process.env.RETAINER_FILE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
});
server.listen(Number(process.env.PORT ?? 8790), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
