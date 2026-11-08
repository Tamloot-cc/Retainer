# Deploying to AWS

`deploy/aws` runs Retainer on AWS without containers: the same server code as
the Docker image, as Lambda functions behind API Gateway, with PostgreSQL on
RDS. Everything stays in one AWS account and region, and nothing else
(no CDN, no other service) sees the traffic or the data.

For a single server, the Docker image in [Self-hosting](self-hosting.md) is
simpler. This deployment suits a hosted service: no server to patch, a
managed database with point-in-time recovery, and a bill that follows use.

## What it creates

| Piece                                        | AWS service                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| REST (`/v1`), MCP (`/mcp`), web app (`/app`) | `<name>-api` Lambda function behind an API Gateway HTTP API                                                  |
| Consolidator                                 | `<name>-consolidate` function, run by EventBridge every 15 minutes                                           |
| Migrations and the operator CLI              | `<name>-ops` function, invoked by `deploy.sh` and `ops.sh`                                                   |
| Sign-in and `/account` (accounts mode only)  | `<name>-control` function, with a NAT gateway; EventBridge runs it hourly to remove deleted workspaces       |
| Database                                     | RDS PostgreSQL 18, encrypted, private, 14 days of point-in-time backups                                      |
| Network                                      | A VPC of its own with two private subnets, no internet gateway or NAT, except for `control` in accounts mode |
| Monitoring                                   | Log groups (30 days), alarms on 5xx, consolidator errors and the database                                    |
| Custom domain (optional)                     | ACM certificate and an API Gateway domain                                                                    |
| CI deploy role (optional)                    | IAM role a GitHub Environment assumes to apply the infrastructure and ship code                              |

The api, consolidate and ops functions reach only the database, and the
database only accepts the functions. They make no outbound calls, so they
have no route to the internet. In [accounts mode](#accounts) the control
function signs people in with Google and reads the client metadata documents
apps such as Claude identify themselves with, which needs one: it runs in
subnets of its own whose only way out is a NAT gateway, and the other
functions keep none. The api function checks OAuth tokens against keys in the
database, with no call out.

With the defaults, a small deployment costs about $17–20 a month in
eu-central-1: the `db.t4g.micro` instance (about $14), 20 GB of storage, and
cents for Lambda, API Gateway and logs at personal volume. Accounts mode adds
a NAT gateway and its public address, about $40 a month more.

## Before you start

- An AWS account and credentials that can create the resources above.
- Terraform 1.10 or later, AWS CLI v2, `jq`, Node 26 and pnpm.

All commands run from the repository root unless noted, with `AWS_REGION`
set:

```sh
export AWS_REGION=eu-central-1
```

## First deployment

1. Create the bucket for Terraform's state. It prints the backend
   configuration:

   ```sh
   deploy/aws/state-bucket.sh > deploy/aws/backend.hcl
   ```

2. Copy `deploy/aws/terraform.tfvars.example` to `deploy/aws/terraform.tfvars`
   and set at least `region`. Both files are gitignored. `name` (default
   `retainer`) prefixes every resource and must be unique in the AWS
   account, because IAM role names are account-wide: a second deployment,
   in this region or another, needs a name of its own (and
   `state-bucket.sh <name>`).

3. Build the Lambda package and create the infrastructure. The database takes
   5–10 minutes:

   ```sh
   deploy/aws/build.sh
   cd deploy/aws
   terraform init -backend-config=backend.hcl
   terraform apply
   cd ../..
   ```

4. Migrate the database and start the functions:

   ```sh
   deploy/aws/deploy.sh
   ```

5. Create a workspace and keys. `ops.sh` takes the same commands as the
   [operator CLI](self-hosting.md#workspaces-and-api-keys):

   ```sh
   deploy/aws/ops.sh workspace create --name "Acme" --template sales
   deploy/aws/ops.sh key create --workspace acme --name "Maya (web)" \
     --actor user:maya --scopes read,write,admin
   deploy/aws/ops.sh key create --workspace acme --name "Inbox agent" \
     --actor agent:inbox --scopes read,write,schema:write
   ```

   Unlike the container, this deployment creates no workspace and prints no
   key on its own: a key printed at boot would land in the logs.

6. Check it, using the `public_origin` output:

   ```sh
   curl "$(terraform -chdir=deploy/aws output -raw public_origin)/health"
   # {"status":"ok","version":"0.1.0","database":"ok"}
   ```

Connect agents to `<public_origin>/mcp` as in
[Connecting agents](agents.md), and open the web app at
`<public_origin>/app/`.

## A custom domain

The API Gateway URL works as is. To serve Retainer on your own domain:

1. Set `domain_name` in `terraform.tfvars` and apply. The `dns_records`
   output lists the certificate's validation record.
2. Create that record at your DNS provider and wait until the certificate
   shows as issued in ACM (usually a few minutes).
3. Set `domain_certificate_validated = true` and apply again. `dns_records`
   now also lists the CNAME for the domain itself; create it.

The domain becomes the only way in: the API Gateway URL is turned off, and
`RETAINER_PUBLIC_ORIGIN` is set to the domain, so sign-in from the web app
works only there. Create the records as DNS only: a proxy in front (such as
Cloudflare's orange cloud) would see every request.

API Gateway refuses a request whose headers add up to more than 10 KB, with
`431 Request Header Fields Too Large`. Browsers send Retainer every cookie set
on a parent domain, so if another app on that domain stores large cookies
there (a login token, for example), use a subdomain it doesn't share, or have
that app keep its cookies on its own host.

## Shipping new versions

`deploy.sh` ships the package `build.sh` made. Because one version runs at
a time (see [Upgrading](self-hosting.md#upgrading)), it stops the API,
the consolidator and, in accounts mode, the control function, migrates, upgrades existing workspaces to the release's
built-in definitions (printed under `workspaceUpgrade` in the migration
result), updates them and starts them again. Requests in
that window, usually under a minute, get `503`. If the migration fails, the
functions stay stopped; fix the cause and run `deploy.sh` again. Stopping a
function only blocks new runs, so the migration first waits, up to 330
seconds, for a consolidator pass already running on the old version to
finish (a Postgres lock each pass holds); if one is still running, nothing
is migrated and the deploy fails, to be run again.

```sh
deploy/aws/build.sh && deploy/aws/deploy.sh
```

The [Deploy to AWS workflow](#from-github-actions) can do this from GitHub
instead, together with `terraform apply`.

**Upgrading to separate database logins.** A deployment created before the
functions had their own logins needs `terraform apply` once, then
`deploy.sh` right away. Until `deploy.sh` has migrated, the API and the
consolidator fail, because they no longer have the owner's password and
`retainer_app` cannot log in yet.

**Upgrading from PostgreSQL 17.** Retainer needs 18 or later. If
`terraform.tfvars` sets `db_engine_version = "17"`, remove that line first;
Terraform rejects versions below 18. A deployment created with 17 then moves
to 18 on the next `terraform apply`: RDS takes a snapshot and upgrades the
database in place during the next maintenance window (`maintenance_window` in
`database.tf`), with several minutes of downtime. The same apply moves the functions from the `nodejs22.x` runtime to `nodejs24.x`
(Lambda's Node 26 runtime is still a preview). Run `deploy.sh` after the
upgrade. Until RDS reports 18, it stops before changing anything, and the
running version keeps serving.

Terraform creates the functions with the package and then leaves their code
alone, so `terraform apply` never rolls a deployment back to an old package.

### From GitHub Actions

Applying and deploying from your machine works on its own; this route is
optional. The **Deploy to AWS** workflow runs CI, then `terraform apply`
and `deploy.sh`, by hand and from the default branch only. Set it up after
the [first deployment](#first-deployment):

1. Set `github_repository = "<owner>/<repo>"` in `terraform.tfvars` and
   apply. This creates a role the workflow assumes. It can manage the
   resources this deployment creates, read and write its Terraform state,
   and ship code to its functions. On the network it can only create
   resources tagged `Application = <name>` and change those that carry
   the tag, so other projects in the account and region stay out of
   reach. Because of that, two network changes need more than one run:
   a new VPC is an apply of your own, since AWS creates its defaults
   untagged; and turning accounts mode off releases the NAT gateway's
   address only on a second workflow run. The state is where
   `state-bucket.sh` put it; if yours is elsewhere, set `state_bucket`
   and `state_key` too.
   The role cannot change its own permissions: when an update changes
   them, the workflow stops before applying, and you run `terraform apply`
   yourself. The role trusts the account's OIDC provider for GitHub
   Actions. An account holds one, shared by every repository's roles, so
   this deployment uses it but never creates or deletes it. If
   `aws iam list-open-id-connect-providers` shows none for
   `token.actions.githubusercontent.com`, create it once:

   ```sh
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

   The role trusts jobs whose OIDC subject starts with
   `repo:<owner>/<repo>`. A repository with immutable subject claims signs
   `repo:<owner>@<owner-id>/<repo>@<repo-id>` instead, and assuming the
   role fails with "Not authorized to perform
   sts:AssumeRoleWithWebIdentity". GitHub switches some repositories to
   that format on its own, such as those created or renamed after July
   2026, so check the prefix GitHub actually uses rather than the opt-in
   flag: run `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`,
   and if its `sub_claim_prefix` differs from `repo:<owner>/<repo>`, set
   `github_subject_prefix` to it and apply again.
2. In the repository's settings, create the `production` environment.
   Under deployment branches, allow only the default branch: the role trusts
   every job in that environment.
3. Give the environment Terraform's inputs, from `backend.hcl` and
   `terraform.tfvars`. Leave out the optional ones you have not set.

   | Name                           | Set as             | Value                                    |
   | ------------------------------ | ------------------ | ---------------------------------------- |
   | `AWS_ROLE_ARN`                 | variable           | the `github_deploy_role_arn` output      |
   | `AWS_REGION`                   | variable           | `region`                                 |
   | `TF_STATE_BUCKET`              | variable           | `bucket` in `backend.hcl`                |
   | `TF_STATE_KEY`                 | variable           | `key` in `backend.hcl`                   |
   | `TF_STATE_REGION`              | variable, optional | `region` in `backend.hcl`, if it differs |
   | `RETAINER_NAME`                | variable, optional | `name`                                   |
   | `DOMAIN_NAME`                  | variable, optional | `domain_name`                            |
   | `DOMAIN_CERTIFICATE_VALIDATED` | variable, optional | `domain_certificate_validated`           |
   | `ALARM_EMAIL`                  | variable, optional | `alarm_email`                            |
   | `OIDC_SUBJECT_PREFIX`          | variable, optional | `github_subject_prefix`                  |
   | `GOOGLE_CLIENT_ID`             | variable, optional | `google_client_id`                       |
   | `GOOGLE_CLIENT_SECRET`         | secret, optional   | `google_client_secret`                   |

   For example:

   ```sh
   gh variable set TF_STATE_BUCKET --env production --body "<bucket>"
   gh secret set GOOGLE_CLIENT_SECRET --env production   # reads the value from stdin
   ```

   `github_repository` is the repository the workflow runs in. Every other
   setting keeps its default; if your `terraform.tfvars` changes one, add
   it to the plan step in `.github/workflows/deploy-aws.yml` as well, or
   the workflow's plan would set it back.

Run it from the Actions tab or with `gh workflow run deploy-aws.yml`. Each
run plans, applies the plan if it changes anything, then runs `deploy.sh`.
The log shows the plan's summary line, such as
`Plan: 1 to add, 0 to change, 0 to destroy.`, not the plan itself; run
`terraform plan` locally to see what changes. A plan that destroys or
replaces a resource stops the run before applying; to apply it, run the
workflow again with **allow_destroy** set
(`gh workflow run deploy-aws.yml -f allow_destroy=true`).

## Operating it

**Logs.** Each function logs to `/aws/lambda/<name>-<function>`, and API
Gateway's access log (no headers or bodies) to `/aws/apigateway/<name>`.

**Alarms** publish to the `alarm_topic_arn` SNS topic. Set `alarm_email` to
subscribe an address; AWS emails a confirmation link first.

**Backups.** RDS keeps automated backups for `db_backup_retention_days`
(14 by default) and can restore to any second in that window, as a new
instance. Practise a restore before you need one. Deleting the instance
takes a final snapshot, named with a suffix of its own. To replace the
instance by hand, replace the suffix with it, so the new instance's final
snapshot gets a new name:
`terraform apply -replace=aws_db_instance.this -replace=random_id.final_snapshot`.

**Secrets.** Terraform generates the database passwords and
`RETAINER_SUPPRESSION_KEY`, and in accounts mode `RETAINER_AUTH_SECRET`, and
keeps them in its state, so treat the state bucket as secret. The Google
client secret is in it too. Only the ops function gets the password of the
role that owns the tables. The api and consolidate functions log in as
`retainer_app`, and the control function as `retainer_control`, each with a
password of its own, which the ops function sets each time it migrates, so
none can change the schema or become the owner. Never let Terraform replace `random_id.suppression_key`:
erased emails and phones are stored only as an HMAC under that key, so a new
key lets them back in.

**Connections.** Each API function instance holds up to `api_db_pool_max`
connections (2), and at most `api_reserved_concurrency` instances (10) run
at once. In accounts mode each control instance holds up to twice
`control_db_pool_max` (1), for at most `control_reserved_concurrency` (5)
instances. Keep the total, plus a few for the consolidator and ops
functions, under the instance's limit: about 80 on a `db.t4g.micro`. The
`database-connections` alarm warns at 60. `deploy.sh` owns the functions'
concurrency (it stops and starts them), so a new `api_reserved_concurrency`
takes effect at the next deploy, and `terraform apply` never restarts
functions that a failed deploy left stopped.

**Rate limiting.** API Gateway throttles at `api_throttle_rate` requests per
second (25) with bursts of `api_throttle_burst` (50). In accounts mode
sign-in also limits each address, and each workspace may make 600 requests a
minute to `/v1` and `/mcp` before getting `429`s. Both count in the database,
so the limits hold across Lambda instances.

## Accounts

In accounts mode people sign in to the web app with Google or a passkey,
and agents use API keys or connect over OAuth
([Self-hosting](self-hosting.md#accounts-mode) explains the roles). It is off until you give Terraform a Google OAuth
client:

1. Deploy once without it, so the public origin exists (`terraform output
   public_origin`); with a custom domain, attach it first.
2. In the Google Cloud console, create an OAuth client of type "Web
   application" and add the redirect URI that
   `terraform output google_redirect_uri` will print:
   `<public origin>/account/auth/callback/google`.
3. Add the client to `terraform.tfvars`, which is gitignored, or pass the
   secret as `TF_VAR_google_client_secret`:

   ```hcl
   google_client_id     = "1234-abc.apps.googleusercontent.com"
   google_client_secret = "..."
   ```

4. `terraform apply`, then `deploy/aws/deploy.sh`. The apply creates the
   control function, its subnets and NAT gateway, and routes `/account` to
   it; the deploy migrates and sets the control function's login.
5. Publish the OAuth consent screen. While it is in "Testing", only the test
   users listed there can sign in.

Existing workspaces go into an organization named `Default` with no owner.
Once you have signed in, make yourself its owner:

```sh
deploy/aws/ops.sh org list
deploy/aws/ops.sh member add --org Default --email you@example.com --role owner
```

Claude's web app then connects to `<public origin>/mcp` as a custom connector
([Connecting agents](agents.md#connecting-claudes-web-app-over-oauth)).

A workspace deleted from Settings is removed for good 7 days later, by an
EventBridge rule that runs the control function every hour. Like a
consolidator pass, the run holds the deploy lock, so a deploy waits for it,
and the control function's timeout is 300 seconds to allow for a large
workspace. To undo a deletion within those days:
`deploy/aws/ops.sh workspace restore <slug>`.

Removing the two variables and applying again turns accounts mode off and
removes the NAT gateway. People's accounts stay in the database.

## Limits of this deployment

- A request runs for at most 29 seconds, and a database query in it for 25,
  after which the API answers `503` `timeout`. Bodies are limited to API
  Gateway's 10 MB (Lambda's 6 MB once decoded).
- The first request to an idle function starts a new instance, which takes
  a second or two.
- The functions connect to the database over TLS without verifying the
  server's certificate (`sslmode=require`). The database is reachable only
  inside the VPC.
- In key mode, MCP clients authenticate with an API key as a bearer token.
  Clients that only support OAuth, such as connectors added in Claude's web
  app, need accounts mode.
- Accounts mode has one NAT gateway, in one availability zone. If that zone
  fails, signing in stops; everything else keeps working.

## Removing it

```sh
cd deploy/aws
terraform apply -var db_deletion_protection=false
terraform destroy
```

`destroy` keeps a final snapshot of the database (`<name>-final-<suffix>`,
a suffix of its own per database, so a recreated deployment can be
destroyed again), and the
state bucket; delete those yourself when you no longer need them. Removing
the functions' network interfaces can take AWS up to half an hour, so the
subnets and security groups may be the last to go.
