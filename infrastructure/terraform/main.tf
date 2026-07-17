locals {
  name_prefix        = "${var.project_name}-${var.environment}"
  node_env           = var.environment == "production" ? "production" : "development"
  worker_vpc_enabled = length(var.worker_subnet_ids) > 0 && length(var.worker_security_group_ids) > 0
}

# -----------------------------------------------------------------------------
# Durable ingress buffer
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "incident_jobs_dlq" {
  name                      = "${local.name_prefix}-incident-jobs-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = var.dlq_message_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "incident_jobs" {
  name                        = "${local.name_prefix}-incident-jobs.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  message_retention_seconds   = var.queue_message_retention_seconds
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = var.queue_visibility_timeout_seconds
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.incident_jobs_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })

  lifecycle {
    precondition {
      condition     = var.queue_visibility_timeout_seconds >= var.worker_timeout_seconds * 6
      error_message = "queue_visibility_timeout_seconds must be at least six times worker_timeout_seconds to leave room for throttling and retries."
    }

    precondition {
      condition     = var.dlq_message_retention_seconds >= var.queue_message_retention_seconds
      error_message = "dlq_message_retention_seconds must be at least as long as queue_message_retention_seconds so failed jobs do not expire earlier after redrive."
    }
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "incident_jobs" {
  queue_url = aws_sqs_queue.incident_jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.incident_jobs.arn]
  })
}

data "aws_iam_policy_document" "incident_jobs_transport" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    actions = [
      "sqs:*",
    ]
    resources = [aws_sqs_queue.incident_jobs.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "incident_jobs_transport" {
  queue_url = aws_sqs_queue.incident_jobs.id
  policy    = data.aws_iam_policy_document.incident_jobs_transport.json
}

data "aws_iam_policy_document" "incident_jobs_dlq_transport" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    actions = [
      "sqs:*",
    ]
    resources = [aws_sqs_queue.incident_jobs_dlq.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "incident_jobs_dlq_transport" {
  queue_url = aws_sqs_queue.incident_jobs_dlq.id
  policy    = data.aws_iam_policy_document.incident_jobs_dlq_transport.json
}

# -----------------------------------------------------------------------------
# Bounded log retention. Application payloads are deliberately excluded from
# Step Functions execution logs; normal application logs must also remain free
# of Slack message bodies and credentials.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ingress" {
  name              = "/aws/lambda/${local.name_prefix}-slack-ingress"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name_prefix}-incident-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/apigateway/${local.name_prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "workflow" {
  name              = "/aws/vendedlogs/states/${local.name_prefix}-incident-workflow"
  retention_in_days = var.log_retention_days
}

# -----------------------------------------------------------------------------
# Step Functions: an intentionally small, truthful orchestration boundary.
# The current worker starts an execution and this state records acceptance. New
# collection, extraction, review, and publication states should be added only
# when the corresponding idempotent application stages exist.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "step_functions_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "step_functions" {
  name               = "${local.name_prefix}-workflow-role"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json
}

data "aws_iam_policy_document" "step_functions_logging" {
  # CloudWatch Logs delivery APIs do not support resource-level permissions.
  # This is the AWS-documented exception to the otherwise resource-scoped IAM
  # policies in this stack.
  statement {
    sid = "DeliverExecutionLogs"
    actions = [
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "step_functions_logging" {
  name   = "execution-logging"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions_logging.json
}

resource "aws_sfn_state_machine" "incident_workflow" {
  name     = "${local.name_prefix}-incident-workflow"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Incident workflow orchestration boundary. Only acceptance is implemented in the current release."
    StartAt = "WorkflowAccepted"
    States = {
      WorkflowAccepted = {
        Type = "Succeed"
      }
    }
  })

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  depends_on = [aws_iam_role_policy.step_functions_logging]
}

# -----------------------------------------------------------------------------
# Least-privilege Lambda roles
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingress" {
  name               = "${local.name_prefix}-slack-ingress-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "ingress" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ingress.arn}:*"]
  }

  statement {
    sid       = "EnqueueIncidentReview"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.incident_jobs.arn]
  }

  statement {
    sid       = "ReadSlackSigningSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.slack_signing_secret_arn]
  }

  dynamic "statement" {
    for_each = length(var.secrets_kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptCustomerManagedSecretKeys"
      actions   = ["kms:Decrypt"]
      resources = var.secrets_kms_key_arns
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "ingress" {
  name   = "slack-ingress"
  role   = aws_iam_role.ingress.id
  policy = data.aws_iam_policy_document.ingress.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name_prefix}-incident-worker-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  dynamic "statement" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      # Lambda's ENI management APIs do not support a useful resource ARN for
      # all required operations. The grant exists only when VPC inputs exist.
      sid = "ManageWorkerVpcNetworkInterfaces"
      actions = [
        "ec2:AssignPrivateIpAddresses",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:UnassignPrivateIpAddresses",
      ]
      resources = ["*"]
    }
  }

  statement {
    sid = "ConsumeIncidentJobs"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.incident_jobs.arn]
  }

  statement {
    sid       = "ReadDatabaseCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }

  statement {
    sid       = "StartIncidentWorkflow"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.incident_workflow.arn]
  }

  dynamic "statement" {
    for_each = length(var.secrets_kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptCustomerManagedSecretKeys"
      actions   = ["kms:Decrypt"]
      resources = var.secrets_kms_key_arns
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "incident-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

# -----------------------------------------------------------------------------
# Lambda compute. Both functions use one immutable build artifact but distinct
# composition roots, IAM roles, configuration, and concurrency budgets.
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "ingress" {
  function_name = "${local.name_prefix}-slack-ingress"
  description   = "Authenticates Slack events, enqueues a versioned incident job, and acknowledges immediately."
  role          = aws_iam_role.ingress.arn
  runtime       = "nodejs22.x"
  architectures = [var.lambda_architecture]
  handler       = var.ingress_lambda_handler

  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)

  memory_size                    = var.ingress_memory_mb
  timeout                        = var.ingress_timeout_seconds
  reserved_concurrent_executions = var.ingress_reserved_concurrency

  environment {
    variables = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      INCIDENT_QUEUE_URL                  = aws_sqs_queue.incident_jobs.id
      LOG_LEVEL                           = var.log_level
      NODE_ENV                            = local.node_env
      SLACK_SIGNING_SECRET_ARN            = var.slack_signing_secret_arn
    }
  }

  tracing_config {
    mode = "PassThrough"
  }

  depends_on = [
    aws_cloudwatch_log_group.ingress,
    aws_iam_role_policy.ingress,
  ]
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.name_prefix}-incident-worker"
  description   = "Consumes one incident job idempotently and starts its durable Step Functions execution."
  role          = aws_iam_role.worker.arn
  runtime       = "nodejs22.x"
  architectures = [var.lambda_architecture]
  handler       = var.worker_lambda_handler

  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)

  memory_size                    = var.worker_memory_mb
  timeout                        = var.worker_timeout_seconds
  reserved_concurrent_executions = var.worker_reserved_concurrency

  environment {
    variables = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      DATABASE_HOST                       = var.database_host
      DATABASE_NAME                       = var.database_name
      DATABASE_POOL_MAX                   = tostring(var.database_pool_max)
      DATABASE_PORT                       = tostring(var.database_port)
      DATABASE_SECRET_ARN                 = var.database_secret_arn
      DATABASE_SSL                        = "true"
      INCIDENT_WORKFLOW_STATE_MACHINE_ARN = aws_sfn_state_machine.incident_workflow.arn
      LOG_LEVEL                           = var.log_level
      NODE_ENV                            = local.node_env
      NODE_EXTRA_CA_CERTS                 = "/var/runtime/ca-cert.pem"
    }
  }

  tracing_config {
    mode = "PassThrough"
  }

  dynamic "vpc_config" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      subnet_ids         = var.worker_subnet_ids
      security_group_ids = var.worker_security_group_ids
    }
  }

  lifecycle {
    precondition {
      condition = (
        length(var.worker_subnet_ids) == 0 && length(var.worker_security_group_ids) == 0
        ) || (
        length(var.worker_subnet_ids) > 0 && length(var.worker_security_group_ids) > 0
      )
      error_message = "worker_subnet_ids and worker_security_group_ids must either both be empty or both be populated."
    }

    precondition {
      condition     = var.environment != "production" || local.worker_vpc_enabled
      error_message = "Production requires worker_subnet_ids and worker_security_group_ids so PostgreSQL remains private behind RDS Proxy."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.worker,
    aws_iam_role_policy.worker,
  ]
}

resource "aws_lambda_event_source_mapping" "incident_jobs" {
  event_source_arn = aws_sqs_queue.incident_jobs.arn
  function_name    = aws_lambda_function.worker.arn
  enabled          = true
  batch_size       = 1

  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.worker_reserved_concurrency
  }
}

# -----------------------------------------------------------------------------
# Public Slack webhook. Slack HMAC verification remains the authentication
# boundary; API Gateway throttling is only an abuse/cost guard.
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "public" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "Public integration API for Incident Evidence Copilot"
}

resource "aws_apigatewayv2_integration" "slack_ingress" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.ingress.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.api_integration_timeout_milliseconds
}

resource "aws_apigatewayv2_route" "slack_events" {
  api_id    = aws_apigatewayv2_api.public.id
  route_key = "POST /integrations/slack/events"
  target    = "integrations/${aws_apigatewayv2_integration.slack_ingress.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.public.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      sourceIp         = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  default_route_settings {
    throttling_burst_limit = var.api_throttle_burst_limit
    throttling_rate_limit  = var.api_throttle_rate_limit
  }
}

resource "aws_lambda_permission" "api_gateway_ingress" {
  statement_id  = "AllowApiGatewaySlackIngress"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingress.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/POST/integrations/slack/events"
}

# -----------------------------------------------------------------------------
# Minimum operational alarms. Supplying SNS action ARNs turns them into paging
# signals; without actions they still provide visible health state.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "incident_jobs_dlq" {
  alarm_name          = "${local.name_prefix}-incident-jobs-in-dlq"
  alarm_description   = "One or more incident jobs exhausted retries and require investigation or redrive."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    QueueName = aws_sqs_queue.incident_jobs_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "oldest_incident_job" {
  alarm_name          = "${local.name_prefix}-oldest-incident-job"
  alarm_description   = "Incident processing is falling behind or workers are unavailable."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.oldest_job_alarm_threshold_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    QueueName = aws_sqs_queue.incident_jobs.name
  }
}
