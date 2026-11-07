# The consolidator: EventBridge runs one pass every consolidate_schedule.
# Each workspace is consolidated at most once per consolidate_interval_minutes.

resource "aws_cloudwatch_event_rule" "consolidate" {
  name                = "${var.name}-consolidate"
  description         = "Runs the Retainer consolidator over due workspaces"
  schedule_expression = var.consolidate_schedule
}

resource "aws_cloudwatch_event_target" "consolidate" {
  rule = aws_cloudwatch_event_rule.consolidate.name
  arn  = aws_lambda_function.this["consolidate"].arn

  # A run that finds the function stopped (during a deploy) is not retried:
  # the next scheduled run picks the workspaces up.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "consolidate_schedule" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["consolidate"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.consolidate.arn
}

# Accounts mode: removes workspaces deleted more than 7 days ago, for good
# (accounts spec 4.5). The control function holds the deploy lock while it
# runs, as a consolidator pass does, so a migration waits for it.

resource "aws_cloudwatch_event_rule" "purge" {
  count               = local.accounts ? 1 : 0
  name                = "${var.name}-purge-deleted-workspaces"
  description         = "Removes Retainer workspaces deleted more than 7 days ago"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "purge" {
  count = local.accounts ? 1 : 0
  rule  = aws_cloudwatch_event_rule.purge[0].name
  arn   = aws_lambda_function.this["control"].arn
  input = jsonencode({ task = "purge-deleted-workspaces" })

  # Like the consolidator: a run that finds the function stopped is not
  # retried; the next hour's run removes what is due.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "purge_schedule" {
  count         = local.accounts ? 1 : 0
  statement_id  = "AllowEventBridgePurge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["control"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.purge[0].arn
}
