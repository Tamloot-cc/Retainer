#!/usr/bin/env bash
# The Docker tests CI leaves out of push and pull-request runs (a release still
# runs them): the extension sandbox, the extension lifecycle in Compose, a
# routine on its closed network in Compose, file storage in Compose and the
# agent container in Compose. Run
# before pushing a change to docker/, the extension runtime, routines or file
# storage. Needs Docker; run `pnpm build` first.
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -f docker/Dockerfile -t retainer:extensions-review -t retainer:files-review -t retainer:agent-review .
docker build -f docker/Dockerfile.extension-runner \
  --build-arg RELEASE_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --build-arg BUNDLE_ID=fixture -t retainer:extension-runner-fixture .
pnpm test:extensions:sandbox

node scripts/build-extension-artifacts.mjs --development
digest=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/extensions/fixture/metadata.json')).releaseDigest")
docker build -f docker/Dockerfile.extension-runner --build-arg RELEASE_DIGEST="$digest" \
  --build-arg BUNDLE_ID=fixture -t retainer:extension-runner-fixture .
pnpm test:extensions:compose
routine_digest=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/extensions/routine-runner/metadata.json')).releaseDigest")
docker build -f docker/Dockerfile.extension-runner --build-arg RELEASE_DIGEST="$routine_digest" \
  --build-arg BUNDLE_ID=routine-runner -t retainer:routine-runner .
pnpm test:routines:compose
pnpm test:files:compose
pnpm test:agent:compose
