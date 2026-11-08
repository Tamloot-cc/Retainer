#!/usr/bin/env bash
# Ships a package built by build.sh to a deployment Terraform created.
#   AWS_REGION=eu-central-1 deploy/aws/deploy.sh [--name retainer] [--package path.zip]
#
# One version runs at a time (docs/self-hosting.md, Upgrading), so this:
#   1. updates the ops function, which runs migrations,
#   2. stops the api, consolidate and, in accounts mode, control functions
#      (reserved concurrency 0),
#   3. migrates, sets their database logins and upgrades existing
#      workspaces to the new definitions,
#   4. updates them,
#   5. starts them again with the concurrency Terraform set.
# Requests during steps 2-5 get 503 from API Gateway, usually for well under
# a minute. If the migration fails, the functions stay stopped and the
# script exits non-zero: fix the cause, then run it again. It refuses to
# start at all while the database runs a PostgreSQL older than 18.
set -euo pipefail

name=retainer
package="$(cd "$(dirname "$0")" && pwd)/.build/retainer.zip"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --package) package="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
: "${AWS_REGION:?set AWS_REGION}"
test -f "$package" || { echo "No package at $package; run build.sh first." >&2; exit 1; }

update() {
  echo "Updating $1"
  aws lambda update-function-code --function-name "$1" --zip-file "fileb://$package" >/dev/null
  aws lambda wait function-updated --function-name "$1"
}

stop() {
  echo "Stopping $1"
  aws lambda put-function-concurrency --function-name "$1" \
    --reserved-concurrent-executions 0 >/dev/null
}

start() {
  local arn concurrency
  arn="$(aws lambda get-function-configuration --function-name "$1" --query FunctionArn --output text)"
  concurrency="$(aws lambda list-tags --resource "$arn" \
    --query 'Tags."retainer:reserved-concurrency"' --output text)"
  echo "Starting $1 (concurrency $concurrency)"
  aws lambda put-function-concurrency --function-name "$1" \
    --reserved-concurrent-executions "$concurrency" >/dev/null
}

# Accounts mode adds the control function (functions.tf).
services=("$name-api" "$name-consolidate")
if found="$(aws lambda get-function --function-name "$name-control" 2>&1)"; then
  services+=("$name-control")
elif ! grep -q ResourceNotFoundException <<<"$found"; then
  echo "$found" >&2
  exit 1
fi

# The migrations need PostgreSQL 18 or later (packages/server/src/db/migrate.ts).
# After terraform apply, RDS waits for the maintenance window to upgrade from
# 17, so check before stopping anything: the API keeps running on a no.
engine="$(aws rds describe-db-instances --db-instance-identifier "$name" \
  --query 'DBInstances[0].EngineVersion' --output text)"
if ! [ "${engine%%.*}" -ge 18 ] 2>/dev/null; then
  echo "The database runs PostgreSQL $engine; this version needs 18 or later." >&2
  echo "Deploy again once RDS has upgraded it (docs/aws.md, Upgrading from PostgreSQL 17)." >&2
  exit 1
fi

update "$name-ops"

for service in "${services[@]}"; do stop "$service"; done
# Stopping only blocks new invocations. Let API requests already running on
# the old version finish (the function times out after 29 seconds); the
# migration itself waits for a consolidator pass in flight (deploy-lock.ts).
sleep 30

echo "Migrating"
result="$(mktemp)"
trap 'rm -f "$result"' EXIT
error="$(aws lambda invoke --function-name "$name-ops" \
  --cli-binary-format raw-in-base64-out --payload '{"command":"migrate"}' \
  --cli-read-timeout 900 "$result" --query FunctionError --output text)"
if [ "$error" != "None" ]; then
  echo "Migration failed; ${services[*]} stay stopped:" >&2
  cat "$result" >&2
  echo >&2
  exit 1
fi
cat "$result"
echo

for service in "${services[@]}"; do update "$service"; done
for service in "${services[@]}"; do start "$service"; done
echo "Deployed."
