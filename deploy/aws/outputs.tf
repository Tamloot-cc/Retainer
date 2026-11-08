output "public_origin" {
  description = "Where Retainer is served: REST at /v1, MCP at /mcp, the web app at /app/."
  value       = local.public_origin
}

output "api_gateway_url" {
  description = "API Gateway's own URL (disabled once the custom domain is attached)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "function_names" {
  description = "Function names, for deploy.sh and ops.sh."
  value       = { for key, f in aws_lambda_function.this : key => f.function_name }
}

output "dns_records" {
  description = "Records to create at your DNS provider for domain_name (DNS-only, not proxied)."
  value = var.domain_name == null ? [] : concat(
    [for o in aws_acm_certificate.domain[0].domain_validation_options : {
      purpose = "certificate validation"
      name    = o.resource_record_name
      type    = o.resource_record_type
      value   = o.resource_record_value
    }],
    [for d in aws_apigatewayv2_domain_name.this : {
      purpose = "custom domain"
      name    = d.domain_name
      type    = "CNAME"
      value   = d.domain_name_configuration[0].target_domain_name
    }],
  )
}

output "database_endpoint" {
  description = "RDS endpoint (private: reachable from the functions only)."
  value       = aws_db_instance.this.address
}

output "alarm_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = aws_sns_topic.alarms.arn
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_ROLE_ARN variable of the GitHub Environment."
  value       = one(aws_iam_role.github_deploy[*].arn)
}

output "google_redirect_uri" {
  description = "Accounts mode: the authorized redirect URI to add to the Google OAuth client."
  value       = var.google_client_id != null ? "${local.public_origin}/account/auth/callback/google" : null
}

output "microsoft_redirect_uri" {
  description = "Accounts mode: the Web redirect URI to add to the Microsoft Entra app."
  value       = var.microsoft_client_id != null ? "${local.public_origin}/account/auth/callback/microsoft" : null
}
