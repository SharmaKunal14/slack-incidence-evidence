locals {
  slack_oauth_redirect_uri = "${aws_apigatewayv2_api.public.api_endpoint}/onboarding/slack/callback"
  slack_onboarding_routes = toset([
    "GET /onboarding/slack/callback",
    "POST /onboarding/slack/start",
  ])
  slack_installation_secret_arn_pattern = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.slack_installation_secret_prefix}/*"
}

data "aws_partition" "current" {}

resource "aws_cloudwatch_log_group" "slack_onboarding_start" {
  name              = "/aws/lambda/${local.name_prefix}-slack-onboarding-start"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "slack_onboarding_callback" {
  name              = "/aws/lambda/${local.name_prefix}-slack-onboarding-callback"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "slack_onboarding_start" {
  name                 = "${local.name_prefix}-slack-onboarding-start-role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.lambda_role_permissions_boundary_arn
}

data "aws_iam_policy_document" "slack_onboarding_start" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.slack_onboarding_start.arn}:*"]
  }

  statement {
    sid       = "ReadOnboardingDatabaseCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.onboarding_database_secret]
  }

  dynamic "statement" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      sid = "ManageOnboardingStartVpcNetworkInterfaces"
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

  dynamic "statement" {
    for_each = length(var.secrets_kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptCustomerManagedDatabaseSecretKey"
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

resource "aws_iam_role_policy" "slack_onboarding_start" {
  name   = "slack-onboarding-start"
  role   = aws_iam_role.slack_onboarding_start.id
  policy = data.aws_iam_policy_document.slack_onboarding_start.json
}

resource "aws_iam_role" "slack_onboarding_callback" {
  name                 = "${local.name_prefix}-slack-onboarding-callback-role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.lambda_role_permissions_boundary_arn
}

data "aws_iam_policy_document" "slack_onboarding_callback" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.slack_onboarding_callback.arn}:*"]
  }

  statement {
    sid       = "ReadOnboardingRuntimeSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.onboarding_database_secret, var.slack_oauth_app_secret_arn]
  }

  statement {
    sid = "StoreAttemptScopedSlackCredential"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
    ]
    resources = [local.slack_installation_secret_arn_pattern]
  }

  statement {
    sid = "EncryptSlackInstallationCredential"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [var.slack_installation_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }

  dynamic "statement" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      sid = "ManageOnboardingCallbackVpcNetworkInterfaces"
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

  dynamic "statement" {
    for_each = length(var.secrets_kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptCustomerManagedRuntimeSecretKeys"
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

resource "aws_iam_role_policy" "slack_onboarding_callback" {
  name   = "slack-onboarding-callback"
  role   = aws_iam_role.slack_onboarding_callback.id
  policy = data.aws_iam_policy_document.slack_onboarding_callback.json
}

resource "aws_lambda_function" "slack_onboarding_start" {
  function_name = "${local.name_prefix}-slack-onboarding-start"
  description   = "Creates an authenticated, browser-bound Slack OAuth authorization."
  role          = aws_iam_role.slack_onboarding_start.arn
  runtime       = "nodejs22.x"
  architectures = [var.lambda_architecture]
  handler       = var.slack_onboarding_start_lambda_handler

  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)

  memory_size                    = var.slack_onboarding_memory_mb
  timeout                        = var.slack_onboarding_timeout_seconds
  reserved_concurrent_executions = var.slack_onboarding_reserved_concurrency

  environment {
    variables = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      DATABASE_HOST                       = var.database_host
      DATABASE_NAME                       = var.database_name
      DATABASE_POOL_MAX                   = tostring(var.database_pool_max)
      DATABASE_PORT                       = tostring(var.database_port)
      DATABASE_SECRET_ARN                 = local.onboarding_database_secret
      DATABASE_SSL                        = "true"
      LOG_LEVEL                           = var.log_level
      NODE_ENV                            = local.node_env
      SLACK_OAUTH_CLIENT_ID               = var.slack_oauth_client_id
      SLACK_OAUTH_REDIRECT_URI            = local.slack_oauth_redirect_uri
    }
  }

  tracing_config { mode = "PassThrough" }

  dynamic "vpc_config" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      subnet_ids         = var.worker_subnet_ids
      security_group_ids = var.worker_security_group_ids
    }
  }

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.onboarding_database_secret_arn != null
      error_message = "Production requires onboarding_database_secret_arn for a dedicated least-privilege PostgreSQL onboarding role."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.slack_onboarding_start,
    aws_iam_role_policy.slack_onboarding_start,
  ]
}

resource "aws_lambda_function" "slack_onboarding_callback" {
  function_name = "${local.name_prefix}-slack-onboarding-callback"
  description   = "Exchanges a browser-bound Slack OAuth callback and stores the installation credential."
  role          = aws_iam_role.slack_onboarding_callback.arn
  runtime       = "nodejs22.x"
  architectures = [var.lambda_architecture]
  handler       = var.slack_onboarding_callback_lambda_handler

  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)

  memory_size                    = var.slack_onboarding_memory_mb
  timeout                        = var.slack_onboarding_timeout_seconds
  reserved_concurrent_executions = var.slack_onboarding_reserved_concurrency

  environment {
    variables = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      DATABASE_HOST                       = var.database_host
      DATABASE_NAME                       = var.database_name
      DATABASE_POOL_MAX                   = tostring(var.database_pool_max)
      DATABASE_PORT                       = tostring(var.database_port)
      DATABASE_SECRET_ARN                 = local.onboarding_database_secret
      DATABASE_SSL                        = "true"
      LOG_LEVEL                           = var.log_level
      NODE_ENV                            = local.node_env
      ONBOARDING_FAILURE_REDIRECT_URL     = "${local.review_application_url}/?slack=failed"
      ONBOARDING_SUCCESS_REDIRECT_URL     = "${local.review_application_url}/?slack=connected"
      SLACK_INSTALLATION_KMS_KEY_ARN      = var.slack_installation_kms_key_arn
      SLACK_INSTALLATION_SECRET_PREFIX    = local.slack_installation_secret_prefix
      SLACK_OAUTH_APP_ID                  = var.slack_oauth_app_id
      SLACK_OAUTH_APP_SECRET_ARN          = var.slack_oauth_app_secret_arn
      SLACK_OAUTH_CLIENT_ID               = var.slack_oauth_client_id
      SLACK_OAUTH_REDIRECT_URI            = local.slack_oauth_redirect_uri
      SLACK_OAUTH_TIMEOUT_MS              = "5000"
    }
  }

  tracing_config { mode = "PassThrough" }

  dynamic "vpc_config" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      subnet_ids         = var.worker_subnet_ids
      security_group_ids = var.worker_security_group_ids
    }
  }

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.onboarding_database_secret_arn != null
      error_message = "Production requires onboarding_database_secret_arn for a dedicated least-privilege PostgreSQL onboarding role."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.slack_onboarding_callback,
    aws_iam_role_policy.slack_onboarding_callback,
  ]
}

resource "aws_apigatewayv2_integration" "slack_onboarding_start" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.slack_onboarding_start.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.slack_onboarding_timeout_seconds * 1000
}

resource "aws_apigatewayv2_integration" "slack_onboarding_callback" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.slack_onboarding_callback.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.slack_onboarding_timeout_seconds * 1000
}

resource "aws_apigatewayv2_route" "slack_onboarding_start" {
  api_id             = aws_apigatewayv2_api.public.id
  route_key          = "POST /onboarding/slack/start"
  target             = "integrations/${aws_apigatewayv2_integration.slack_onboarding_start.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.reviewers.id
}

resource "aws_apigatewayv2_route" "slack_onboarding_callback" {
  api_id             = aws_apigatewayv2_api.public.id
  route_key          = "GET /onboarding/slack/callback"
  target             = "integrations/${aws_apigatewayv2_integration.slack_onboarding_callback.id}"
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "api_gateway_slack_onboarding_start" {
  statement_id  = "AllowApiGatewaySlackOnboardingStart"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_onboarding_start.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/POST/onboarding/slack/start"
}

resource "aws_lambda_permission" "api_gateway_slack_onboarding_callback" {
  statement_id  = "AllowApiGatewaySlackOnboardingCallback"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_onboarding_callback.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/GET/onboarding/slack/callback"
}

resource "aws_cloudwatch_metric_alarm" "slack_onboarding_start_errors" {
  alarm_name          = "${local.name_prefix}-slack-onboarding-start-errors"
  alarm_description   = "The authenticated Slack onboarding start Lambda returned an unhandled error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  dimensions          = { FunctionName = aws_lambda_function.slack_onboarding_start.function_name }
}

resource "aws_cloudwatch_metric_alarm" "slack_onboarding_callback_errors" {
  alarm_name          = "${local.name_prefix}-slack-onboarding-callback-errors"
  alarm_description   = "The public Slack onboarding callback Lambda returned an unhandled error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  dimensions          = { FunctionName = aws_lambda_function.slack_onboarding_callback.function_name }
}
