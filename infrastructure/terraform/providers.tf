provider "aws" {
  region = var.aws_region

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
