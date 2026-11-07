# Functions from one package (build.sh):
#   api          REST, MCP and the web app, behind API Gateway
#   consolidate  one consolidator pass, on a schedule
#   ops          migrations and the operator CLI, invoked by deploy.sh and ops.sh
#   control      accounts mode only: /account, where people sign in and
#                manage members and keys (accounts spec 4.6)
#
# Terraform creates them with the package at package_path and then ignores
# their code and their reserved concurrency: deploy.sh ships new versions and
# stops and starts the functions, so the order of stopping the API,
# migrating and starting it again lives in one place, and an apply never
# restarts functions a failed deploy left stopped.

resource "random_id" "suppression_key" {
  byte_length = 32 # 64 hex characters; RETAINER_SUPPRESSION_KEY needs 32+
}

# Accounts mode: signs session cookies. The control function issues them and
# the api function checks them, so both hold it.
resource "random_id" "auth_secret" {
  count       = local.accounts ? 1 : 0
  byte_length = 32 # 64 hex characters; RETAINER_AUTH_SECRET needs 32+
}

resource "aws_iam_role" "functions" {
  name = "${var.name}-functions"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Logs, and the network interfaces a function in a VPC needs. Nothing else:
# the functions call no AWS API.
resource "aws_iam_role_policy_attachment" "functions_vpc" {
  role       = aws_iam_role.functions.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

locals {
  accounts = var.google_client_id != null

  # random_id does not mark its values sensitive; these do, so no plan or
  # apply prints them.
  suppression_key = sensitive(random_id.suppression_key.hex)
  auth_secret     = sensitive(one(random_id.auth_secret[*].hex))

  public_origin = (
    var.domain_name != null && var.domain_certificate_validated
    ? "https://${var.domain_name}"
    : aws_apigatewayv2_api.this.api_endpoint
  )

  # Each function gets only the database login it needs (database.tf).
  common_env = {
    LOG_LEVEL    = var.log_level
    NODE_OPTIONS = "--enable-source-maps"
  }

  # Where each function runs: control alone has a route out (network.tf).
  isolated = {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.functions.id]
  }

  functions = merge({
    api = {
      handler     = "dist/lambda/api.handler"
      memory      = var.api_memory_mb
      timeout     = 29 # API Gateway's own limit is 30 seconds
      concurrency = var.api_reserved_concurrency
      env = merge({
        RETAINER_RUNTIME_DATABASE_URL = local.runtime_database_url
        RETAINER_PUBLIC_ORIGIN        = local.public_origin
        RETAINER_SUPPRESSION_KEY      = local.suppression_key
        RETAINER_WEB_DIR              = "/var/task/web"
        RETAINER_DB_POOL_MAX          = tostring(var.api_db_pool_max)
        }, local.accounts ? {
        # Checks people's session cookies.
        RETAINER_AUTH_SECRET = local.auth_secret
      } : {})
      network = local.isolated
    }
    consolidate = {
      handler     = "dist/lambda/consolidate.handler"
      memory      = 512
      timeout     = 300
      concurrency = 1
      env = {
        RETAINER_RUNTIME_DATABASE_URL         = local.runtime_database_url
        RETAINER_CONSOLIDATE_INTERVAL_MINUTES = tostring(var.consolidate_interval_minutes)
      }
      network = local.isolated
    }
    ops = {
      handler     = "dist/lambda/ops.handler"
      memory      = 512
      timeout     = 900 # a migration may rewrite large tables
      concurrency = 1   # never two migrations at once
      env = merge({
        DATABASE_URL = local.database_url
        # Read only to set the logins' passwords when migrating.
        RETAINER_RUNTIME_DATABASE_URL = local.runtime_database_url
        }, local.accounts ? {
        RETAINER_CONTROL_DATABASE_URL = local.control_database_url
      } : {})
      network = local.isolated
    }
    }, {
    # Accounts mode only; null references while it is off are never used.
    for key, value in {
      control = {
        handler = "dist/lambda/control.handler"
        memory  = 512
        # API Gateway still ends a request at 30 seconds; the scheduled run
        # that removes deleted workspaces (schedule.tf) may take longer.
        timeout     = 300
        concurrency = var.control_reserved_concurrency
        env = {
          RETAINER_CONTROL_DATABASE_URL = local.control_database_url
          RETAINER_PUBLIC_ORIGIN        = local.public_origin
          RETAINER_AUTH_SECRET          = local.auth_secret
          RETAINER_GOOGLE_CLIENT_ID     = var.google_client_id
          RETAINER_GOOGLE_CLIENT_SECRET = var.google_client_secret
          RETAINER_DB_POOL_MAX          = tostring(var.control_db_pool_max)
        }
        network = {
          subnets         = aws_subnet.control[*].id
          security_groups = aws_security_group.control[*].id
        }
    } } : key => value if local.accounts
  })
}

resource "aws_cloudwatch_log_group" "functions" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  for_each = local.functions

  function_name = "${var.name}-${each.key}"
  role          = aws_iam_role.functions.arn
  # nodejs26.x is still a public preview on Lambda (no SLA, not for production).
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = each.value.handler
  memory_size   = each.value.memory
  timeout       = each.value.timeout

  # Read only when creating a function (code changes are ignored below), so
  # plan, apply and destroy work from a checkout without a build.
  filename         = var.package_path
  source_code_hash = fileexists(var.package_path) ? filebase64sha256(var.package_path) : null

  reserved_concurrent_executions = each.value.concurrency

  vpc_config {
    subnet_ids         = each.value.network.subnets
    security_group_ids = each.value.network.security_groups
  }

  environment {
    variables = merge(local.common_env, each.value.env)
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.functions[each.key].name
  }

  # deploy.sh stops the API by setting its concurrency to 0 and restores it
  # from this tag, so a deploy that failed halfway cannot leave the wrong
  # value behind as the "previous" one. A changed concurrency setting takes
  # effect at the next deploy.
  tags = {
    "retainer:reserved-concurrency" = tostring(each.value.concurrency)
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, reserved_concurrent_executions]
  }

  depends_on = [aws_iam_role_policy_attachment.functions_vpc]
}
