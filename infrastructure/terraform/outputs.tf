output "slack_events_url" {
  description = "Configure this URL as the Slack Events API request URL."
  value       = "${aws_apigatewayv2_api.public.api_endpoint}/integrations/slack/events"
}

output "api_id" {
  description = "API Gateway HTTP API identifier."
  value       = aws_apigatewayv2_api.public.id
}

output "incident_queue_url" {
  description = "URL of the FIFO incident job queue."
  value       = aws_sqs_queue.incident_jobs.id
}

output "incident_queue_arn" {
  description = "ARN of the FIFO incident job queue."
  value       = aws_sqs_queue.incident_jobs.arn
}

output "incident_dlq_url" {
  description = "URL of the FIFO dead-letter queue used for diagnosis and redrive."
  value       = aws_sqs_queue.incident_jobs_dlq.id
}

output "incident_dlq_arn" {
  description = "ARN of the FIFO dead-letter queue."
  value       = aws_sqs_queue.incident_jobs_dlq.arn
}

output "ingress_lambda_name" {
  description = "Slack ingress Lambda function name."
  value       = aws_lambda_function.ingress.function_name
}

output "worker_lambda_name" {
  description = "SQS incident worker Lambda function name."
  value       = aws_lambda_function.worker.function_name
}

output "slack_evidence_collector_lambda_name" {
  description = "Checkpointed Slack evidence collector Lambda function name."
  value       = aws_lambda_function.slack_evidence_collector.function_name
}

output "incident_analysis_lambda_name" {
  description = "Structured incident analysis Lambda function name."
  value       = aws_lambda_function.incident_analysis.function_name
}

output "incident_report_lambda_name" {
  description = "Evidence-constrained incident report Lambda function name."
  value       = aws_lambda_function.incident_report.function_name
}

output "incident_review_notification_lambda_name" {
  description = "Review-ready Slack notification Lambda function name."
  value       = aws_lambda_function.incident_review_notification.function_name
}

output "incident_review_api_lambda_name" {
  description = "Authenticated human-review API Lambda function name."
  value       = aws_lambda_function.incident_review_api.function_name
}

output "approved_report_publication_lambda_name" {
  description = "Scheduled report publication and Slack completion notification Lambda function name."
  value       = aws_lambda_function.approved_report_publication.function_name
}

output "review_console_url" {
  description = "CloudFront URL for the authenticated human-review console."
  value       = local.review_application_url
}

output "review_distribution_id" {
  description = "CloudFront distribution invalidated and verified after a review-console deployment."
  value       = aws_cloudfront_distribution.review.id
}

output "review_api_url" {
  description = "Authenticated review API base URL. Browser calls require a Cognito access token and active database membership."
  value       = "${local.review_application_url}/review"
}

output "slack_onboarding_start_url" {
  description = "Authenticated endpoint the review console uses to begin Slack onboarding."
  value       = "${local.review_application_url}/onboarding/slack/start"
}

output "slack_oauth_redirect_url" {
  description = "Configure this exact URL in the Slack app OAuth redirect URL allowlist."
  value       = local.slack_oauth_redirect_uri
}

output "slack_onboarding_lambda_names" {
  description = "Slack onboarding Lambda names used for post-deployment checks."
  value = {
    start    = aws_lambda_function.slack_onboarding_start.function_name
    callback = aws_lambda_function.slack_onboarding_callback.function_name
  }
}

output "reviewer_user_pool_id" {
  description = "Cognito user pool used to create human reviewer identities."
  value       = aws_cognito_user_pool.reviewers.id
}

output "reviewer_user_pool_client_id" {
  description = "Public PKCE client identifier embedded in the review console. This is not a secret."
  value       = aws_cognito_user_pool_client.review_console.id
}

output "incident_workflow_arn" {
  description = "ARN of the Standard Step Functions incident workflow."
  value       = aws_sfn_state_machine.incident_workflow.arn
}

output "cloudwatch_log_groups" {
  description = "Log groups created with bounded retention."
  value = {
    analysis            = aws_cloudwatch_log_group.incident_analysis.name
    publication         = aws_cloudwatch_log_group.approved_report_publication.name
    api                 = aws_cloudwatch_log_group.api.name
    ingress             = aws_cloudwatch_log_group.ingress.name
    report              = aws_cloudwatch_log_group.incident_report.name
    review_notification = aws_cloudwatch_log_group.incident_review_notification.name
    review_api          = aws_cloudwatch_log_group.incident_review_api.name
    onboarding_start    = aws_cloudwatch_log_group.slack_onboarding_start.name
    onboarding_callback = aws_cloudwatch_log_group.slack_onboarding_callback.name
    collector           = aws_cloudwatch_log_group.slack_evidence_collector.name
    worker              = aws_cloudwatch_log_group.worker.name
    workflow            = aws_cloudwatch_log_group.workflow.name
  }
}
