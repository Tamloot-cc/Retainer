# API Gateway HTTP API in front of the api function. Every path goes to it,
# /v1 (REST), /mcp, /health and /app (the web app), except /account, which
# goes to the control function in accounts mode.

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  # Once the custom domain is attached it is the only way in, so the public
  # origin (CSRF checks, the session cookie) has one value.
  disable_execute_api_endpoint = var.domain_name != null && var.domain_certificate_validated
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this["api"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  # Retainer has no rate limiting of its own.
  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }

  # No headers and no bodies: keys and record data stay out of the logs.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId = "$context.requestId"
      time      = "$context.requestTime"
      ip        = "$context.identity.sourceIp"
      method    = "$context.httpMethod"
      path      = "$context.path"
      status    = "$context.status"
      latencyMs = "$context.responseLatency"
      error     = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# ─── Custom domain (two steps; see docs/aws.md) ──────────────────────────────

resource "aws_acm_certificate" "domain" {
  count             = var.domain_name != null ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_apigatewayv2_domain_name" "this" {
  count       = var.domain_name != null && var.domain_certificate_validated ? 1 : 0
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate.domain[0].arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  count       = length(aws_apigatewayv2_domain_name.this)
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

# ─── Accounts mode: /account goes to the control function ────────────────────

resource "aws_apigatewayv2_integration" "control" {
  count                  = local.accounts ? 1 : 0
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this["control"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "control" {
  for_each  = local.accounts ? toset(["ANY /account", "ANY /account/{proxy+}"]) : toset([])
  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.control[0].id}"
}

# OAuth clients find the authorization server's metadata at the root, with
# the issuer's path appended (accounts spec 4.6, 4.7). The protected
# resource's metadata is static and stays with the api function.
resource "aws_apigatewayv2_route" "oauth_metadata" {
  for_each = local.accounts ? toset([
    "GET /.well-known/oauth-authorization-server",
    "GET /.well-known/oauth-authorization-server/{proxy+}",
  ]) : toset([])
  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.control[0].id}"
}

resource "aws_lambda_permission" "control" {
  count         = local.accounts ? 1 : 0
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["control"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
