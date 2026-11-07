# Key mode, accounts mode and the GitHub deploy role against mocked
# providers: no AWS account needed.
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

run "key_mode_keeps_every_function_without_internet" {
  command = apply

  assert {
    condition     = length(aws_nat_gateway.this) == 0 && length(aws_internet_gateway.this) == 0
    error_message = "Key mode must not create a NAT gateway or an internet gateway."
  }

  assert {
    condition     = toset(keys(aws_lambda_function.this)) == toset(["api", "consolidate", "ops"])
    error_message = "Key mode runs api, consolidate and ops only."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.this["api"].environment[0].variables), "RETAINER_AUTH_SECRET")
    error_message = "Key mode gives the api function no auth secret."
  }

  assert {
    condition     = length(aws_apigatewayv2_route.control) == 0
    error_message = "Key mode has no /account route."
  }

  assert {
    condition = alltrue([
      for key, variable in {
        api_suppression_key  = aws_lambda_function.this["api"].environment[0].variables["RETAINER_SUPPRESSION_KEY"]
        api_database_url     = aws_lambda_function.this["api"].environment[0].variables["RETAINER_RUNTIME_DATABASE_URL"]
        consolidate_database = aws_lambda_function.this["consolidate"].environment[0].variables["RETAINER_RUNTIME_DATABASE_URL"]
        ops_owner_database   = aws_lambda_function.this["ops"].environment[0].variables["DATABASE_URL"]
        ops_runtime_database = aws_lambda_function.this["ops"].environment[0].variables["RETAINER_RUNTIME_DATABASE_URL"]
      } : issensitive(variable)
    ])
    error_message = "Generated secrets in the functions' environment are sensitive, so no plan prints them."
  }
}

run "accounts_mode_gives_only_control_a_route_out" {
  command = apply

  variables {
    google_client_id     = "test-client.apps.googleusercontent.com"
    google_client_secret = "test-secret"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 1
    error_message = "Accounts mode needs one NAT gateway."
  }

  assert {
    condition     = sort(tolist(aws_lambda_function.this["control"].vpc_config[0].subnet_ids)) == sort(aws_subnet.control[*].id)
    error_message = "The control function runs in the subnets that route to the NAT gateway."
  }

  assert {
    condition = alltrue([
      for key in ["api", "consolidate", "ops"] :
      sort(tolist(aws_lambda_function.this[key].vpc_config[0].subnet_ids)) == sort(aws_subnet.private[*].id)
    ])
    error_message = "The api, consolidate and ops functions stay in the subnets with no route out."
  }

  assert {
    condition = alltrue([
      for association in aws_route_table_association.control :
      association.route_table_id == aws_route_table.control[0].id
    ]) && length(aws_route_table_association.control) == length(aws_subnet.control)
    error_message = "Every control subnet routes through the NAT gateway."
  }

  assert {
    condition = (
      aws_lambda_function.this["api"].environment[0].variables["RETAINER_AUTH_SECRET"] ==
      aws_lambda_function.this["control"].environment[0].variables["RETAINER_AUTH_SECRET"]
    )
    error_message = "The api function checks cookies with the secret the control function signs them with."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.this["control"].environment[0].variables), "DATABASE_URL")
    error_message = "The control function never holds the owner's login."
  }

  assert {
    condition = (
      aws_lambda_function.this["ops"].environment[0].variables["RETAINER_CONTROL_DATABASE_URL"] ==
      aws_lambda_function.this["control"].environment[0].variables["RETAINER_CONTROL_DATABASE_URL"]
    )
    error_message = "The ops function sets the password the control function logs in with."
  }

  assert {
    condition     = toset(keys(aws_apigatewayv2_route.control)) == toset(["ANY /account", "ANY /account/{proxy+}"])
    error_message = "/account and everything under it go to the control function."
  }

  assert {
    condition = alltrue([
      issensitive(aws_lambda_function.this["api"].environment[0].variables["RETAINER_AUTH_SECRET"]),
      issensitive(aws_lambda_function.this["control"].environment[0].variables["RETAINER_AUTH_SECRET"]),
      issensitive(aws_lambda_function.this["control"].environment[0].variables["RETAINER_GOOGLE_CLIENT_SECRET"]),
      issensitive(aws_lambda_function.this["control"].environment[0].variables["RETAINER_CONTROL_DATABASE_URL"]),
      issensitive(aws_lambda_function.this["ops"].environment[0].variables["RETAINER_CONTROL_DATABASE_URL"]),
    ])
    error_message = "Accounts mode's secrets are sensitive, so no plan prints them."
  }
}

run "github_role_cannot_change_its_own_permissions" {
  command = apply

  variables {
    github_repository = "example/retainer"
  }

  override_resource {
    target = aws_iam_role.github_deploy
    values = { arn = "arn:aws:iam::123456789012:role/retainer-github-deploy" }
  }

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement : [
        for action in flatten([statement.Action]) :
        !startswith(action, "iam:") || contains([
          "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
          "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
          "iam:PassRole", "iam:ListOpenIDConnectProviders", "iam:GetOpenIDConnectProvider",
        ], action)
      ]
    ])) && !contains(flatten([for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement : statement.Action]), "*")
    error_message = "The deploy role grants no wildcard action and only the IAM actions this stack needs."
  }

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement : [
        for action in flatten([statement.Action]) :
        startswith(action, "iam:Get") || startswith(action, "iam:List")
      ] if contains(flatten([statement.Resource]), aws_iam_role.github_deploy[0].arn)
    ]))
    error_message = "The deploy role can read itself but not change itself."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement :
      length(setintersection(
        keys(merge(values(statement.Condition)...)),
        ["aws:ResourceTag/Application", "aws:RequestTag/Application", "ec2:CreateAction", "ec2:Vpc"],
        )) > 0 && alltrue([
        for key, value in merge(values(statement.Condition)...) :
        value == var.name if endswith(key, "/Application")
      ])
      if anytrue([
        for action in flatten([statement.Action]) :
        startswith(action, "ec2:") && !startswith(action, "ec2:Describe")
      ])
    ])
    error_message = "The deploy role creates network resources only with the deployment's Application tag and changes only those that carry it."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement :
      statement.Resource == aws_iam_role.functions.arn
      if contains(flatten([statement.Action]), "iam:PassRole")
    ])
    error_message = "The deploy role passes only the functions' role."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.github_deploy[0].policy).Statement :
      statement.Condition["ArnEquals"]["iam:PolicyARN"] == aws_iam_role_policy_attachment.functions_vpc.policy_arn
      if contains(flatten([statement.Action]), "iam:AttachRolePolicy")
    ])
    error_message = "The deploy role attaches only the functions' VPC policy."
  }
}

run "tags_cannot_replace_the_application_tag" {
  command = plan

  variables {
    tags = { Application = "custom" }
  }

  expect_failures = [var.tags]
}
