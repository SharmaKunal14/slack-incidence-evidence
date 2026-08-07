data "aws_caller_identity" "current" {}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  review_bucket_name             = "${substr(local.name_prefix, 0, 24)}-review-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  review_cognito_domain          = "${substr(local.name_prefix, 0, 40)}-${data.aws_caller_identity.current.account_id}"
  review_application_url         = "https://${aws_cloudfront_distribution.review.domain_name}"
  review_database_secret         = coalesce(var.review_database_secret_arn, var.database_secret_arn)
  invitation_email_sender_domain = split("@", var.invitation_email_from_address)[1]
  review_runtime_configuration = "window.__INCIDENT_REVIEW_CONFIG__ = ${jsonencode({
    apiBaseUrl      = local.review_application_url
    cognitoBaseUrl  = "https://${aws_cognito_user_pool_domain.reviewers.domain}.auth.${var.aws_region}.amazoncognito.com"
    cognitoClientId = aws_cognito_user_pool_client.review_console.id
    redirectUri     = "${local.review_application_url}/"
  })};"
}

# -----------------------------------------------------------------------------
# Human identity. Cognito proves who the caller is; reviewer_memberships in
# PostgreSQL remains the tenant authorization source of truth.
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool" "reviewers" {
  name                = "${local.name_prefix}-reviewers"
  deletion_protection = var.environment == "production" ? "ACTIVE" : "INACTIVE"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  admin_create_user_config {
    allow_admin_create_user_only = !var.review_self_signup_enabled
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 3
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }
}

resource "aws_cognito_user_pool_domain" "reviewers" {
  domain       = local.review_cognito_domain
  user_pool_id = aws_cognito_user_pool.reviewers.id
}

resource "aws_cognito_user_pool_client" "review_console" {
  name         = "${local.name_prefix}-review-console"
  user_pool_id = aws_cognito_user_pool.reviewers.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.review_application_url}/"]
  logout_urls                          = ["${local.review_application_url}/"]
  prevent_user_existence_errors        = "ENABLED"

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]
}

# -----------------------------------------------------------------------------
# Private static console. CloudFront is the only principal that may read S3.
# The browser uses authorization-code + PKCE and stores the short-lived access
# token in sessionStorage; no credentials or incident data are built into S3.
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "review" {
  bucket        = local.review_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "review" {
  bucket = aws_s3_bucket.review.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "review" {
  bucket = aws_s3_bucket.review.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "review" {
  bucket = aws_s3_bucket.review.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "review" {
  bucket = aws_s3_bucket.review.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "review" {
  name                              = "${local.name_prefix}-review-oac"
  description                       = "Signs private S3 requests for the review console"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "review_security" {
  name = "${local.name_prefix}-review-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; base-uri 'none'; connect-src 'self' https://*.auth.${var.aws_region}.amazoncognito.com; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'"
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
      preload                    = true
    }
  }
}

resource "aws_cloudfront_distribution" "review" {
  enabled             = true
  comment             = "${local.name_prefix} authenticated incident review console"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_200"

  origin {
    domain_name              = aws_s3_bucket.review.bucket_regional_domain_name
    origin_id                = "review-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.review.id
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.public.api_endpoint, "https://", "")
    origin_id   = "application-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.review_security.id
    target_origin_id           = "review-s3"
    viewer_protocol_policy     = "redirect-to-https"
  }

  ordered_cache_behavior {
    path_pattern               = "runtime-config.js"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.review_security.id
    target_origin_id           = "review-s3"
    viewer_protocol_policy     = "redirect-to-https"
  }

  ordered_cache_behavior {
    path_pattern               = "review/*"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    compress                   = true
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.review_security.id
    target_origin_id           = "application-api"
    viewer_protocol_policy     = "redirect-to-https"
  }

  ordered_cache_behavior {
    path_pattern               = "onboarding/*"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    compress                   = true
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.review_security.id
    target_origin_id           = "application-api"
    viewer_protocol_policy     = "redirect-to-https"
  }

  # The console uses hash routes, so unknown S3 paths do not need an index.html
  # fallback. Distribution-wide custom error responses would also mask API
  # authorization and routing failures as successful HTML responses.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "review_bucket" {
  statement {
    sid     = "AllowCloudFrontReadOnly"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.review.arn}/*",
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.review.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.review.arn,
      "${aws_s3_bucket.review.arn}/*",
    ]
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

resource "aws_s3_bucket_policy" "review" {
  bucket = aws_s3_bucket.review.id
  policy = data.aws_iam_policy_document.review_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.review]
}

resource "aws_s3_object" "review_index" {
  bucket        = aws_s3_bucket.review.id
  key           = "index.html"
  source        = "${var.review_web_artifact_directory}/index.html"
  source_hash   = filesha256("${var.review_web_artifact_directory}/index.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-cache"

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.review]
}

resource "aws_s3_object" "review_styles" {
  bucket        = aws_s3_bucket.review.id
  key           = "styles.css"
  source        = "${var.review_web_artifact_directory}/styles.css"
  source_hash   = filesha256("${var.review_web_artifact_directory}/styles.css")
  content_type  = "text/css; charset=utf-8"
  cache_control = "public, max-age=300, must-revalidate"

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.review]
}

resource "aws_s3_object" "review_application" {
  bucket        = aws_s3_bucket.review.id
  key           = "app.js"
  source        = "${var.review_web_artifact_directory}/app.js"
  source_hash   = filesha256("${var.review_web_artifact_directory}/app.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "public, max-age=300, must-revalidate"

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.review]
}

resource "aws_s3_object" "review_runtime_configuration" {
  bucket        = aws_s3_bucket.review.id
  key           = "runtime-config.js"
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-store, max-age=0"
  content       = local.review_runtime_configuration
  source_hash   = sha256(local.review_runtime_configuration)

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.review]
}

# -----------------------------------------------------------------------------
# Tenant-authorized review API. The JWT authorizer checks signature, issuer,
# expiry, and audience before Lambda. Lambda then validates token_use and the
# PostgreSQL membership on every operation.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "incident_review_api" {
  name              = "/aws/lambda/${local.name_prefix}-incident-review-api"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "incident_review_api" {
  name                 = "${local.name_prefix}-incident-review-api-role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.lambda_role_permissions_boundary_arn
}

data "aws_iam_policy_document" "incident_review_api" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.incident_review_api.arn}:*"]
  }

  statement {
    sid       = "ReadDatabaseCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.review_database_secret]
  }

  statement {
    sid     = "SendWorkspaceInvitationEmail"
    actions = ["ses:SendEmail"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${var.invitation_email_from_address}",
      "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${local.invitation_email_sender_domain}",
    ]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.invitation_email_from_address]
    }
  }

  dynamic "statement" {
    for_each = local.worker_vpc_enabled ? [1] : []
    content {
      # Lambda ENI management APIs do not support resource-level permissions.
      # This grant is absent unless the operator explicitly enables VPC mode.
      sid = "ManageReviewApiVpcNetworkInterfaces"
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

resource "aws_iam_role_policy" "incident_review_api" {
  name   = "incident-review-api"
  role   = aws_iam_role.incident_review_api.id
  policy = data.aws_iam_policy_document.incident_review_api.json
}

resource "aws_lambda_function" "incident_review_api" {
  function_name = "${local.name_prefix}-incident-review-api"
  description   = "Serves tenant-authorized review operations and safe Slack connection status."
  role          = aws_iam_role.incident_review_api.arn
  runtime       = "nodejs22.x"
  architectures = [var.lambda_architecture]
  handler       = var.incident_review_api_lambda_handler

  filename         = var.lambda_artifact_path
  source_code_hash = filebase64sha256(var.lambda_artifact_path)

  memory_size                    = var.review_api_memory_mb
  timeout                        = var.review_api_timeout_seconds
  reserved_concurrent_executions = var.review_api_reserved_concurrency

  environment {
    variables = {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      DATABASE_HOST                       = var.database_host
      DATABASE_NAME                       = var.database_name
      DATABASE_POOL_MAX                   = tostring(var.database_pool_max)
      DATABASE_PORT                       = tostring(var.database_port)
      DATABASE_SECRET_ARN                 = local.review_database_secret
      DATABASE_SSL                        = "true"
      LOG_LEVEL                           = var.log_level
      INVITATION_EMAIL_FROM_ADDRESS       = var.invitation_email_from_address
      NODE_ENV                            = local.node_env
      REVIEW_API_MAX_BODY_BYTES           = tostring(var.review_api_max_body_bytes)
      REVIEW_APP_BASE_URL                 = local.review_application_url
      SLACK_IDENTITY_REDIRECT_URI         = "${local.review_application_url}/onboarding/slack/identity/callback"
      SLACK_OAUTH_CLIENT_ID               = var.slack_oauth_client_id
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
      condition     = var.environment != "production" || var.review_database_secret_arn != null
      error_message = "Production requires review_database_secret_arn for a dedicated least-privilege PostgreSQL reviewer role."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.incident_review_api,
    aws_iam_role_policy.incident_review_api,
  ]
}

resource "aws_apigatewayv2_integration" "incident_review" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.incident_review_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.review_api_timeout_seconds * 1000
}

resource "aws_apigatewayv2_authorizer" "reviewers" {
  api_id           = aws_apigatewayv2_api.public.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-reviewers"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.review_console.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.reviewers.id}"
  }
}

locals {
  review_api_routes = toset([
    "GET /review/onboarding/slack/status",
    "GET /review/incidents",
    "GET /review/incidents/{incidentId}",
    "GET /review/incidents/{incidentId}/revisions/{revisionId}",
    "POST /review/incidents/{incidentId}/revisions",
    "POST /review/incidents/{incidentId}/revisions/{revisionId}/approve",
    "GET /review/workspaces/{workspaceId}/members",
    "POST /review/workspaces/{workspaceId}/invitations",
    "PATCH /review/workspaces/{workspaceId}/members/{memberSubject}",
    "POST /review/invitations/slack/start",
  ])
}

resource "aws_apigatewayv2_route" "incident_review" {
  for_each = local.review_api_routes

  api_id             = aws_apigatewayv2_api.public.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.incident_review.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.reviewers.id
}

resource "aws_lambda_permission" "api_gateway_incident_review" {
  statement_id  = "AllowApiGatewayIncidentReview"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.incident_review_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*/review/*"
}

resource "aws_cloudwatch_metric_alarm" "incident_review_api_errors" {
  alarm_name          = "${local.name_prefix}-incident-review-api-errors"
  alarm_description   = "The authenticated incident review API returned one or more unhandled Lambda errors."
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

  dimensions = {
    FunctionName = aws_lambda_function.incident_review_api.function_name
  }
}
