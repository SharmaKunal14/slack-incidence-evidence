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

output "incident_workflow_arn" {
  description = "ARN of the Standard Step Functions incident workflow."
  value       = aws_sfn_state_machine.incident_workflow.arn
}

output "cloudwatch_log_groups" {
  description = "Log groups created with bounded retention."
  value = {
    api       = aws_cloudwatch_log_group.api.name
    ingress   = aws_cloudwatch_log_group.ingress.name
    collector = aws_cloudwatch_log_group.slack_evidence_collector.name
    worker    = aws_cloudwatch_log_group.worker.name
    workflow  = aws_cloudwatch_log_group.workflow.name
  }
}
