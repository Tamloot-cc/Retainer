# syntax=docker/dockerfile:1
# The build stage runs natively once, even for multi-arch images: its output
# is plain JavaScript with no native modules, so it is the same on every arch.
ARG NODE_VERSION=26
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS build
# Node 25 and later no longer bundle corepack.
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs package.json tsconfig.base.json ./
# Fetches the pnpm in packageManager here, so source changes don't refetch it.
RUN corepack install
COPY packages/shared/package.json ./packages/shared/
COPY packages/extension/package.json ./packages/extension/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/runner/package.json ./packages/runner/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @retainer/shared build && pnpm --filter @retainer/extension build && pnpm --filter @retainer/sdk build && pnpm --filter @retainer/web build && pnpm --filter @retainer/server build
RUN pnpm --filter @retainer/server deploy --legacy --prod /out

FROM node:${NODE_VERSION}-slim
ARG PRODUCT_COMMIT
LABEL org.opencontainers.image.revision=$PRODUCT_COMMIT
ENV NODE_ENV=production
ENV RETAINER_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/packages/web/dist ./web
# The operator CLI (ARCHITECTURE.md 7.1):
#   docker compose exec retainer retainer workspace create --name "Acme"
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/retainer \
  && chmod +x /usr/local/bin/retainer
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 8787
# Applies pending migrations, then starts the role set by RETAINER_ROLE.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
