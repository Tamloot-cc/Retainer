import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { loadConfig, rateLimitPerMinute } from '../config.js';
import { createApiSql, createControlSql } from '../db/client.js';
import { maintenanceResponse } from '../http/maintenance.js';
import { workspaceRateLimit } from '../http/rate-limit.js';
import { log } from '../log.js';
import { createApiHandler } from './api.js';
import { createControlHandler } from './control.js';

function apiHandler() {
  const config = loadConfig();
  const table = process.env.RETAINER_RESTRICTED_RATE_TABLE;
  const sql = createApiSql(config, { max: config.RETAINER_DB_POOL_MAX, readOnly: true });
  const limit = rateLimitPerMinute(config);
  const dynamo = new DynamoDBClient({ maxAttempts: 1 });
  const limiter = workspaceRateLimit({ limit }, async (workspaceId, seconds) => {
    if (!table) throw new Error('Restricted serving requires a workspace rate table.');
    const epoch = Math.floor(Date.now() / 1000);
    const window = Math.floor(epoch / seconds);
    const resetIn = (window + 1) * seconds - epoch;
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: table,
          Key: { bucket: { S: `${workspaceId}:${window}` } },
          UpdateExpression: 'SET expires_at = :expires ADD request_count :one',
          ConditionExpression: 'attribute_not_exists(request_count) OR request_count < :limit',
          ExpressionAttributeValues: {
            ':expires': { N: String((window + 2) * seconds) },
            ':one': { N: '1' },
            ':limit': { N: String(limit) },
          },
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return { count: 1, resetIn };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return { count: limit + 1, resetIn };
      throw error;
    }
  });
  return createApiHandler(config, sql, {}, false, {
    rateLimit: async (c, next) => {
      try {
        return await limiter(c, next);
      } catch (error) {
        log.error(error);
        return maintenanceResponse(false, 'reads');
      }
    },
  });
}

function controlHandler() {
  const config = loadConfig();
  const pool = () => createControlSql(config, { max: config.RETAINER_DB_POOL_MAX, readOnly: true });
  return createControlHandler(config, pool(), pool(), undefined, true);
}

let api: ReturnType<typeof apiHandler> | undefined;
let control: ReturnType<typeof controlHandler> | undefined;

/** Dedicated, separately routed readers. They never use the normal writer pools. */
export const apiReader = (event: LambdaEvent, context: LambdaContext) => {
  api ??= apiHandler();
  return api(event, context);
};
export const controlReader = (event: LambdaEvent, context: LambdaContext) => {
  control ??= controlHandler();
  return control(event, context);
};
