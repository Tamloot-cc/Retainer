# Files

File bytes live outside Postgres. A `files` value is an ordered, deduplicated list
of up to 20 ready immutable file IDs; assertions and history retain those IDs.
Files are neither searchable, filterable, unique nor usable as labels. The base
conversation type has a `transcript` files field with a permanent universal ID.
Personal-memory attachments are not supported.

## API and SDK

1. `POST /v1/files/intents` with `Idempotency-Key` and
   `{name, mediaType, bytes, sha256}`. SHA-256 is lowercase hex. Default maximum is
   25 MiB, with a 1 GiB quota and 10,000 retained active objects per workspace.
   Concurrent reservations serialize; quota failures return 429.
2. PUT bytes to `upload.url` with `upload.headers`. The URL expires within five
   minutes. It cannot overwrite an existing object. Do not place bytes or base64
   in a JSON request, assertion, job or log.
3. `POST /v1/files/:id/finalize`. Retainer checks object existence, exact size,
   SHA-256, media type and ownership. A pending object cannot be attached.
4. Write the returned ID in a normal assertion, for example
   `{attachments: [fileId]}` or a conversation's `transcript` field. A run may
   finalize and attach only its own installation's uploads. Revoked runs cannot
   finalize. Unattached uploads remain private to their originating credential.
5. `GET /v1/files/:id` returns metadata only when a currently visible record
   references the file, including retained assertion history. Record merges keep
   that association through the assertion. `POST /v1/files/:id/download` checks
   current visibility and issues a download lasting at most 60 seconds.

The SDK exposes `createFileIntent`, `finalizeFile`, `file`, `downloadFile` and
`fileErasureStatus`. MCP exposes `create_file_upload`, `finalize_file`, `get_file`
and `download_file`, with the same services and scopes. Neither accepts a
workspace selector or file bytes. The web field editor uploads and verifies
before saving an assertion, blocks Save while uploading, and offers attachment
downloads. HTML/SVG and other unsafe content are never rendered inline.

## Local service and Compose

The optional `docker/compose.files.yml` overlay adds a dedicated byte service and
private volume, plus a storage worker. The byte service has no database URL,
CRM credential, Docker socket or extension volume mount. Only opaque random
object keys become filesystem paths; client filenames never select paths.
Upload tickets are action/key/expiry/metadata bound HMACs. The service streams
bounded uploads to private temporary files, verifies their digest/length, then
publishes them exclusively. It is non-root with a read-only root filesystem.

Set a strong external base64 `RETAINER_FILE_SIGNING_KEY` on the API, byte service
and storage worker. Set `RETAINER_FILE_PUBLIC_ORIGIN` to the browser-reachable
file origin and `RETAINER_PUBLIC_ORIGIN` to the API origin for exact CORS. The
local defaults use API port 8787 and file port 8788. The internal control origin
is `http://file-bytes:8790`; API clients cannot choose it. The storage worker waits
for healthy API initialization, avoiding concurrent first-boot migrations.

```sh
docker compose -f docker/compose.yml -f docker/compose.files.yml up --build
```

To combine first-party execution and files, also include
`docker/compose.extensions.yml` and `docker/compose.extension-files.yml`. The
latter gives only the egress proxy access to the file bridge and allows the exact
file-service authority. Runs still have no file-volume, host, DB or raw internet
access. File uploads/downloads use their signed transfers through that proxy.

Relevant operator settings:

- `RETAINER_FILE_STORAGE`: `local` or `s3`; unset means unavailable.
- `RETAINER_FILE_PUBLIC_ORIGIN`, `RETAINER_FILE_CONTROL_ORIGIN`, and
  `RETAINER_FILE_EXECUTION_ORIGIN`: public, trusted control and runner transfer
  origins. The final two default to the public origin.
- `RETAINER_FILE_SIGNING_KEY`: local ticket key, outside the database.
- `RETAINER_FILE_STORAGE_ID`: stable local-volume identity, default `local-v1`.
- `RETAINER_FILE_QUOTA_BYTES`: quota per workspace, default 1 GiB.
- `RETAINER_FILE_S3_BUCKET`: dedicated private bucket for the S3 adapter.

Stored objects and deletion obligations retain their storage identity. Switching
backends does not silently claim that old storage was erased; retain a worker for
each old backend through migration. The current service configures one backend.

## S3

The open-source S3 adapter uses immutable conditional PUTs with signed size,
media type and SHA-256, SSE-S3, HEAD verification, and attachment-only downloads.
It enumerates and removes content-bearing retained versions during erasure.
Executions receive signed URLs, never bucket credentials. API and maintenance
roles need separately scoped permissions for their dedicated bucket. Hosted
bucket/IAM/CORS/scheduling configuration belongs in `retainer-cloud` and remains
unverified in a live AWS environment in this implementation milestone.

The conditional-write and checksum contracts follow AWS's
[PutObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [HeadObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
Local tests verify the signed request policy; they are not a live S3 test.

## Retention and erasure

Unattached pending/ready objects expire after 24 hours. Collection holds file row
locks and rechecks every retained assertion reference, including superseded or
rejected claims; it cannot race a successful attachment into deleting its bytes.
A current-field clear or a record's soft deletion does not discard its history.

`forget` collects files before assertion/record cascades. In the same privacy
transaction it revokes file visibility, removes identifying metadata and file
IDs from all shared/historical copies, recomputes affected records and queues
opaque deletion obligations. The response identifies pending storage erasure;
the web report polls admin-only `POST /v1/files/erasure-status` and declares
completion only after the worker acknowledges it. A failed storage operation
keeps a durable pending obligation with a safe error code and retry delay.

Workspace cascades preserve those obligations independently of the deleted
workspace. A discovery-only role returns due tenant IDs, including deleted
tenants; storage calls run outside DB transactions. Leases and fences prevent a
replaced worker from falsely acknowledging completion. No filename, transcript
or credential enters the deletion job.

Erasure removes all content bytes and content-bearing retained versions. An
opaque zero-byte barrier may remain under the random object key: it prevents a
previously signed or already-started upload from recreating erased content.
Concurrent reclaimed workers retain each other's barriers. Storage lifecycle
rules must preserve that protection; a delete followed by a late upload is not
successful privacy erasure. Already-issued downloads have a maximum 60-second
window. Managed source binding and erasure of unattached ingestion artifacts are
part of the source-ingestion continuation; no provider integration is advertised.

## Verification

`pnpm test:files:compose` uses disposable Compose resources, a real volume and
Postgres, public API upload/finalize/assertion/download, immediate authorization
revocation, scheduled erasure confirmation and late-upload rejection. Build
`retainer:files-review` from `docker/Dockerfile` first. This command removes only
its own project and volumes. Integration tests also cover quota races, cross-
workspace/installation ownership, revocation, retained history, record merges,
orphan/attachment races, shared-copy erasure, MCP and workspace cascades.
