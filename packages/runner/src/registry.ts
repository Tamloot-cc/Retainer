import type { ExecutionResult, Invocation } from '@retainer/extension';
import { RetainerClient } from '@retainer/sdk';
import { z } from 'zod';
import { executeLastContact, LAST_CONTACT_FUNCTION_IDS } from './last-contact.js';
import { executeWebhookFixture, WEBHOOK_SETUP_ID, WEBHOOK_SYNC_ID } from './webhook-fixture.js';

/** Permanent fixture identity. Production integrations add reviewed, build-time imports here. */
export const FIXTURE_FUNCTION_ID = '07c46550-e0f9-4f2e-b469-4a90931f1970';
export const FIXTURE_INSTALL_ID = 'c6b8b3eb-f68b-48af-b96f-a71352c2b2e6';
const fixtureInput = z.strictObject({
  sourceId: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
});
export async function execute(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  if (LAST_CONTACT_FUNCTION_IDS.includes(invocation.functionId))
    return executeLastContact(invocation, signal, transport);
  if ([WEBHOOK_SETUP_ID, WEBHOOK_SYNC_ID].includes(invocation.functionId))
    return executeWebhookFixture(invocation, signal, transport);
  if (![FIXTURE_FUNCTION_ID, FIXTURE_INSTALL_ID].includes(invocation.functionId))
    return { status: 'failed', code: 'function_not_bundled' };
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: (url, options) => transport(url, { ...options, signal }),
  });
  if (invocation.functionId === FIXTURE_INSTALL_ID) {
    if (!z.strictObject({}).safeParse(invocation.input).success)
      return { status: 'failed', code: 'invalid_input' };
    const previous = await sdk.extensionKv(invocation.installationId, 'setup');
    if (previous) return { status: 'succeeded' };
    await sdk.extensionCheckpoint(invocation.installationId, {
      children: [
        {
          functionId: FIXTURE_FUNCTION_ID,
          input: { sourceId: 'compose-fixture', name: 'Compose fixture company' },
          dedupeKey: 'fixture-install-child',
        },
      ],
      kv: { key: 'setup', expectedRevision: null, value: { started: true } },
    });
    return { status: 'succeeded' };
  }
  const input = fixtureInput.safeParse(invocation.input);
  if (!input.success) return { status: 'failed', code: 'invalid_input' };
  await sdk.createRecord(
    'company',
    { values: { name: input.data.name } },
    `fixture:${input.data.sourceId}`,
  );
  return { status: 'succeeded' };
}
