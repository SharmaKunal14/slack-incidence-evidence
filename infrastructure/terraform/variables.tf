variable "aws_region" {
  description = "AWS region in which to create the serverless foundation."
  type        = string
  default     = "ap-southeast-2"
}

variable "project_name" {
  description = "Short, lowercase name used as the prefix for AWS resources."
  type        = string
  default     = "incident-copilot"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,29}$", var.project_name))
    error_message = "project_name must be 2-30 lowercase alphanumeric or hyphen characters and start with a letter."
  }
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "development"

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production."
  }
}

variable "lambda_artifact_path" {
  description = "Path to one deployment ZIP containing all Lambda composition entrypoints and their production dependencies."
  type        = string
}

variable "ingress_lambda_handler" {
  description = "Handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "slack-ingress-main.handler"
}

variable "worker_lambda_handler" {
  description = "Handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "incident-worker-main.handler"
}

variable "slack_evidence_collector_lambda_handler" {
  description = "Slack evidence collector handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "slack-evidence-collector-main.handler"
}

variable "incident_analysis_lambda_handler" {
  description = "Incident analysis handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "incident-analysis-main.handler"
}

variable "incident_report_lambda_handler" {
  description = "Incident report handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "incident-report-main.handler"
}

variable "incident_review_notification_lambda_handler" {
  description = "Review-ready Slack notification handler exported at the root of the shared Lambda artifact."
  type        = string
  default     = "incident-review-notification-main.handler"
}

variable "lambda_architecture" {
  description = "Lambda CPU architecture. arm64 is cost-efficient for this pure Node.js workload."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "slack_signing_secret_arn" {
  description = "ARN of an existing Secrets Manager secret containing JSON {\"signingSecret\":\"...\"}. Terraform never reads the value."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:", var.slack_signing_secret_arn))
    error_message = "slack_signing_secret_arn must be a Secrets Manager secret ARN."
  }
}

variable "slack_bot_token_secret_arn" {
  description = "ARN of an existing Secrets Manager secret containing JSON {\"workspaceId\":\"T...\",\"botToken\":\"...\"}. Terraform never reads the value."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:", var.slack_bot_token_secret_arn))
    error_message = "slack_bot_token_secret_arn must be a Secrets Manager secret ARN."
  }
}

variable "database_secret_arn" {
  description = "ARN of an existing Secrets Manager secret containing username, password, and the trusted PostgreSQL CA certificate. Terraform never reads the value."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:", var.database_secret_arn))
    error_message = "database_secret_arn must be a Secrets Manager secret ARN."
  }
}

variable "openai_api_secret_arn" {
  description = "ARN of an existing Secrets Manager secret containing JSON {\"apiKey\":\"...\"}. Terraform never reads the value."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:", var.openai_api_secret_arn))
    error_message = "openai_api_secret_arn must be a Secrets Manager secret ARN."
  }
}

variable "openai_model" {
  description = "Explicit OpenAI model or pinned snapshot used for incident extraction. No default is supplied so model changes are reviewed."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$", var.openai_model))
    error_message = "openai_model must be a valid 1-200 character OpenAI model identifier."
  }
}

variable "database_host" {
  description = "PostgreSQL hostname used by the worker, such as a Supabase transaction-pooler endpoint. Supply only a DNS hostname, never a connection URL."
  type        = string

  validation {
    condition = (
      length(trimspace(var.database_host)) > 0 &&
      can(regex("^[A-Za-z0-9.-]+$", var.database_host)) &&
      !startswith(var.database_host, ".") &&
      !endswith(var.database_host, ".")
    )
    error_message = "database_host must contain only a DNS hostname, without a scheme, credentials, port, path, or whitespace."
  }
}

variable "database_port" {
  description = "PostgreSQL port. Supabase transaction-pooler connections use 6543."
  type        = number
  default     = 5432

  validation {
    condition     = var.database_port >= 1 && var.database_port <= 65535
    error_message = "database_port must be between 1 and 65535."
  }
}

variable "database_name" {
  description = "PostgreSQL database name. This is not a credential."
  type        = string
  default     = "incident_copilot"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a valid PostgreSQL identifier no longer than 63 characters."
  }
}

variable "database_pool_max" {
  description = "Maximum PostgreSQL connections held by one warm worker execution environment. Keep deliberately small behind any server-side pooler."
  type        = number
  default     = 2

  validation {
    condition     = var.database_pool_max >= 1 && var.database_pool_max <= 10
    error_message = "database_pool_max must be between 1 and 10."
  }
}

variable "worker_subnet_ids" {
  description = "Optional private subnet IDs for worker VPC attachment. Supply together with worker_security_group_ids; leave empty for a public managed database endpoint."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.worker_subnet_ids) <= 16 && alltrue([for id in var.worker_subnet_ids : can(regex("^subnet-[0-9a-f]+$", id))])
    error_message = "worker_subnet_ids must contain at most 16 valid subnet IDs."
  }
}

variable "worker_security_group_ids" {
  description = "Optional security group IDs for worker VPC attachment. Supply together with worker_subnet_ids and provide controlled database and service egress."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.worker_security_group_ids) <= 5 && alltrue([for id in var.worker_security_group_ids : can(regex("^sg-[0-9a-f]+$", id))])
    error_message = "worker_security_group_ids must contain at most five valid security group IDs."
  }
}

variable "secrets_kms_key_arns" {
  description = "Optional customer-managed KMS key ARNs used by the supplied secrets. Leave empty for the Secrets Manager AWS-managed key."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.secrets_kms_key_arns : can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/", arn))])
    error_message = "Every secrets_kms_key_arns item must be a KMS key ARN (aliases are intentionally not accepted)."
  }
}

variable "log_level" {
  description = "Application log level passed to both functions."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level is not supported by the application logger."
  }
}

variable "log_retention_days" {
  description = "Retention for Lambda, API Gateway, and Step Functions CloudWatch logs."
  type        = number
  default     = 14

  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      var.log_retention_days,
    )
    error_message = "log_retention_days must be a CloudWatch Logs supported retention value."
  }
}

variable "ingress_memory_mb" {
  description = "Memory assigned to the short Slack ingress Lambda."
  type        = number
  default     = 256

  validation {
    condition     = var.ingress_memory_mb >= 128 && var.ingress_memory_mb <= 10240
    error_message = "ingress_memory_mb must be between 128 and 10240 MB."
  }
}

variable "ingress_timeout_seconds" {
  description = "Slack ingress Lambda timeout. API Gateway still enforces the shorter acknowledgement deadline."
  type        = number
  default     = 5

  validation {
    condition     = var.ingress_timeout_seconds >= 1 && var.ingress_timeout_seconds <= 10
    error_message = "ingress_timeout_seconds must be between 1 and 10 seconds."
  }
}

variable "ingress_reserved_concurrency" {
  description = "Hard concurrency and cost boundary for Slack ingress."
  type        = number
  default     = 5

  validation {
    condition     = var.ingress_reserved_concurrency >= 1
    error_message = "ingress_reserved_concurrency must be at least 1."
  }
}

variable "worker_memory_mb" {
  description = "Memory assigned to the incident workflow starter Lambda."
  type        = number
  default     = 512

  validation {
    condition     = var.worker_memory_mb >= 128 && var.worker_memory_mb <= 10240
    error_message = "worker_memory_mb must be between 128 and 10240 MB."
  }
}

variable "worker_timeout_seconds" {
  description = "Incident worker timeout. This function accepts the job and starts orchestration; long stages belong in separate tasks."
  type        = number
  default     = 60

  validation {
    condition     = var.worker_timeout_seconds >= 1 && var.worker_timeout_seconds <= 900
    error_message = "worker_timeout_seconds must be between 1 and 900 seconds."
  }
}

variable "worker_reserved_concurrency" {
  description = "Hard concurrency and downstream database-pressure boundary for the incident worker."
  type        = number
  default     = 2

  validation {
    condition     = var.worker_reserved_concurrency >= 2
    error_message = "worker_reserved_concurrency must be at least 2 because SQS event-source maximum concurrency has an AWS minimum of 2."
  }
}

variable "evidence_collector_memory_mb" {
  description = "Memory assigned to the bounded Slack evidence collector Lambda."
  type        = number
  default     = 512

  validation {
    condition     = var.evidence_collector_memory_mb >= 128 && var.evidence_collector_memory_mb <= 10240
    error_message = "evidence_collector_memory_mb must be between 128 and 10240 MB."
  }
}

variable "evidence_collector_timeout_seconds" {
  description = "Timeout for collecting and persisting one bounded Slack thread page."
  type        = number
  default     = 60

  validation {
    condition     = var.evidence_collector_timeout_seconds >= 10 && var.evidence_collector_timeout_seconds <= 300
    error_message = "evidence_collector_timeout_seconds must be between 10 and 300 seconds."
  }
}

variable "evidence_collector_reserved_concurrency" {
  description = "Hard concurrency boundary protecting Slack and PostgreSQL during evidence collection."
  type        = number
  default     = 2

  validation {
    condition     = var.evidence_collector_reserved_concurrency >= 1
    error_message = "evidence_collector_reserved_concurrency must be at least 1."
  }
}

variable "evidence_retention_days" {
  description = "Days that raw Slack evidence remains eligible for retention before deletion processing."
  type        = number
  default     = 30

  validation {
    condition     = var.evidence_retention_days >= 1 && var.evidence_retention_days <= 365
    error_message = "evidence_retention_days must be between 1 and 365."
  }
}

variable "slack_thread_max_pages" {
  description = "Hard per-incident Slack thread page limit; each page contains at most 15 messages."
  type        = number
  default     = 100

  validation {
    condition     = var.slack_thread_max_pages >= 1 && var.slack_thread_max_pages <= 1000
    error_message = "slack_thread_max_pages must be between 1 and 1000."
  }
}

variable "incident_analysis_memory_mb" {
  description = "Memory assigned to structured incident analysis."
  type        = number
  default     = 512

  validation {
    condition     = var.incident_analysis_memory_mb >= 128 && var.incident_analysis_memory_mb <= 10240
    error_message = "incident_analysis_memory_mb must be between 128 and 10240 MB."
  }
}

variable "incident_analysis_timeout_seconds" {
  description = "End-to-end timeout for one analysis attempt, including durable persistence."
  type        = number
  default     = 120

  validation {
    condition     = var.incident_analysis_timeout_seconds >= 30 && var.incident_analysis_timeout_seconds <= 900
    error_message = "incident_analysis_timeout_seconds must be between 30 and 900 seconds."
  }
}

variable "incident_analysis_reserved_concurrency" {
  description = "Hard concurrency boundary protecting model spend and PostgreSQL."
  type        = number
  default     = 2

  validation {
    condition     = var.incident_analysis_reserved_concurrency >= 1
    error_message = "incident_analysis_reserved_concurrency must be at least 1."
  }
}

variable "analysis_max_artifacts" {
  description = "Maximum evidence artifacts submitted in one analysis run."
  type        = number
  default     = 100

  validation {
    condition     = var.analysis_max_artifacts >= 1 && var.analysis_max_artifacts <= 500
    error_message = "analysis_max_artifacts must be between 1 and 500."
  }
}

variable "analysis_max_input_characters" {
  description = "Maximum serialized evidence-manifest characters submitted in one model request."
  type        = number
  default     = 100000

  validation {
    condition     = var.analysis_max_input_characters >= 1000 && var.analysis_max_input_characters <= 1000000
    error_message = "analysis_max_input_characters must be between 1000 and 1000000."
  }
}

variable "analysis_max_attempts" {
  description = "Maximum leased model attempts after explicit retryable provider outcomes."
  type        = number
  default     = 2

  validation {
    condition     = var.analysis_max_attempts >= 1 && var.analysis_max_attempts <= 5
    error_message = "analysis_max_attempts must be between 1 and 5."
  }
}

variable "analysis_lease_seconds" {
  description = "Database lease preventing concurrent model requests for one analysis version."
  type        = number
  default     = 180

  validation {
    condition     = var.analysis_lease_seconds >= 30 && var.analysis_lease_seconds <= 900
    error_message = "analysis_lease_seconds must be between 30 and 900."
  }
}

variable "openai_timeout_milliseconds" {
  description = "Timeout for one OpenAI Responses API request."
  type        = number
  default     = 90000

  validation {
    condition     = var.openai_timeout_milliseconds >= 1000 && var.openai_timeout_milliseconds <= 300000
    error_message = "openai_timeout_milliseconds must be between 1000 and 300000."
  }
}

variable "openai_max_output_tokens" {
  description = "Hard output-token budget for one structured extraction request."
  type        = number
  default     = 6000

  validation {
    condition     = var.openai_max_output_tokens >= 256 && var.openai_max_output_tokens <= 32768
    error_message = "openai_max_output_tokens must be between 256 and 32768."
  }
}

variable "incident_report_memory_mb" {
  description = "Memory assigned to evidence-constrained incident report generation."
  type        = number
  default     = 512

  validation {
    condition     = var.incident_report_memory_mb >= 128 && var.incident_report_memory_mb <= 10240
    error_message = "incident_report_memory_mb must be between 128 and 10240 MB."
  }
}

variable "incident_report_timeout_seconds" {
  description = "End-to-end timeout for one report-generation attempt, including durable persistence."
  type        = number
  default     = 120

  validation {
    condition     = var.incident_report_timeout_seconds >= 30 && var.incident_report_timeout_seconds <= 900
    error_message = "incident_report_timeout_seconds must be between 30 and 900 seconds."
  }
}

variable "incident_report_reserved_concurrency" {
  description = "Hard concurrency boundary protecting model spend and PostgreSQL during report generation."
  type        = number
  default     = 2

  validation {
    condition     = var.incident_report_reserved_concurrency >= 1
    error_message = "incident_report_reserved_concurrency must be at least 1."
  }
}

variable "report_max_sources" {
  description = "Maximum combined claims and timeline events submitted in one report request."
  type        = number
  default     = 200

  validation {
    condition     = var.report_max_sources >= 1 && var.report_max_sources <= 500
    error_message = "report_max_sources must be between 1 and 500."
  }
}

variable "report_max_input_characters" {
  description = "Maximum serialized structured report-manifest characters submitted in one model request."
  type        = number
  default     = 100000

  validation {
    condition     = var.report_max_input_characters >= 1000 && var.report_max_input_characters <= 1000000
    error_message = "report_max_input_characters must be between 1000 and 1000000."
  }
}

variable "report_max_attempts" {
  description = "Maximum leased report-generation attempts after explicit retryable provider outcomes."
  type        = number
  default     = 2

  validation {
    condition     = var.report_max_attempts >= 1 && var.report_max_attempts <= 5
    error_message = "report_max_attempts must be between 1 and 5."
  }
}

variable "report_lease_seconds" {
  description = "Database lease preventing concurrent model requests for one report version."
  type        = number
  default     = 180

  validation {
    condition     = var.report_lease_seconds >= 30 && var.report_lease_seconds <= 900
    error_message = "report_lease_seconds must be between 30 and 900."
  }
}

variable "openai_report_timeout_milliseconds" {
  description = "Timeout for one OpenAI report-generation request."
  type        = number
  default     = 90000

  validation {
    condition     = var.openai_report_timeout_milliseconds >= 1000 && var.openai_report_timeout_milliseconds <= 300000
    error_message = "openai_report_timeout_milliseconds must be between 1000 and 300000."
  }
}

variable "openai_report_max_output_tokens" {
  description = "Hard output-token budget for one structured report-generation request."
  type        = number
  default     = 8000

  validation {
    condition     = var.openai_report_max_output_tokens >= 256 && var.openai_report_max_output_tokens <= 32768
    error_message = "openai_report_max_output_tokens must be between 256 and 32768."
  }
}

variable "review_notification_memory_mb" {
  description = "Memory assigned to the content-free Slack review-ready notifier."
  type        = number
  default     = 256

  validation {
    condition     = var.review_notification_memory_mb >= 128 && var.review_notification_memory_mb <= 10240
    error_message = "review_notification_memory_mb must be between 128 and 10240 MB."
  }
}

variable "review_notification_timeout_seconds" {
  description = "Timeout for one review-ready Slack status notification."
  type        = number
  default     = 15

  validation {
    condition     = var.review_notification_timeout_seconds >= 5 && var.review_notification_timeout_seconds <= 60
    error_message = "review_notification_timeout_seconds must be between 5 and 60 seconds."
  }
}

variable "review_notification_reserved_concurrency" {
  description = "Hard concurrency boundary protecting Slack and PostgreSQL during completion notification."
  type        = number
  default     = 2

  validation {
    condition     = var.review_notification_reserved_concurrency >= 1
    error_message = "review_notification_reserved_concurrency must be at least 1."
  }
}

variable "queue_visibility_timeout_seconds" {
  description = "Visibility timeout for incident jobs; must be at least six times the worker timeout."
  type        = number
  default     = 360

  validation {
    condition     = var.queue_visibility_timeout_seconds >= 0 && var.queue_visibility_timeout_seconds <= 43200
    error_message = "queue_visibility_timeout_seconds must be between 0 and 43200 seconds."
  }
}

variable "queue_message_retention_seconds" {
  description = "How long unprocessed incident jobs remain on the source queue."
  type        = number
  default     = 345600

  validation {
    condition     = var.queue_message_retention_seconds >= 60 && var.queue_message_retention_seconds <= 1209600
    error_message = "queue_message_retention_seconds must be between 60 seconds and 14 days."
  }
}

variable "dlq_message_retention_seconds" {
  description = "How long failed jobs remain available for investigation and redrive."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_message_retention_seconds >= 60 && var.dlq_message_retention_seconds <= 1209600
    error_message = "dlq_message_retention_seconds must be between 60 seconds and 14 days."
  }
}

variable "queue_max_receive_count" {
  description = "Number of deliveries before a failed incident job moves to the DLQ."
  type        = number
  default     = 5

  validation {
    condition     = var.queue_max_receive_count >= 1 && var.queue_max_receive_count <= 1000
    error_message = "queue_max_receive_count must be between 1 and 1000."
  }
}

variable "api_integration_timeout_milliseconds" {
  description = "API Gateway integration timeout. Keep below Slack's three-second acknowledgement deadline."
  type        = number
  default     = 2900

  validation {
    condition     = var.api_integration_timeout_milliseconds >= 50 && var.api_integration_timeout_milliseconds < 3000
    error_message = "api_integration_timeout_milliseconds must be at least 50 and below 3000."
  }
}

variable "api_throttle_rate_limit" {
  description = "Steady requests per second accepted by the default API Gateway stage."
  type        = number
  default     = 20

  validation {
    condition     = var.api_throttle_rate_limit > 0
    error_message = "api_throttle_rate_limit must be greater than zero."
  }
}

variable "api_throttle_burst_limit" {
  description = "Short request burst accepted by the default API Gateway stage."
  type        = number
  default     = 40

  validation {
    condition     = var.api_throttle_burst_limit >= 0
    error_message = "api_throttle_burst_limit cannot be negative."
  }
}

variable "oldest_job_alarm_threshold_seconds" {
  description = "Maximum acceptable age of the oldest queued incident job."
  type        = number
  default     = 300

  validation {
    condition     = var.oldest_job_alarm_threshold_seconds >= 60
    error_message = "oldest_job_alarm_threshold_seconds must be at least one minute."
  }
}

variable "alarm_action_arns" {
  description = "Optional SNS topic ARNs invoked when operational alarms enter ALARM state."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.alarm_action_arns : can(regex("^arn:[^:]+:sns:[^:]+:[0-9]{12}:", arn))])
    error_message = "Every alarm_action_arns item must be an SNS topic ARN."
  }
}

variable "additional_tags" {
  description = "Additional tags applied to all taggable resources."
  type        = map(string)
  default     = {}
}
