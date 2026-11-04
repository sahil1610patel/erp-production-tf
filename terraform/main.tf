terraform {
  required_version = ">= 1.8, < 2.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.100" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Configure an encrypted/versioned S3 backend before production use; see README.
  # Backend infrastructure must exist independently of this stack.
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = var.project_name, Environment = var.environment, ManagedBy = "Terraform" }
  }
}

provider "aws" {
  alias  = "global"
  region = "us-east-1"
  default_tags { tags = { Project = var.project_name, Environment = var.environment, ManagedBy = "Terraform" } }
}

data "aws_availability_zones" "available" { state = "available" }
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name   = "${var.project_name}-${var.environment}"
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)
  az_map = { for i, az in local.azs : tostring(i) => az }
}

locals {
  # No master-secret permission remains on instances in steady-state mode.
  database_secret_arns = var.bootstrap_database ? [aws_db_instance.erp.master_user_secret[0].secret_arn] : compact([var.runtime_db_secret_arn])
  database_secret_arn  = var.bootstrap_database ? aws_db_instance.erp.master_user_secret[0].secret_arn : coalesce(var.runtime_db_secret_arn, "runtime-secret-not-yet-configured")
  secret_kms_keys      = compact([var.app_secret_kms_key_arn, var.runtime_db_secret_kms_key_arn])
}
