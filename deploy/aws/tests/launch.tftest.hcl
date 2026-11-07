# Agents and launch (accounts spec, PR 3) against mocked providers: no AWS
# account needed.
# Run with `terraform test` from deploy/aws.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["zone-a", "zone-b", "zone-c"] }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-central-1:123456789012:test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-central-1:123456789012:log-group:test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-central-1:123456789012:function:test"
      invoke_arn = "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:123456789012:function:test/invocations"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://test.execute-api.eu-central-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:test"
    }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-central-1:123456789012:rule/test" }
  }
  mock_resource "aws_db_instance" {
    defaults = { address = "db.test", port = 5432 }
  }
}

mock_provider "random" {}

variables {
  region = "eu-central-1"
}

run "key_mode_has_no_purge_schedule" {
  command = apply

  assert {
    condition     = length(aws_cloudwatch_event_rule.purge) == 0
    error_message = "Key mode has no control function and nothing to purge."
  }

  assert {
    condition     = length(aws_apigatewayv2_route.oauth_metadata) == 0
    error_message = "Key mode has no OAuth authorization server."
  }
}

run "accounts_mode_purges_deleted_workspaces_hourly" {
  command = apply

  variables {
    google_client_id     = "test-client.apps.googleusercontent.com"
    google_client_secret = "test-secret"
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_target.purge[0].input).task == "purge-deleted-workspaces"
    error_message = "The schedule invokes the control function with the purge task."
  }

  assert {
    condition     = aws_lambda_function.this["control"].timeout >= 300
    error_message = "The control function's timeout allows a long purge, as consolidate's does."
  }

  assert {
    condition = alltrue([
      for route in aws_apigatewayv2_route.oauth_metadata :
      route.target == "integrations/${aws_apigatewayv2_integration.control[0].id}"
    ]) && length(aws_apigatewayv2_route.oauth_metadata) == 2
    error_message = "The authorization server's metadata goes to the control function."
  }
}
