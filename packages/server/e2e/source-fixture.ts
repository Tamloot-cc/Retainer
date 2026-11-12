import { BASE_EVENT_TYPE_IDS } from '@retainer/shared';
import { extensionFixture } from '../test/helpers/extensions.js';

export const sourceManifest = extensionFixture({
  universalId: '95df1c22-8960-4e6f-b4ac-76dd795a8729',
  name: 'source-browser-fixture',
  scopes: ['read', 'write'],
  source: {
    provider: 'fixture',
    identity: 'account',
    verifyFunctionId: 'cb77e041-009f-4677-bb52-d34a6599aa3d',
    syncFunctionIds: ['8ce44dc0-f84b-4730-8cf3-2e4c8df70d77'],
    eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
    revisionOrder: 'integer',
  },
  functions: [
    {
      universalId: 'cb77e041-009f-4677-bb52-d34a6599aa3d',
      name: 'verify',
      description: 'Verify browser fixture',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'install' },
      inputSchema: { type: 'object', additionalProperties: false },
      timeoutSeconds: 120,
    },
    {
      universalId: '8ce44dc0-f84b-4730-8cf3-2e4c8df70d77',
      name: 'sync',
      description: 'Import browser fixture',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      inputSchema: {
        type: 'object',
        properties: { sourceItemId: { type: 'string', maxLength: 36 } },
        required: ['sourceItemId'],
        additionalProperties: false,
      },
      timeoutSeconds: 120,
    },
    {
      universalId: '897a069d-ae57-44e9-820e-e2e8d231f605',
      name: 'scan',
      description: 'Enumerate browser fixture',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
      timeoutSeconds: 120,
    },
  ],
});
