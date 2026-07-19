provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_aws_account_id]

  default_tags {
    tags = merge(
      {
        Application = var.project_name
        Environment = var.environment
        ManagedBy   = "Terraform"
      },
      var.additional_tags,
    )
  }
}
