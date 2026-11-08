# Self-hosting

Retainer is one Docker image and Postgres 18 or later; its migrations don't run
on 17. The image runs the REST API, the MCP endpoint, the background workers
and, optionally, the web app. To run it on AWS Lambda and RDS instead, see
[Deploying to AWS](aws.md).

## Start it

```sh
git clone https://github.com/Tamloot-cc/Retainer.git
cd Retainer
docker compose -f docker/compose.yml up --build -d
curl localhost:8787/health
# {"status":"ok","version":"0.1.0","database":"ok"}
```

The container applies pending database migrations every time it starts, then
starts the server. On first boot it creates a workspace named `Default` and
prints an admin API key once:

```sh
docker compose -f docker/compose.yml logs retainer
```

Save that key; Retainer stores only its hash. It acts as `user:admin` with
every scope.

## Workspaces and API keys

Workspaces and keys are managed with the operator CLI inside the container. It
connects to the database directly; there is no admin HTTP API, and no API key
can create a workspace or another key.

```sh
alias retainer='docker compose -f docker/compose.yml exec retainer retainer'

retainer workspace create --name "Acme Clinic" --template clinic
retainer workspace list
retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
retainer key list --workspace acme-clinic
retainer key revoke <key-id>
```

`key create` prints the key (`rtn_…`) once. Add `--json` to any command for
machine-readable output.

**Give every agent and every person their own key.** The key decides which
workspace a call acts on and who its writes are attributed to.

| Scope          | Allows                                                               |
| -------------- | -------------------------------------------------------------------- |
| `read`         | Reading the schema, records, events, facts, search and context packs |
| `write`        | Creating and updating records, logging events, `remember`, review    |
| `schema:write` | Applying templates and requesting schema changes                     |
| `admin`        | Everything above, plus deciding proposed schema changes and `forget` |

The actor type matters as much as the scope:

| Actor type    | Use for                  | Notes                                                                                                                                                                                                                                     |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`        | People, and the web app  | Highest precedence. Only users can accept or reject pending values, merge records, dismiss merge suggestions and run `forget`; only a user with `admin` applies destructive schema changes or approves proposed ones.                     |
| `integration` | Syncs from other systems | Outranks agents, ranks below people.                                                                                                                                                                                                      |
| `agent`       | AI agents                | Cannot silently overwrite a value a person or integration set: a newer agent value waits in review. Destructive schema changes it requests (rename, remove, make required or unique) are proposed, not applied, even with an `admin` key. |
| `system`      | Retainer's own jobs      | Lowest precedence. Not for keys you hand out.                                                                                                                                                                                             |

## Configuration

Set these on the `retainer` service in `docker/compose.yml`, or in `.env`
when running from source.

| Variable                                | Default          | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | —                | Postgres connection string for the role that owns the tables. Required. Migrations and the CLI use it, and so do the API and workers unless the next variable is set.                                                                                                                                                                                       |
| `RETAINER_RUNTIME_DATABASE_URL`         | —                | Optional. A login as `retainer_app` for the API's and workers' connections, with a password you choose (printable ASCII, no spaces), so a query bug can't act as the table owner. The server sets the password on start; change it here and restart to rotate it.                                                                                           |
| `RETAINER_ROLE`                         | `all`            | `api` (REST, MCP, web app), `worker` (scheduled consolidator), `control` (`/account`, in accounts mode) or `all`. Split them to run each in its own container.                                                                                                                                                                                              |
| `PORT`                                  | `8787`           | HTTP port.                                                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                             | `info`           | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                                                                                                                                         |
| `RETAINER_PUBLIC_ORIGIN`                | —                | The browser-facing origin when TLS ends at a reverse proxy, e.g. `https://retainer.example`. Used for CSRF checks and the session cookie. Forwarded headers are never trusted.                                                                                                                                                                              |
| `RETAINER_SUPPRESSION_KEY`              | —                | Needed for `forget`. At least 32 characters (`openssl rand -hex 32`). Keep it stable: erased emails, phones and event identities are stored only as an HMAC under this key. To rotate it, move the old key to `RETAINER_SUPPRESSION_PREVIOUS_KEYS`; dropping an old key lets its erased handles back in and blocks logging events until it is listed again. |
| `RETAINER_SUPPRESSION_PREVIOUS_KEYS`    | —                | Earlier suppression keys, comma-separated, still checked after a rotation so erased handles and events stay suppressed.                                                                                                                                                                                                                                     |
| `RETAINER_CONSOLIDATE_INTERVAL_MINUTES` | `60`             | How often the consolidator dedupes facts and suggests merges in each workspace.                                                                                                                                                                                                                                                                             |
| `RETAINER_WEB_DIR`                      | set in the image | Directory of the built web app, served at `/app`. Leave unset to serve no web app.                                                                                                                                                                                                                                                                          |
| `RETAINER_DB_POOL_MAX`                  | `10`             | Database connections the API process opens. Lower it when many processes share one database.                                                                                                                                                                                                                                                                |
| `RETAINER_AUTH_SECRET`                  | —                | Turns on [accounts mode](#accounts-mode). At least 32 characters (`openssl rand -hex 32`). Signs people's session cookies, so changing it signs everyone out.                                                                                                                                                                                               |
| `RETAINER_GOOGLE_CLIENT_ID`             | —                | Accounts mode: the Google OAuth client people sign in with. Set it with the next one wherever `/account` is served.                                                                                                                                                                                                                                         |
| `RETAINER_GOOGLE_CLIENT_SECRET`         | —                | Accounts mode: that client's secret.                                                                                                                                                                                                                                                                                                                        |
| `RETAINER_CONTROL_DATABASE_URL`         | —                | Optional, accounts mode. A login as `retainer_control` for `/account`, with a password you choose, set by the server on start like the runtime login. Without it, `/account` uses the owner's login and switches to `retainer_control`.                                                                                                                     |
| `RETAINER_RATE_LIMIT_PER_MINUTE`        | 600 or none      | Requests a minute each workspace may make to `/v1` and `/mcp`, across all its keys and connected apps; past it the API answers `429` with `Retry-After`. 600 in accounts mode, none in key mode. `0` turns it off.                                                                                                                                          |

## The web app

The image serves the review and records app at `http://<host>:8787/app/`.
Create a personal key for each reviewer with a `user` actor:

```sh
retainer key create --workspace acme-clinic \
  --name "Dana (web)" --actor user:dana --scopes read,write,admin
```

The key is entered once on the sign-in screen and kept in an HTTP-only,
same-site cookie, never in browser storage. Outside localhost, serve Retainer
over HTTPS; Secure cookies require it. Revoking the key ends access at once.

In [accounts mode](#accounts-mode) people sign in with Google or a passkey
instead, and each workspace has its own address, `/app/w/<slug>/`.

## Accounts mode

By default Retainer runs in key mode: everyone, people included, uses an API
key. In accounts mode people sign in to the web app with Google or a passkey,
and get a role in each workspace instead of a key. Agents keep using API keys,
which workspace admins now create in the web app, or connect over OAuth with a
person's sign-in, as Claude's web app does ([Connecting agents](agents.md#connecting-claudes-web-app-over-oauth)).

Accounts mode is on when `RETAINER_AUTH_SECRET` is set, together with a Google
OAuth client:

1. In the Google Cloud console, create an OAuth client of type "Web
   application". Add `https://<your origin>/account/auth/callback/google` as an
   authorized redirect URI. While the consent screen is in "Testing", only the
   test users you list there can sign in; publish it to let anyone in.
2. Set `RETAINER_AUTH_SECRET`, `RETAINER_GOOGLE_CLIENT_ID`,
   `RETAINER_GOOGLE_CLIENT_SECRET` and `RETAINER_PUBLIC_ORIGIN`, then restart.

Sign-up is open: anyone with a Google account can sign in and create a
workspace of their own, in an organization of their own. They see only what
they create or are invited to.

Nothing limits how many workspaces or members an organization has unless you
set a quota. Once full, creating a workspace or inviting someone more is
refused with `limit_reached`; `none` removes a limit:

```sh
retainer org limit --org Acme --workspaces 3 --members 10
retainer org limit --org Acme --members none
```

Workspaces that existed before go into one organization named `Default`, with
no owner. Give it one once that person has signed in:

```sh
retainer org list
retainer member add --org Default --email dana@example.com --role owner
```

Owners and admins of an organization are admins in every workspace in it.
Everyone else gets a role in each workspace they are added to:

| Role   | Can                                                                                      |
| ------ | ---------------------------------------------------------------------------------------- |
| Viewer | See everything in the workspace                                                          |
| Editor | Also add and change records, comment and review                                          |
| Admin  | Also change the workspace's structure, erase personal data, and manage people and agents |

People invite others from **Settings** in the web app, which gives a link to
send; Retainer sends no email. The CLI can do the same for people who have
signed in once:

```sh
retainer org create --name "Acme"
retainer workspace create --name "Acme Clinic" --org Acme
retainer workspace move acme-clinic --org Acme
retainer member add --workspace acme-clinic --email ben@example.com --role editor
```

Removing someone, or lowering their role, applies at their next request, and
so do the apps they connected over OAuth. Keys they created keep working until
an admin revokes them.

Organization owners and admins delete a workspace from **Settings** by typing
its name. It disappears at once: its keys, connected apps and members lose
access. The server removes its data for good 7 days later, checking hourly
from the `control` (or `all`) process. Until then you can undo it, or remove
it at once:

```sh
retainer workspace list                 # marks deleted ones and when they go for good
retainer workspace restore acme-clinic
retainer workspace purge                # removes every workspace deleted over 7 days ago
```

## Upgrading

Pull the new release, rebuild and restart. Migrations run on start and are
forward-only, so back up the database before upgrading. After them, the
server adds the base objects, event types and template fields the release
defines to workspaces created before it, and logs each workspace it upgraded.
It never re-creates what a workspace deleted. If a workspace's own object
already uses a new built-in name, the log says so; rename that object and
restart to add the built-in one.

Run one version at a time: stop every Retainer container of the old version
before the new one starts. A migration can change what the server writes,
and an old server that keeps writing after it ran leaves rows the new one
does not expect. For example, search text written by an older server is
never rebuilt. With the single `retainer` container below, `up` does this.
With separate API and worker containers or several replicas, stop all of
them first, but not Postgres (for example
`docker compose -f docker/compose.yml stop retainer`).

```sh
docker compose -f docker/compose.yml exec postgres \
  pg_dump -U retainer retainer > retainer-$(date +%F).sql
git pull && docker compose -f docker/compose.yml up --build -d
```

### From Postgres 17

The compose file used Postgres 17 before it moved to 18, and Postgres 18
cannot open a 17 data directory. Postgres 18 also keeps its data under
`/var/lib/postgresql/18/docker`, so the volume now mounts at
`/var/lib/postgresql`. Move with `pg_dumpall`, not `pg_dump`: the server
connects through the `retainer_app` and `retainer_control` roles, and only
`pg_dumpall` carries roles. Dump before pulling, while Postgres 17 runs:

```sh
docker compose -f docker/compose.yml exec -T postgres \
  pg_dumpall -U retainer > retainer-pg17.sql
docker compose -f docker/compose.yml down
docker volume rm docker_pgdata
git pull && docker compose -f docker/compose.yml up -d --wait postgres
docker compose -f docker/compose.yml exec -T postgres \
  psql -U retainer -d postgres < retainer-pg17.sql
docker compose -f docker/compose.yml up --build -d
```

The restore reports that role `retainer` and database `retainer` already
exist; those two errors are expected. Any other error means the move did not
finish: keep `retainer-pg17.sql` and do not start the `retainer` container.

## Privacy requests

`POST /v1/records/:id/forget` hard-deletes a person: the record with its
facts and assertions, and the events they took part in, along with the
claims and facts that rested only on those events. Their emails and phones
are kept only as keyed hashes, so agents cannot recreate the person from old
email, and so are the source IDs of erased events, so logging the same
source again is refused. It needs a `user` key with the `admin` scope and
`RETAINER_SUPPRESSION_KEY` set. The response gives counts only, plus other
rows that may still mention the person for someone to review; Retainer does
not edit free text on its own.
