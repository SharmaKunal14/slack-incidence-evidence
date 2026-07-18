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

output "incident_workflow_arn" {
  description = "ARN of the Standard Step Functions incident workflow."
  value       = aws_sfn_state_machine.incident_workflow.arn
}

output "cloudwatch_log_groups" {
  description = "Log groups created with bounded retention."
  value = {
    analysis            = aws_cloudwatch_log_group.incident_analysis.name
    api                 = aws_cloudwatch_log_group.api.name
    ingress             = aws_cloudwatch_log_group.ingress.name
    report              = aws_cloudwatch_log_group.incident_report.name
    review_notification = aws_cloudwatch_log_group.incident_review_notification.name
    collector           = aws_cloudwatch_log_group.slack_evidence_collector.name
    worker              = aws_cloudwatch_log_group.worker.name
    workflow            = aws_cloudwatch_log_group.workflow.name
  }
}
