import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { OAUTH_SCOPES, pinnedMcpAddress, ROUTINE_LIMITS } from '@retainer/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { AgentSessions } from '../agent-sessions/service.js';
import { admitCliRoutes } from '../auth/cli-routes.js';
import { authenticate } from '../auth/middleware.js';
import { cliOAuthSettings, installationOAuthSettings, oauthSettings } from '../auth/oauth-token.js';
import { meRoute, sessionRoutes } from '../auth/session.js';
import { publicOriginSchema } from '../config.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import type { SecretBroker } from '../extension-runtime/secrets.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import { MODEL_PROXY_PATH } from '../extension-runtime/tokens.js';
import { ExtensionCatalog } from '../extensions/catalog.js';
import type { ExtensionOAuthClients } from '../extensions/oauth-clients.js';
import { Extensions } from '../extensions/service.js';
import type { FileStorage } from '../file-storage/contract.js';
import { Files } from '../files/service.js';
import { maintenanceResponse, readOnlyViolation } from '../http/maintenance.js';
import { type RateLimit, rateLimit } from '../http/rate-limit.js';
import { type AppEnv, errorResponse, toAppError } from '../http/response.js';
import { agentToolHost } from '../mcp/agent-tools.js';
import { hostedSetup } from '../mcp/hosted-setup.js';
import type { InProcessMcpOptions } from '../mcp/in-process.js';
import { mcpRoute, PINNED_MCP_ROUTE } from '../mcp/route.js';
import { mountModelRoutes } from '../model/mount.js';
import { RoutineRuntime } from '../routines/runtime.js';
import { Routines } from '../routines/service.js';
import { VERSION } from '../version.js';
import type { Webhooks } from '../webhooks/service.js';
import { admitRestrictedApi, admitRestrictedCredential } from './restricted.js';
import { agentChatRoutes, agentRuntimeRoutes, agentStreamForward } from './routes/agent.js';
import { agentBriefingRoutes } from './routes/agent-briefing.js';
import { changeRoutes } from './routes/changes.js';
import { commentRoutes } from './routes/comments.js';
import { dashboardRoutes } from './routes/dashboards.js';
import { extensionDataRoutes } from './routes/extension-data.js';
import { runtimeRoutes } from './routes/extension-runtime.js';
import { extensionRoutes } from './routes/extensions.js';
import { fileRoutes } from './routes/files.js';
import { memoryRoutes } from './routes/memory.js';
import { recordRoutes } from './routes/records.js';
import { retrievalRoutes } from './routes/retrieval.js';
import { routineRoutes, routineRuntimeRoutes } from './routes/routines.js';
import { schemaRoutes } from './routes/schema.js';
import { templateRoutes } from './routes/templates.js';
import { viewRoutes } from './routes/views.js';
import { webReadRoutes } from './routes/web-read.js';
import { webhookIngress, webhookRuntime } from './routes/webhooks.js';

export type AppDeps = {
  webhooks?: Webhooks | undefined;
  fileStorage?: FileStorage | undefined;
  fileQuota?: number | undefined;
  /** A pool connected as the runtime role, so RLS applies to every query. */
  sql: Sql;
  extensionCatalog?: ExtensionCatalog;
  extensionActivation?: ReadonlySet<string>;
  runTokens?: RunTokens;
  extensionSecrets?: SecretBroker;
  /** Operator OAuth clients for member connections (Tamloot connect spec 4.1). */
  extensionOAuthClients?: ExtensionOAuthClients;
  webDir?: string;
  publicOrigin?: string;
  /**
   * RETAINER_AUTH_SECRET, in accounts mode: people's signed session cookies
   * reach /v1, and the key-mode sign-in at /auth/session is gone (4.1).
   */
  accountsSecret?: string;
  /** The per-workspace rate limit on /v1 and /mcp (accounts spec 4.8); none if unset. */
  rateLimit?: RateLimit;
  /** Use read-only pools and an independently admitted limiter during a write pause. */
  restricted?: { rateLimit: MiddlewareHandler<AppEnv> };
  /** Scope is selected by a trusted caller only after workspace isolation is established. */
  workspacePause?: {
    workspaceId: string;
    reader: (request: Request) => Response | Promise<Response>;
  };
  /** The caller's address, for the webhook ingress limiter; never read from a client header. */
  clientIp?: (c: Context<AppEnv>) => string | undefined;
  /**
   * Serve the model proxy in this process (self-hosted; model calls spec 3.6).
   * The hosted service runs it as its own `model` function instead.
   */
  model?: { apiKey: string | undefined; upstream: string };
  /** RETAINER_MODEL_USAGE_SECRET: mounts the hosted `model` function's usage report. */
  modelUsageSecret?: string | undefined;
  /**
   * Routine model calls (routines spec §4.5, §6.3). Available when this
   * process serves the model proxy with a key, or a hosted `model` function's
   * origin is set.
   */
  /**
   * The workspace agent (agent spec §6.1, §13): chats and the runtime routes.
   * Off without the runtime credential.
   */
  agent?: {
    runtimeSecret?: string | undefined;
    /** Hosted: the agent function URL's origin, where clients stream. */
    origin?: string | undefined;
    /** Self-hosted: the agent container this server forwards the stream to. */
    upstream?: string | undefined;
    /** The `retainer_mastra` login for the chat read endpoint. */
    readStoreUrl?: string | undefined;
    personDailySteps?: number;
    workspaceDailySteps?: number;
    /** How long one extension tool request waits before answering `pending`. */
    extensionWaitMs?: number;
    /** Whether task jobs reach a runtime (agent spec §9.3); defaults to true. */
    tasks?: boolean;
  };
  routines?: {
    available?: boolean;
    modelAvailable?: boolean;
    modelOrigin?: string | undefined;
    modelName?: string;
    modelCallsPerDay?: number;
  };
};

/** Extension `read` tools for agent sessions run as jobs on the extension queue (agent spec §8.1). */
function agentExtensions(sql: Sql, catalog: ExtensionCatalog) {
  return { catalog: catalog.runtime, queue: new ExtensionQueue(sql, catalog.runtime) };
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const publicOrigin = deps.publicOrigin ? publicOriginSchema.parse(deps.publicOrigin) : undefined;

  app.onError((error, c) =>
    deps.restricted && readOnlyViolation(error)
      ? maintenanceResponse(false, 'reads')
      : errorResponse(c, toAppError(error)),
  );
  if (deps.restricted) app.use('*', admitRestrictedApi);

  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({
        status: 'ok',
        version: VERSION,
        database: 'ok',
        ...(deps.restricted ? { restrictedServingProtocol: 1 } : {}),
      });
    } catch {
      return c.json({ status: 'error', version: VERSION, database: 'unreachable' }, 503);
    }
  });

  // Before /v1's authentication: these routes take their own credentials.
  const agentTools = deps.agent?.runtimeSecret
    ? agentToolHost(deps.sql, {
        extensionCatalog: deps.extensionCatalog,
        extensionActivation: deps.extensionActivation,
        fileStorage: deps.fileStorage,
        fileQuota: deps.fileQuota,
      })
    : undefined;
  const agent =
    deps.agent?.runtimeSecret && agentTools
      ? new AgentSessions(
          deps.sql,
          agentTools,
          {
            runtimeSecret: deps.agent.runtimeSecret,
            agentOrigin: deps.agent.origin,
            readStoreUrl: deps.agent.readStoreUrl,
            personDailySteps: deps.agent.personDailySteps ?? 2000,
            workspaceDailySteps: deps.agent.workspaceDailySteps ?? 20000,
            keys: !deps.accountsSecret,
            extensionWaitMs: deps.agent.extensionWaitMs,
          },
          agentExtensions(deps.sql, deps.extensionCatalog ?? new ExtensionCatalog()),
        )
      : undefined;
  if (agent) agentRuntimeRoutes(app, agent);
  if (!deps.agent?.origin) agentStreamForward(app, agent ? deps.agent?.upstream : undefined);

  webhookIngress(app, deps.webhooks, deps.clientIp);
  mountModelRoutes(app, deps);
  const routinesAvailable = deps.routines?.available === true && !!deps.runTokens;
  // Chat works only with its read store and somewhere to stream to: the agent's own
  // origin (hosted) or the container this server forwards to (self-hosted).
  const agentAvailable =
    agent !== undefined &&
    !!deps.agent?.readStoreUrl &&
    !!(deps.agent.origin || deps.agent.upstream);
  if (!deps.accountsSecret)
    sessionRoutes(app, deps.sql, publicOrigin, { routinesAvailable, agentAvailable });
  const v1 = new Hono<AppEnv>();
  const workspaceLimit = deps.restricted
    ? admitRestrictedCredential(deps.restricted.rateLimit)
    : rateLimit(deps.sql, deps.rateLimit ?? { limit: 0 });
  const limit: MiddlewareHandler<AppEnv> = async (c, next) => {
    const pause = deps.workspacePause;
    if (pause && c.get('caller').workspaceId === pause.workspaceId) return pause.reader(c.req.raw);
    return workspaceLimit(c, next);
  };
  v1.use(
    '*',
    authenticate(deps.sql, {
      publicOrigin,
      accountsSecret: deps.accountsSecret,
      runTokens: deps.runTokens,
      installationKeys: !deps.accountsSecret,
      oauth:
        deps.accountsSecret && publicOrigin
          ? [installationOAuthSettings(publicOrigin), cliOAuthSettings(publicOrigin)]
          : undefined,
    }),
  );
  v1.use('*', admitCliRoutes());
  v1.use('*', limit);
  meRoute(v1, deps.sql, {
    routinesAvailable,
    agentAvailable,
    restricted: deps.restricted !== undefined,
  });
  webReadRoutes(v1, deps.sql);
  schemaRoutes(v1, deps.sql);
  templateRoutes(v1, deps.sql);
  recordRoutes(v1, deps.sql);
  memoryRoutes(v1, deps.sql);
  commentRoutes(v1, deps.sql);
  retrievalRoutes(v1, deps.sql);
  viewRoutes(v1, deps.sql);
  dashboardRoutes(v1, deps.sql);
  agentChatRoutes(v1, agent, publicOrigin);
  const extensions = new Extensions(
    deps.sql,
    deps.extensionCatalog,
    deps.extensionSecrets,
    deps.extensionActivation,
    deps.extensionOAuthClients,
  );
  extensionRoutes(v1, extensions, !deps.accountsSecret);
  changeRoutes(v1, deps.sql, extensions.catalog);
  runtimeRoutes(
    v1,
    deps.sql,
    extensions.catalog,
    deps.extensionSecrets,
    extensions.oauthClients,
    deps.agent?.tasks === false ? undefined : agentTools,
  );
  extensionDataRoutes(v1, deps.sql, extensions.catalog);
  webhookRuntime(v1, deps.webhooks);
  fileRoutes(v1, deps.sql, deps.fileStorage, deps.fileQuota);
  const routineConfig = {
    catalog: extensions.catalog.runtime,
    modelAvailable: deps.routines?.modelAvailable ?? !!deps.model?.apiKey,
    // `retainer.ai.agent` needs the agent's runtime and a way to deliver task jobs.
    agentAvailable: !!agent && (deps.agent?.tasks ?? true),
  };
  if (routinesAvailable && deps.runTokens) {
    routineRoutes(v1, new Routines(deps.sql, routineConfig), agent);
    routineRuntimeRoutes(
      v1,
      new RoutineRuntime(deps.sql, {
        ...routineConfig,
        tokens: deps.runTokens,
        queue: new ExtensionQueue(deps.sql, extensions.catalog.runtime),
        files: new Files(deps.sql, deps.fileStorage, deps.fileQuota),
        // Relative: the runner resolves it against the API origin it reaches.
        modelOrigin: deps.routines?.modelOrigin ?? MODEL_PROXY_PATH,
        modelName: deps.routines?.modelName ?? 'claude-opus-5-5',
        modelCallsPerDay: deps.routines?.modelCallsPerDay ?? ROUTINE_LIMITS.modelCallsPerDay,
        agentTools,
      }),
    );
  }
  // What connected agents get: /mcp and the agent briefing build the same server.
  const mcpOptions: InProcessMcpOptions = {
    extensionCatalog: deps.extensionCatalog,
    extensionActivation: deps.extensionActivation,
    fileStorage: deps.fileStorage,
    fileQuota: deps.fileQuota,
    routines: routinesAvailable ? routineConfig : undefined,
    publicOrigin,
  };
  agentBriefingRoutes(v1, deps.sql, mcpOptions);
  app.route('/v1', v1);

  // Accounts mode: apps connect to /mcp over OAuth as well as with API keys
  // (accounts spec 4.7). The authorization server is Better Auth, under
  // /account; this function only checks its tokens.
  const oauth = deps.accountsSecret && publicOrigin ? oauthSettings(publicOrigin) : undefined;
  if (oauth && publicOrigin) {
    const setupUrl = `${publicOrigin}/mcp/setup`;
    app.get('/mcp/setup', (c) => c.text(hostedSetup(publicOrigin)));
    const help: MiddlewareHandler<AppEnv> = async (c, next) => {
      c.header('Link', `<${setupUrl}>; rel="help"`);
      const accept = c.req.header('accept') ?? '';
      // MCP GET requests ask for SSE. A plain, anonymous GET is an agent or
      // person looking up what to do with this URL.
      if (
        c.req.method === 'GET' &&
        !c.req.header('authorization') &&
        !accept.includes('text/event-stream') &&
        !accept.includes('application/json')
      ) {
        return accept.includes('text/html')
          ? c.redirect(setupUrl)
          : c.text(hostedSetup(publicOrigin));
      }
      await next();
    };
    app.use('/mcp', help);
    app.use(PINNED_MCP_ROUTE, help);
    const rest = installationOAuthSettings(publicOrigin);
    app.get('/.well-known/oauth-protected-resource/cli', (c) => {
      const cli = cliOAuthSettings(publicOrigin);
      return c.json({
        resource: cli.resource,
        authorization_servers: [cli.issuer],
        scopes_supported: ['read', 'offline_access'],
        bearer_methods_supported: ['header'],
      });
    });
    app.get('/.well-known/oauth-protected-resource/v1', (c) => {
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json({
        resource: rest.resource,
        authorization_servers: [rest.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['read', 'write', 'offline_access'],
        resource_name: 'Retainer workspace apps',
      });
    });
    // RFC 9728 protected resource metadata: static, so the API serves it.
    const metadata = {
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [...OAUTH_SCOPES],
      resource_name: 'Retainer',
      resource_documentation: setupUrl,
    };
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      app.get(path, (c) => {
        c.header('Cache-Control', 'public, max-age=3600');
        return c.json(metadata);
      });
    }
    // A pinned address is a resource of its own (accounts spec 4.7).
    app.get(`/.well-known/oauth-protected-resource${PINNED_MCP_ROUTE}`, (c) => {
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json({
        ...metadata,
        resource: pinnedMcpAddress(publicOrigin, c.req.param('workspace')),
      });
    });
  }
  mcpRoute(app, deps.sql, { ...mcpOptions, oauth, rateLimit: limit });

  if (deps.webDir) {
    const root = resolve(deps.webDir);
    // No other site may frame the app: the consent page, where a person lets
    // an app in, must not be clickjacked (accounts spec 4.7). Requests from
    // the app send only the origin as Referer: an OAuth page's address is
    // long, and API Gateway refuses headers over 10 KB, which cookies other
    // apps set on a parent domain can already come close to.
    // Files under assets/ have a content hash in their names, so a browser
    // can keep them for good. Everything else, index.html above all (served
    // here for /app/ too), is checked on every load, so a new build's
    // index.html, which names the new files, is seen at once.
    const isAsset = (path: string) => path.startsWith('/app/assets/');
    app.use('/app/*', async (c, next) => {
      await next();
      c.header('Content-Security-Policy', "frame-ancestors 'none'");
      c.header('X-Frame-Options', 'DENY');
      c.header('Referrer-Policy', 'strict-origin');
      if (c.res.status !== 200) return;
      c.header(
        'Cache-Control',
        isAsset(c.req.path) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      // The file sent depends on Accept-Encoding even when it is the plain one:
      // without this, a shared cache could keep the plain copy for every browser.
      if (!/accept-encoding/i.test(c.res.headers.get('Vary') ?? ''))
        c.header('Vary', 'Accept-Encoding', { append: true });
    });
    app.get('/app', (c) => c.redirect('/app/'));
    app.use(
      '/app/*',
      serveStatic({
        root,
        precompressed: true,
        rewriteRequestPath: (path) => path.replace(/^\/app/, ''),
      }),
    );
    app.get('/app/*', async (c, next) => {
      if (isAsset(c.req.path)) return next();
      return serveStatic({ path: resolve(root, 'index.html'), precompressed: true })(c, next);
    });
  }
  return app;
}
