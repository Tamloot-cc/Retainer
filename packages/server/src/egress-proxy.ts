import { EgressPolicy } from './egress/policy.js';
import { createEgressProxy } from './egress/proxy.js';

const policy = new EgressPolicy(
  (process.env.RETAINER_EXECUTION_API_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const server = createEgressProxy(policy);
server.listen(Number(process.env.PORT ?? 3128), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
