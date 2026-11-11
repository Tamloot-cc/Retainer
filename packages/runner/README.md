# @retainer/runner

MIT runtime for first-party, release-bundled functions. The current bundle contains
only a deterministic test fixture. It is not advertised in the default catalog.

Each invocation arrives on stdin in a fresh Node 24 container. The entry point
checks the baked release digest, function ID, protocol, input size and deadline.
It emits one bounded status/code result and exits; errors never serialize provider
responses or environment values. Handlers use an installation/run token through
the public API. No server implementation is imported here.

The launcher chooses an immutable image from trusted configuration; invocation
JSON cannot supply images, commands, paths or module URLs. Container creation
uses a read-only root, non-root UID, dropped capabilities, no host mounts, bounded
tmpfs, CPU/memory/PID/time limits, and a fresh isolated internal network containing
only that run and trusted API/proxy endpoints. The Docker socket belongs to the
trusted launcher alone. Its daemon access is a host-level privilege.

Public egress goes through a proxy that checks every destination and pins DNS
answers to the connection. Node 24's proxy configuration is documented in the
[Node CLI reference](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_use_env_proxy1).
The network uses Docker's isolated gateway mode so the bridge has no host address;
see [Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
The proxy blocks private, loopback, link-local, metadata and reserved destinations
except the configured API authority. Raw outbound connections have no route.
Separate networks prevent execution containers from reaching each other.

This is reviewed first-party isolation, not a hostile third-party sandbox claim.
Installation secrets fetched during a run remain that run's responsibility;
handlers must not log provider bodies or credentials.

## Local verification

Build the packages, then the test images:

```sh
pnpm build
docker build -f docker/Dockerfile -t retainer:extensions-review .
docker build -f docker/Dockerfile.extension-runner \
  --build-arg RELEASE_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --build-arg BUNDLE_ID=fixture -t retainer:extension-runner-fixture .
pnpm test:extensions:sandbox
```

The fixed digest here is exclusively a test fixture. Production artifact/digest
publication and hosted staging remain separate acceptance requirements. The
smoke test checks actual Docker resources, blocked proxy and raw egress, API
reachability, fresh invocations and container/network removal. Its HTTP fixture
is not evidence of CRM authorization; real-Postgres API tests cover that boundary.
