#!/usr/bin/env bash
# The Docker tests CI leaves out of push and pull-request runs (a release still
# runs them): the extension sandbox, the extension lifecycle in Compose and file
# storage in Compose. Run before pushing a change to docker/, the extension
# runtime or file storage. Needs Docker; run `pnpm build` first.
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -f docker/Dockerfile -t retainer:extensions-review -t retainer:files-review .
docker build -f docker/Dockerfile.extension-runner \
  --build-arg RELEASE_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --build-arg BUNDLE_ID=fixture -t retainer:extension-runner-fixture .
pnpm test:extensions:sandbox

node scripts/build-extension-artifacts.mjs --development
digest=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/extensions/fixture/metadata.json')).releaseDigest")
docker build -f docker/Dockerfile.extension-runner --build-arg RELEASE_DIGEST="$digest" \
  --build-arg BUNDLE_ID=fixture -t retainer:extension-runner-fixture .
pnpm test:extensions:compose
pnpm test:files:compose
